/**
 * The two ways glance can reach a model.
 *
 * These are not interchangeable conveniences. Measured on the target machine
 * (see docs/phase0-findings.md), one glance costs ~59,000 tokens and 8s on the
 * subscription path versus ~1,200 tokens and ~2-3s on the API path, because
 * `claude -p` boots a whole coding agent before it looks at the image.
 *
 * So the choice is a real engineering decision per use case, which is why it
 * lives behind an interface rather than being compiled in.
 */
export type ProviderName = "subscription" | "api";

export interface GlanceRequest {
  /** What the user asked. */
  question: string;
  /**
   * Absolute path to the already-downscaled screenshot.
   *
   * Omitted on a follow-up: the image is already in the conversation, and
   * re-sending it would defeat the point.
   */
  imagePath?: string;
  /** Hard cap on answer length. At ~2.5 words/sec spoken, this is a time budget. */
  maxWords: number;
  /** Continue an existing conversation rather than starting one. */
  resume?: SessionRef;
}

export type SessionRef =
  | { kind: "claude-session"; id: string }
  | { kind: "messages"; messages: unknown[] };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Everything the request actually consumed, which is what a usage window counts. */
  total: number;
}

export interface GlanceResult {
  answer: string;
  provider: ProviderName;
  model: string;
  /** Wall-clock milliseconds for the model step alone. */
  ms: number;
  usage: TokenUsage;
  /** Only the API path has a meaningful marginal cost. */
  costUsd?: number;
  /** Pass to a later request to continue this conversation. */
  session?: SessionRef;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  ask(req: GlanceRequest): Promise<GlanceResult>;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}
