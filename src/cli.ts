#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type Config } from "./config.js";
import { capture, sessionDir } from "./capture.js";
import { createProvider } from "./providers/index.js";
import { doctor } from "./doctor.js";
import { speak, bestVoice } from "./speak.js";
import { listen, setState, calibrate } from "./listen.js";
import { greet, greetingText } from "./greet.js";

const USAGE = `
glance — ask a question about what is on your screen

  glance "what is this error telling me?"     ask by typing
  glance --listen                             ask out loud, answer out loud
  glance --listen --no-speak                  ask out loud, answer as text
  glance doctor                               check this machine is set up
  glance calibrate                            measure your room, so it stops
                                              cutting you off mid-sentence
  glance greet --force                        hear the login greeting now

Environment
  GLANCE_NAME="Chamberlain"   what to call you (empty string = no name)
  GLANCE_GREETING=0           turn the login greeting off

Options
  --provider <subscription|api>  which model path to use (default: api if
                                 ANTHROPIC_API_KEY is set, else subscription)
  --model <id>                   override the model
  --display <n|main|cursor>      which screen to capture (default: cursor —
                                 the monitor your mouse is on)
  --width <px>                   downscale width (default: 1024)
  --max-words <n>                cap the answer (default: 45, ~15s spoken)
  --listen                       record the question from the mic instead of
                                 typing it; stops when you stop talking
  --whisper <base|tiny>          transcription model (default: base, more
                                 accurate; tiny is ~2x faster)
  --speak                        read the answer aloud with \`say\`
  --no-speak                     with --listen, print instead of speaking
  --voice <name>                 voice for --speak (default: best installed)
  --verbose                      print timing and token counts
  --keep                         keep the screenshot and print its path
`;

interface Args {
  question: string;
  cfg: Partial<Config>;
  speak: boolean;
  keep: boolean;
  listen: boolean;
  whisper: "base" | "tiny";
}

function parseArgs(argv: string[]): Args {
  const cfg: Partial<Config> = {};
  const words: string[] = [];
  let doSpeak = false;
  let noSpeak = false;
  let keep = false;
  let doListen = false;
  let whisper: "base" | "tiny" = "base";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--provider": cfg.provider = next() as Config["provider"]; break;
      case "--model": cfg.model = next(); break;
      case "--display": {
        const v = next();
        cfg.display = v === "main" || v === "cursor" ? v : Number(v);
        break;
      }
      case "--width": cfg.width = Number(next()); break;
      case "--max-words": cfg.maxWords = Number(next()); break;
      case "--voice": cfg.voice = next(); doSpeak = true; break;
      case "--speak": doSpeak = true; break;
      case "--no-speak": noSpeak = true; break;
      case "--listen": case "-l": doListen = true; break;
      case "--whisper": whisper = next() as "base" | "tiny"; break;
      case "--verbose": case "-v": cfg.verbose = true; break;
      case "--keep": keep = true; break;
      default:
        if (a && !a.startsWith("--")) words.push(a);
    }
  }
  // Asking out loud implies wanting the answer out loud — it is a conversation,
  // not a dictation box. --no-speak opts back out.
  const speak = noSpeak ? false : doSpeak || doListen;
  return { question: words.join(" "), cfg, speak, keep, listen: doListen, whisper };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "doctor") return doctor();
  if (argv[0] === "greet") {
    const force = argv.includes("--force");
    const spoken = await greet({ force });
    if (!spoken) console.error("(skipped — greeted recently, or GLANCE_GREETING=0)");
    return 0;
  }
  if (argv[0] === "greeting") {
    // Print without speaking, for checking the wording.
    console.log(await greetingText());
    return 0;
  }
  if (argv[0] === "calibrate") {
    console.log("Measuring your room for 4 seconds — stay quiet...");
    const c = await calibrate();
    console.log(`\n  ambient noise   ${c.ambientDb.toFixed(1)} dB`);
    console.log(`  silence cutoff  ${c.noiseDb.toFixed(1)} dB`);
    console.log("\nSaved. glance will use this when deciding you have stopped talking.");
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || (argv.length === 0 && !process.env.GLANCE_LISTEN)) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  const { question: typed, cfg: overrides, speak: doSpeak, keep, listen: doListen, whisper } = parseArgs(argv);
  if (!typed && !doListen) {
    console.error("glance: no question given.\n" + USAGE);
    return 1;
  }

  const cfg = resolveConfig(overrides);
  // Stable, so Claude Code keeps one session history instead of one per glance.
  const dir = sessionDir();
  const t0 = performance.now();
  let heard: Awaited<ReturnType<typeof listen>> | null = null;

  try {
    let question = typed;
    if (!doListen) setState("thinking");
    if (doListen) {
      heard = await listen({
        dir,
        model: whisper,
        onStart: (device) => console.error(`listening on ${device} — speak, then pause...`),
      });
      question = heard.text;
      if (!question) {
        console.error("glance: heard nothing. Try again, or type the question instead.");
        return 1;
      }
      console.error(`heard: "${question}"\n`);
    }

    const provider = createProvider(cfg);
    if (cfg.verbose) {
      console.error(`glance: ${cfg.provider} (${cfg.providerReason}), model ${cfg.model}`);
    }

    const shot = await capture({ display: cfg.display, width: cfg.width, dir });
    const result = await provider.ask({
      question,
      imagePath: shot.path,
      maxWords: cfg.maxWords,
    });

    console.log(result.answer);

    let speakMs = 0;
    if (doSpeak) {
      setState("speaking");
      const s0 = performance.now();
      await speak(result.answer, cfg.voice ?? (await bestVoice()));
      speakMs = performance.now() - s0;
    }

    // The word cap is a time budget, so a breach is worth seeing rather than
    // silently tolerating. Truncating the answer would cut it mid-sentence,
    // which is worse than being a few words long.
    const words = result.answer.split(/\s+/).filter(Boolean).length;
    if (cfg.verbose && words > cfg.maxWords) {
      console.error(`\n  note: answer ran ${words} words against a ${cfg.maxWords} cap (~${((words - cfg.maxWords) / 3.1).toFixed(1)}s over)`);
    }

    if (cfg.verbose) {
      const total = performance.now() - t0;
      console.error(
        (heard
          ? `\n  recorded  ${heard.audioSec.toFixed(1)}s of audio` +
            `\n  heard     ${(heard.transcribeMs / 1000).toFixed(1)}s  (whisper ${heard.model}, ${heard.warm ? "resident" : "cold spawn"})`
          : "") +
        `\n  capture   ${shot.captureMs.toFixed(0)}ms  (display ${shot.display}, ${shot.width}x${shot.height}, ${(shot.bytes / 1024).toFixed(0)}KB)` +
        `\n  scale     ${shot.scaleMs.toFixed(0)}ms` +
        `\n  model     ${(result.ms / 1000).toFixed(1)}s  ${result.usage.total.toLocaleString()} tokens` +
        ` (in ${result.usage.input}, out ${result.usage.output}, cache r${result.usage.cacheRead}/w${result.usage.cacheCreation})` +
        (result.costUsd !== undefined ? `  $${result.costUsd.toFixed(4)}` : "") +
        `\n  answer    ${words} words` +
        (speakMs ? `\n  spoken    ${(speakMs / 1000).toFixed(1)}s` : `\n  spoken    ~${(words / 2.9).toFixed(1)}s if read aloud (prose; lists run ~50% longer)`) +
        `\n  total     ${(total / 1000).toFixed(1)}s`,
      );
    }
    if (keep) console.error(`\nscreenshot: ${shot.path}`);
    return 0;
  } catch (err) {
    console.error(`glance: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    setState("idle");
    // The directory is reused, so only the screenshot is cleared, and only when
    // it was not explicitly kept for inspection.
    if (!keep) rmSync(join(dir, "shot.jpg"), { force: true });
  }
}

main().then((code) => process.exit(code));
