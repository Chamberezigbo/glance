import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderName } from "./providers/types.js";

/**
 * A conversation about one screenshot.
 *
 * Follow-ups are the common case — "what about the button on the left?" — and
 * re-capturing for each one is wrong twice over: it costs a fresh round trip
 * (measured 58,847 tokens and 12.2s against 30,319 and 4.4s for a resume), and
 * the screen may have changed underneath the question.
 */
export interface Session {
  provider: ProviderName;
  model: string;
  /** Opaque, provider-specific handle. */
  ref: SessionRef;
  /** When the screenshot this conversation is about was taken. */
  capturedAt: number;
  /** When the last answer finished. */
  lastAnswerAt: number;
  turns: number;
}

export type SessionRef =
  | { kind: "claude-session"; id: string }
  | { kind: "messages"; messages: unknown[] };

function path(): string {
  return join(homedir(), ".glance", "session", "conversation.json");
}

/**
 * How long a screenshot stays worth talking about.
 *
 * Past this, the screen has probably moved on and answering from a stale frame
 * is worse than capturing again — the answer would be confident and wrong.
 */
export const STALE_AFTER_MS = Number(process.env.GLANCE_SESSION_TTL_MS ?? 5 * 60 * 1000);

/** How soon after an answer the hotkey treats the next press as a follow-up. */
export const FOLLOW_WINDOW_MS = Number(process.env.GLANCE_FOLLOW_MS ?? 45 * 1000);

export function load(): Session | null {
  try {
    return JSON.parse(readFileSync(path(), "utf8")) as Session;
  } catch {
    return null;
  }
}

export function save(s: Session): void {
  try {
    mkdirSync(join(homedir(), ".glance", "session"), { recursive: true });
    writeFileSync(path(), JSON.stringify(s, null, 2));
  } catch {
    // A lost session only costs one extra capture.
  }
}

export function clear(): void {
  rmSync(path(), { force: true });
}

/** Can this session still be continued? */
export function isUsable(s: Session | null, cfg: { provider: ProviderName; model: string }): s is Session {
  if (!s) return false;
  if (s.provider !== cfg.provider || s.model !== cfg.model) return false;
  return Date.now() - s.capturedAt < STALE_AFTER_MS;
}

/** Was the last answer recent enough that the hotkey should assume a follow-up? */
export function inFollowWindow(s: Session | null): boolean {
  return Boolean(s) && Date.now() - s!.lastAnswerAt < FOLLOW_WINDOW_MS;
}
