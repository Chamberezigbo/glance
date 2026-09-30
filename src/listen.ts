import { spawn, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = join(fileURLToPath(import.meta.url), "../..");

export interface ListenResult {
  text: string;
  /** True when a resident whisper-server handled it, rather than a cold CLI spawn. */
  warm: boolean;
  /** Seconds of audio actually recorded. */
  audioSec: number;
  recordMs: number;
  transcribeMs: number;
  model: string;
}

/**
 * Resolve the microphone by NAME, not index.
 *
 * avfoundation numbers audio devices in enumeration order, so an iPhone
 * arriving or leaving via Continuity renumbers everything. On the target
 * machine the built-in mic is ":1" only while an iPhone happens to be paired —
 * hardcoding that would break the moment the phone walks away.
 */
export async function findMic(preferred?: string): Promise<{ index: number; name: string }> {
  let stderr = "";
  try {
    await run("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  } catch (e) {
    // ffmpeg always exits non-zero for a device listing; the list is on stderr.
    stderr = String((e as { stderr?: string }).stderr ?? "");
  }

  const devices: { index: number; name: string }[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices/.test(line)) { inAudio = true; continue; }
    if (/AVFoundation video devices/.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: Number(m[1]), name: m[2]! });
  }

  if (devices.length === 0) {
    throw new Error("No microphone found. Check System Settings > Privacy & Security > Microphone.");
  }
  const want = preferred ?? process.env.GLANCE_MIC ?? "Built-in Microphone";
  return devices.find((d) => d.name === want)
    ?? devices.find((d) => d.name.toLowerCase().includes(want.toLowerCase()))
    ?? devices[0]!;
}

export interface RecordOptions {
  outPath: string;
  /** Stop after this much silence, in seconds. */
  silenceSec?: number;
  /** dBFS below which counts as silence. */
  noiseDb?: number;
  /** Hard ceiling so a stuck recorder cannot run forever. */
  maxSec?: number;
  onStart?: (deviceName: string) => void;
}

/**
 * Record until the speaker stops talking.
 *
 * ffmpeg's silencedetect filter reports silence on stderr but will not stop on
 * its own, so we watch the stream and close it ourselves. We only act on
 * silence that follows actual speech — otherwise the pause before someone
 * starts talking ends the recording immediately.
 */
export async function record(opts: RecordOptions): Promise<number> {
  const { outPath } = opts;
  const silenceSec = opts.silenceSec ?? 1.2;
  const noiseDb = opts.noiseDb ?? -35;
  const maxSec = opts.maxSec ?? 30;

  const mic = await findMic();
  opts.onStart?.(mic.name);

  return new Promise<number>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-nostdin", "-hide_banner",
      "-f", "avfoundation", "-i", `:${mic.index}`,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-af", `silencedetect=noise=${noiseDb}dB:d=${silenceSec}`,
      "-t", String(maxSec),
      "-y", outPath,
    ]);

    let heardSpeech = false;
    let duration = 0;
    let settled = false;
    let errText = "";

    const stop = () => {
      if (settled) return;
      settled = true;
      // 'q' lets ffmpeg finalise the WAV header; SIGKILL would corrupt it.
      ff.stdin.write("q");
      setTimeout(() => ff.kill("SIGTERM"), 500);
    };

    ff.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      errText += text;
      // Running time, so we know how long we actually captured.
      const t = text.match(/time=(\d+):(\d+):([\d.]+)/);
      if (t) duration = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      // silence_end means speech resumed: they are definitely talking.
      if (/silence_end/.test(text)) heardSpeech = true;
      const s = text.match(/silence_start:\s*([\d.]+)/);
      if (s) {
        const at = Number(s[1]);
        // Silence starting after t=0 implies sound preceded it.
        if (at > 0.3) heardSpeech = true;
        if (heardSpeech) stop();
      }
    });

    ff.on("error", reject);
    ff.on("close", () => {
      if (!existsSync(outPath) || duration === 0) {
        // Surface what ffmpeg actually said. The usual cause is that the
        // process has no Microphone permission — which is granted per
        // *application*, so a launchd agent does not inherit the grant the
        // terminal has.
        const detail = errText.split("\n").filter((l) =>
          /error|denied|permission|Input\/output|Unknown input/i.test(l)).slice(-3).join("; ");
        return reject(new Error(
          `Recording produced no audio.${detail ? ` ffmpeg said: ${detail}` : ""}\n` +
          `If glance was launched by the hotkey, grant Microphone access to it in\n` +
          `System Settings > Privacy & Security > Microphone.`));
      }
      resolve(duration);
    });
  });
}

/** Port for the resident whisper server. Non-default to avoid colliding with 8080. */
const WHISPER_PORT = Number(process.env.GLANCE_WHISPER_PORT ?? 8178);

async function serverUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(400),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Start whisper-server in the background if it is not already up.
 *
 * This exists because spawning whisper-cli per question pays a 7.4s cold start
 * against 2.5s warm — it pages 141 MB off disk every time. Keeping the model
 * resident is the difference between the first glance after boot feeling broken
 * and feeling instant.
 *
 * Detached, so it survives this process and stays warm for the next question.
 */
export async function ensureServer(model: "base" | "tiny" = "base"): Promise<boolean> {
  if (await serverUp(WHISPER_PORT)) return true;

  const { bin, model: modelPath } = whisperPaths(model);
  const serverBin = bin.replace(/whisper-cli$/, "whisper-server");
  if (!existsSync(serverBin) || !existsSync(modelPath)) return false;

  const child = spawn(serverBin, [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(WHISPER_PORT),
    "-t", "4",
    "-nt",
  ], { detached: true, stdio: "ignore" });
  child.unref();

  // Loading 141 MB takes a moment; poll rather than guess.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await serverUp(WHISPER_PORT)) return true;
  }
  return false;
}

async function transcribeViaServer(wavPath: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "q.wav");
    form.append("response_format", "text");
    const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return (await res.text()).trim().replace(/\s+/g, " ");
  } catch {
    return null;
  }
}

function whisperPaths(model: "base" | "tiny") {
  return {
    bin: join(repoRoot, "vendor/whisper.cpp/build/bin/whisper-cli"),
    model: join(repoRoot, `models/ggml-${model}.en.bin`),
  };
}

/**
 * Transcribe a 16 kHz mono WAV.
 *
 * Note this spawns whisper-cli per call, which pays the cold-start cost — 7.4s
 * against 2.5s warm on the target machine, because it pages 141 MB off disk.
 * Phase 3 should move to the whisper-server binary already built alongside this
 * one and keep the model resident.
 */
export async function transcribe(
  wavPath: string,
  model: "base" | "tiny" = "base",
): Promise<{ text: string; ms: number; warm: boolean }> {
  // Warm path first: a resident server skips the 141 MB model load entirely.
  if (process.env.GLANCE_WHISPER_SERVER !== "0") {
    const t = performance.now();
    const viaServer = await transcribeViaServer(wavPath);
    if (viaServer !== null) return { text: viaServer, ms: performance.now() - t, warm: true };
  }

  const { bin, model: modelPath } = whisperPaths(model);
  if (!existsSync(bin)) throw new Error("whisper-cli is not built. Run `npm run setup:whisper`.");
  if (!existsSync(modelPath)) throw new Error(`Missing ${modelPath}. Run: npm run setup:models`);

  const t0 = performance.now();
  const { stdout } = await run(bin, [
    "-m", modelPath,
    "-f", wavPath,
    "-t", "4",
    "-nt",  // no timestamps
    "-np",  // no progress spam
  ], { maxBuffer: 4 * 1024 * 1024 });
  return { text: stdout.trim().replace(/\s+/g, " "), ms: performance.now() - t0, warm: false };
}

export async function listen(opts: {
  dir: string;
  model?: "base" | "tiny";
  onStart?: (device: string) => void;
  onRecorded?: (sec: number) => void;
}): Promise<ListenResult> {
  const wav = join(opts.dir, "question.wav");

  // Warm the model while the user is still talking — by the time they stop,
  // the server is up and transcription is immediate. Free latency.
  const model = opts.model ?? "base";
  const warming = ensureServer(model).catch(() => false);

  const t0 = performance.now();
  const audioSec = await record({ outPath: wav, onStart: opts.onStart });
  const recordMs = performance.now() - t0;
  opts.onRecorded?.(audioSec);

  await warming;
  const { text, ms, warm } = await transcribe(wav, model);
  return { text, warm, audioSec, recordMs, transcribeMs: ms, model: `${model}.en` };
}
