import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, basename } from "node:path";
import { findClaudeCli } from "../config.js";
import { systemPrompt } from "../prompt.js";
import { sessionDir } from "../capture.js";
import type { GlanceRequest, GlanceResult, Provider, TokenUsage } from "./types.js";

const run = promisify(execFile);

/**
 * The subscription path: shell out to headless Claude Code.
 *
 * Costs no money and needs no API key, but boots a full coding agent before it
 * looks at the image. The flags below are not tuning, they are what makes the
 * path usable: without them the same question measured 167,148 tokens and 30.4s
 * on Opus across 5 turns, versus 58,920 tokens and 8.0s with them.
 */
export class SubscriptionProvider implements Provider {
  readonly name = "subscription" as const;
  constructor(readonly model: string, private readonly bin: string) {}

  static create(model: string): SubscriptionProvider {
    const bin = findClaudeCli();
    if (!bin) {
      throw new Error(
        "No Claude Code CLI found. Install it with `npm i -g @anthropic-ai/claude-code`,\n" +
          "or set GLANCE_CLAUDE_BIN to its path, or set ANTHROPIC_API_KEY to use the API instead.",
      );
    }
    return new SubscriptionProvider(model, bin);
  }

  async ask(req: GlanceRequest): Promise<GlanceResult> {
    const resuming = req.resume?.kind === "claude-session" ? req.resume.id : null;

    // Run in the session directory so Claude Code keys one history for all
    // glances, and refer to the image by bare filename so the Read tool
    // resolves it without a broader permission scope.
    const cwd = req.imagePath ? dirname(req.imagePath) : sessionDir();

    const prompt = resuming
      // The image is already in this conversation. Saying so explicitly stops
      // the model reaching for the Read tool again, which would cost a turn.
      ? `Still about the same screenshot, which you have already seen — do not read it again.\n\n` +
        `Answer in under ${req.maxWords} words, as plain spoken prose with no lists.\n\n` +
        `The user asks: ${req.question}`
      : `${systemPrompt(req.maxWords)}\n\n` +
        `Read the image file ${basename(req.imagePath!)} in the current directory. That image is the user's screen.\n\n` +
        `The user asks: ${req.question}`;

    const t0 = performance.now();
    const { stdout } = await run(
      this.bin,
      [
        "-p", prompt,
        ...(resuming ? ["--resume", resuming] : []),
        "--model", this.model,
        "--allowedTools", "Read",
        "--permission-mode", "acceptEdits",
        // Strip everything that inflates the preamble.
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "",
        "--max-turns", "3",
        "--output-format", "json",
      ],
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        // Make sure a stray key in the environment can't silently move billing
        // to pay-as-you-go when the user explicitly asked for the subscription.
        env: { ...process.env, ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv,
      },
    );
    const ms = performance.now() - t0;

    const parsed = JSON.parse(stdout);
    if (parsed.is_error) {
      throw new Error(`claude -p failed: ${parsed.result ?? "unknown error"}`);
    }

    const u = parsed.usage ?? {};
    const usage: TokenUsage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      total: 0,
    };
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;

    return {
      answer: String(parsed.result ?? "").trim(),
      provider: this.name,
      model: this.model,
      ms,
      usage,
      // Reported by the CLI, but it is subscription usage, not a bill.
      costUsd: undefined,
      session: parsed.session_id
        ? { kind: "claude-session", id: String(parsed.session_id) }
        : undefined,
    };
  }
}
