import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ProviderName } from "./providers/types.js";

export interface Config {
  /** Which model path to use. "auto" resolves to api when a key is present. */
  provider: ProviderName;
  /** How the provider was chosen, for the --verbose line. */
  providerReason: string;
  model: string;
  /**
   * Which screen to capture: an explicit `screencapture -D` index, "main" (the
   * one with the menu bar), or "cursor" (the one the mouse is on).
   *
   * "cursor" is the default because it is the only one that answers "the screen
   * I am looking at". On a two-monitor desk the main display is frequently not
   * the one in front of you.
   */
  display: number | "main" | "cursor";
  /** Longest edge of the downscaled screenshot, in pixels. */
  width: number;
  /** Hard cap on spoken answer length. */
  maxWords: number;
  /** say -v voice name, or null to stay silent (Phase 1 default). */
  voice: string | null;
  verbose: boolean;
}

/** Where a subscription-path CLI might be, in order of preference. */
export function findClaudeCli(): string | null {
  const explicit = process.env.GLANCE_CLAUDE_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  // A standalone install on PATH is the normal case.
  for (const p of [
    join(homedir(), ".claude/local/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ]) {
    if (existsSync(p)) return p;
  }

  // The VSCode extension ships a full CLI. On the target machine this is the
  // only copy present, so it is a real fallback rather than a curiosity.
  const extRoot = join(homedir(), ".vscode/extensions");
  if (existsSync(extRoot)) {
    const dirs = readdirSync(extRoot)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const bin = join(extRoot, d, "resources/native-binary/claude");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const DEFAULT_MODEL = {
  // Haiku on the subscription path is not a downgrade for this task, it is what
  // makes the path usable at all: 8s versus 30s, and 59k tokens versus 167k.
  subscription: "claude-haiku-4-5-20251001",
  api: "claude-haiku-4-5-20251001",
} as const;

export function resolveConfig(overrides: Partial<Config> = {}): Config {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const requested = (overrides.provider ??
    process.env.GLANCE_PROVIDER ??
    "auto") as ProviderName | "auto";

  let provider: ProviderName;
  let providerReason: string;

  if (requested === "api") {
    provider = "api";
    providerReason = "requested explicitly";
  } else if (requested === "subscription") {
    provider = "subscription";
    providerReason = "requested explicitly";
  } else if (hasKey) {
    provider = "api";
    providerReason = "ANTHROPIC_API_KEY is set";
  } else {
    provider = "subscription";
    providerReason = "no ANTHROPIC_API_KEY, falling back to the Claude subscription";
  }

  const displayEnv = overrides.display ?? process.env.GLANCE_DISPLAY;
  const display: number | "main" | "cursor" =
    displayEnv === undefined || displayEnv === "cursor"
      ? "cursor"
      : displayEnv === "main"
        ? "main"
        : Number(displayEnv);

  return {
    provider,
    providerReason,
    model: overrides.model ?? process.env.GLANCE_MODEL ?? DEFAULT_MODEL[provider],
    display,
    width: overrides.width ?? Number(process.env.GLANCE_WIDTH ?? 1024),
    maxWords: overrides.maxWords ?? Number(process.env.GLANCE_MAX_WORDS ?? 45),
    voice: overrides.voice ?? process.env.GLANCE_VOICE ?? null,
    verbose: overrides.verbose ?? process.env.GLANCE_VERBOSE === "1",
  };
}
