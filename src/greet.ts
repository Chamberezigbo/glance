import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { speak } from "./speak.js";

const run = promisify(execFile);

/**
 * What to call the user.
 *
 * Order: GLANCE_NAME, then ~/.glance/config.json, then the account's full name.
 * The config file matters because the greeting runs under launchd, which does
 * not see the shell environment — an exported variable would simply be ignored.
 *
 * The account name is only a last resort: what macOS has on file is often not
 * what someone wants to be called out loud. An empty value drops the name
 * entirely, which reads better than using the wrong one.
 */
export async function preferredName(): Promise<string> {
  const override = process.env.GLANCE_NAME;
  if (override !== undefined) return override.trim();

  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".glance", "config.json"), "utf8"));
    if (typeof cfg.name === "string") return cfg.name.trim();
  } catch {
    // No config yet.
  }

  try {
    const { stdout } = await run("id", ["-F"]);
    return (stdout.trim().split(/\s+/)[0] ?? "").trim();
  } catch {
    return "";
  }
}

type Slot = "morning" | "afternoon" | "evening" | "night";

function slotFor(hour: number): Slot {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

/**
 * Greetings are varied deliberately. A machine that says exactly the same
 * sentence every single day stops registering as a greeting within a week.
 */
const LINES: Record<Slot, string[]> = {
  morning: [
    "Good morning{name}. I'm here whenever you need a look at something.",
    "Morning{name}. Press option space and I'll take a look at your screen.",
    "Good morning{name}. Hope today goes well.",
  ],
  afternoon: [
    "Good afternoon{name}. I'm here if you get stuck.",
    "Afternoon{name}. Give me a shout if something on screen needs explaining.",
    "Welcome back{name}.",
  ],
  evening: [
    "Good evening{name}. I'm here if you need me.",
    "Evening{name}. Still here whenever you want a second pair of eyes.",
    "Welcome back{name}. Hope the evening is going well.",
  ],
  night: [
    "You're up late{name}. I'm here if you need me.",
    "Late one{name}. Shout if something needs a look.",
    "Still going{name}? I'm around.",
  ],
};

export async function greetingText(now = new Date()): Promise<string> {
  const name = await preferredName();
  const lines = LINES[slotFor(now.getHours())];
  const pick = lines[Math.floor(Math.random() * lines.length)]!;
  return pick.replace("{name}", name ? `, ${name}` : "");
}

function stampPath(): string {
  return join(homedir(), ".glance", "last-greeting");
}

/**
 * Don't greet twice in quick succession.
 *
 * The daemon restarts on every rebuild and on some unlock events, and being
 * greeted three times in a minute is worse than not being greeted at all.
 */
function greetedRecently(withinMs: number): boolean {
  try {
    const last = Number(readFileSync(stampPath(), "utf8").trim());
    return Number.isFinite(last) && Date.now() - last < withinMs;
  } catch {
    return false;
  }
}

function markGreeted(): void {
  try {
    mkdirSync(join(homedir(), ".glance"), { recursive: true });
    writeFileSync(stampPath(), String(Date.now()));
  } catch {
    // Non-fatal.
  }
}

export async function greet(opts: { force?: boolean; quietForMs?: number } = {}): Promise<boolean> {
  if (process.env.GLANCE_GREETING === "0") return false;
  const quietFor = opts.quietForMs ?? 5 * 60 * 1000;
  if (!opts.force && greetedRecently(quietFor)) return false;

  const text = await greetingText();
  markGreeted();
  await speak(text);
  return true;
}
