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
export function publishAnswer(text: string, meta: { question: string; followUp: boolean }): void {
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
