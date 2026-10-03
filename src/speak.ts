import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConfig } from "./greet.js";

const run = promisify(execFile);

/** Voices worth using, best first. Falls back to whatever is installed. */
const PREFERRED = ["Ava (Premium)", "Zoe (Premium)", "Daniel (Enhanced)", "Samantha", "Alex"];

/**
 * Words per minute.
 *
 * `say` lands near 167 by default, which is faster than relaxed conversation.
 * 150 is roughly how a person explains something to someone sitting beside
 * them, and the difference is immediately audible.
 */
const DEFAULT_RATE = 150;

let cached: string | null | undefined;

/**
 * Premium voices are a manual download (System Settings -> Accessibility ->
 * Spoken Content -> System voice -> Manage Voices), so they cannot be assumed
 * on someone else's machine. Degrade quietly rather than failing.
 */
export async function bestVoice(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await run("say", ["-v", "?"]);
    const installed = stdout.split("\n").map((l) => l.split(/\s{2,}/)[0]?.trim()).filter(Boolean);
    cached = PREFERRED.find((v) => installed.includes(v)) ?? installed[0] ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Every voice available to speak through, for the listening test. */
export async function installedVoices(): Promise<string[]> {
  try {
    const { stdout } = await run("say", ["-v", "?"]);
    return stdout
      .split("\n")
      .map((l) => l.split(/\s{2,}/)[0]?.trim())
      .filter((v): v is string => Boolean(v));
  } catch {
    return [];
  }
}

/**
 * Rewrite an answer so a synthesiser reads it the way a person would say it.
 *
 * This does NOT make speech shorter — measured, it usually makes it slightly
 * longer. "tilde slash dot glance slash config dot j-s-o-n" takes 3.0s and
 * "your glance config file" takes 2.3s, but `checkout.js:6:22` gets *longer*
 * when spoken properly. Length was the wrong target: spelling a path out
 * character by character is correct for an unknown string, it simply does not
 * sound like a person.
 *
 * Only the spoken string is transformed. The panel and the log keep the text
 * verbatim, because the panel is where someone copies a path from.
 */
export function forSpeech(text: string): string {
  let s = text;

  // FIRST, and before any rule that could introduce brackets: `say` executes
  // [[...]] as embedded speech commands. An answer containing [[slnc 9000]]
  // would otherwise pause for nine seconds, or change voice mid-sentence. The
  // model's output is not a trusted source of speech directives.
  s = s.replace(/\[\[/g, "( ").replace(/\]\]/g, " )");

  // Modifier glyphs. These appear constantly in glance's own answers about its
  // own hotkeys, and are read as nothing at all.
  s = s
    .replace(/⌥/g, "Option ")
    .replace(/⇧/g, "Shift ")
    .replace(/⌘/g, "Command ")
    .replace(/⌃/g, "Control ")
    .replace(/⎋/g, "Escape ")
    .replace(/↵|⏎/g, "Return ");

  // A path in the home directory: name it rather than dictate it.
  // Non-greedy on the directories: a greedy [\w./-]* swallows all but the last
  // character of the filename, turning ~/.glance/config.json into "your g file".
  s = s.replace(/~\/(?:[\w.-]+\/)*([\w-]+)\.(\w+)/g, (_m, name: string, ext: string) =>
    `your ${name} file`);
  s = s.replace(/~\/[\w./-]+/g, "your home folder");

  // file.ext:line:col -> the leaf and the line. A column number read aloud has
  // never helped anybody.
  s = s.replace(/\b([\w-]+)\.(\w+):(\d+)(?::\d+)?/g, (_m, name: string, ext: string, line: string) =>
    `${name} dot ${spellExt(ext)}, line ${line}`);

  // A bare path: keep the leaf, drop the directories.
  s = s.replace(/\b(?:[\w-]+\/){1,}([\w-]+)\.(\w+)/g, (_m, name: string, ext: string) =>
    `${name} dot ${spellExt(ext)}`);

  // A lone filename still needs its extension said as letters, not as a word.
  s = s.replace(/\b([\w-]+)\.(js|ts|tsx|jsx|json|md|sh|py|swift|html|css|yml)\b/gi,
    (_m, name: string, ext: string) => `${name} dot ${spellExt(ext)}`);

  // Code punctuation carries no meaning aloud. Full stops and commas stay —
  // they are what drive the prosody.
  s = s
    .replace(/`+/g, " ")
    .replace(/[_*#]+/g, " ")
    .replace(/[(){}<>[\]]/g, " ")
    .replace(/\s*\/\s*/g, " slash ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Sentence breaks. `say` runs sentences together; a short pause is most of
  // what separates "reading a document" from "talking to someone". Never after
  // the final sentence, where it is just dead air before the panel closes.
  s = s.replace(/([.?!])\s+(?=\S)/g, "$1 [[slnc 320]] ");

  return s;
}

/** Extensions are initialisms, not words: "t s", not "ts". */
function spellExt(ext: string): string {
  const spoken: Record<string, string> = {
    js: "J S", ts: "T S", tsx: "T S X", jsx: "J S X",
    json: "Jason", md: "markdown", sh: "shell", py: "python",
    yml: "yaml", html: "H T M L", css: "C S S",
  };
  return spoken[ext.toLowerCase()] ?? ext.toLowerCase();
}

/** Words per minute, from config or the environment. */
export function speechRate(): number {
  const env = Number(process.env.GLANCE_RATE);
  if (Number.isFinite(env) && env > 0) return env;
  const cfg = Number(readConfig().speechRate);
  return Number.isFinite(cfg) && cfg > 0 ? cfg : DEFAULT_RATE;
}

export async function speak(text: string, voice?: string | null, rate?: number): Promise<void> {
  const v = voice ?? (readConfig().voice as string | undefined) ?? (await bestVoice());
  const r = String(rate ?? speechRate());
  const spoken = forSpeech(text);
  await run("say", v ? ["-v", v, "-r", r, spoken] : ["-r", r, spoken]);
}
