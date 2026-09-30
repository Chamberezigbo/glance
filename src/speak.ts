import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Voices worth using, best first. Falls back to whatever is installed. */
const PREFERRED = ["Ava (Premium)", "Zoe (Premium)", "Daniel (Enhanced)", "Samantha", "Alex"];

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

export async function speak(text: string, voice?: string | null): Promise<void> {
  const v = voice ?? (await bestVoice());
  await run("say", v ? ["-v", v, text] : [text]);
}
