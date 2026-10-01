import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./greet.js";

/**
 * How an answer is delivered.
 *
 * Spoken answers are good when your hands are busy and bad when the answer
 * contains a path, a flag or an identifier — and impossible in a meeting. A
 * readable panel covers those cases without giving up the spoken one.
 */
export type AnswerMode = "both" | "voice" | "popup" | "none";

/**
 * Answer in the modality the question arrived in.
 *
 * A typed question means the user is at the keyboard with their eyes on the
 * screen: reading is natural and being spoken at is intrusive. A spoken
 * question means their attention is elsewhere, so speak it — and leave the
 * panel up anyway, because spoken text cannot be re-read.
 *
 * Explicit flags beat the environment, which beats config, which beats this.
 */
export function answerMode(askedByVoice: boolean): AnswerMode {
  const env = process.env.GLANCE_ANSWER_MODE as AnswerMode | undefined;
  const cfg = readConfig().answerMode as AnswerMode | undefined;
  const mode = env ?? cfg ?? (askedByVoice ? "both" : "popup");
  return ["both", "voice", "popup", "none"].includes(mode) ? mode : "both";
}

/**
 * Hand the answer to the menu-bar app, which draws the panel.
 *
 * Written as a file rather than printed, because the hotkey path runs detached
 * with its output redirected to a log — there is no terminal to read.
 */
export function publishAnswer(
  text: string,
  meta: { question: string; followUp: boolean; isError?: boolean },
): void {
  try {
    mkdirSync(join(homedir(), ".glance"), { recursive: true });
    writeFileSync(
      join(homedir(), ".glance", "answer.json"),
      JSON.stringify({ text, ...meta, at: Date.now() }, null, 2),
    );
  } catch {
    // Display is a convenience; never let it break an answer.
  }
}

/**
 * Report a failure the same way an answer is reported.
 *
 * A failure that only writes to a log file is indistinguishable from being
 * ignored: the icon returns to idle and nothing happens. That is how fifteen
 * consecutive failures went unnoticed while a permission was silently denied.
 * Whatever went wrong, the user should be told — and told what to do about it.
 */
export function publishError(message: string, question: string): void {
  publishAnswer(message, { question, followUp: false, isError: true });
}

/**
 * Turn an internal error into something worth reading aloud.
 *
 * The underlying messages already name their fix; this keeps the first sentence
 * short, because that is the part that gets spoken.
 */
export function humanError(err: unknown): { spoken: string; shown: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split("\n")[0] ?? raw;

  if (/Screen Recording/i.test(raw)) {
    return {
      spoken: "I can't see your screen. Screen Recording permission is turned off.",
      shown: raw,
    };
  }
  if (/[Mm]icrophone|No microphone|Recording produced no audio/.test(raw)) {
    return {
      spoken: "I couldn't hear anything. Check the microphone permission.",
      shown: raw,
    };
  }
  if (/whisper|setup:models|setup:whisper/i.test(raw)) {
    return { spoken: "Speech recognition isn't set up yet.", shown: raw };
  }
  if (/ANTHROPIC_API_KEY|claude CLI|Claude Code CLI/i.test(raw)) {
    return { spoken: "I can't reach a model. Check your API key or Claude login.", shown: raw };
  }
  if (/heard nothing|no question/i.test(raw)) {
    return { spoken: "I didn't catch that. Try again.", shown: raw };
  }
  return { spoken: `Something went wrong. ${first}`, shown: raw };
}
