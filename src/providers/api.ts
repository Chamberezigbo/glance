import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { systemPrompt, userPrompt } from "../prompt.js";
import { REQUEST_TIMEOUT_MS } from "../net.js";
import type { GlanceRequest, GlanceResult, Provider, TokenUsage } from "./types.js";

/**
 * The API path: one Messages call, one image, one answer.
 *
 * Carries none of the agent preamble, which is the whole point — roughly 1,200
 * tokens against ~59,000, and a couple of seconds against eight. Costs money per
 * glance, but does not touch the subscription's usage window.
 */
export class ApiProvider implements Provider {
  readonly name = "api" as const;
  constructor(readonly model: string, private readonly client: Anthropic) {}

  static create(model: string): ApiProvider {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Export a key, or run with --provider subscription\n" +
          "to use your Claude subscription instead.",
      );
    }
    return new ApiProvider(
      model,
      new Anthropic({
        apiKey,
        timeout: REQUEST_TIMEOUT_MS,
        // Two retries, which the SDK backs off between. Safe here in a way it
        // is not on the subscription path: a retried API call costs a few
        // tenths of a cent, while a retried `claude -p` costs ~59,000 tokens
        // of a usage window.
        maxRetries: 2,
      }),
    );
  }

  async ask(req: GlanceRequest): Promise<GlanceResult> {
    // On a follow-up the image is already in the replayed history, so only the
    // new question is appended. Prompt caching then makes the repeat cheap.
    const prior =
      req.resume?.kind === "messages"
        ? (req.resume.messages as Anthropic.MessageParam[])
        : [];

    let turn: Anthropic.MessageParam;
    if (prior.length > 0) {
      turn = { role: "user", content: userPrompt(req.question) };
    } else {
      if (!req.imagePath) {
        // Text-only is legitimate: `glance apply` with a pasted job posting has
        // nothing to look at.
        turn = { role: "user", content: userPrompt(req.question) };
        const messages0 = [turn];
        const t1 = performance.now();
        const r0 = await this.client.messages.create({
          model: this.model, max_tokens: 4096,
          system: systemPrompt(req.maxWords), messages: messages0,
        });
        const answer0 = r0.content.filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text).join(" ").trim();
        const u0: TokenUsage = {
          input: r0.usage.input_tokens, output: r0.usage.output_tokens,
          cacheRead: r0.usage.cache_read_input_tokens ?? 0,
          cacheCreation: r0.usage.cache_creation_input_tokens ?? 0, total: 0,
        };
        u0.total = u0.input + u0.output + u0.cacheRead + u0.cacheCreation;
        return {
          answer: answer0, provider: this.name, model: this.model,
          ms: performance.now() - t1, usage: u0,
          session: { kind: "messages", messages: [...messages0, { role: "assistant", content: answer0 }] },
        };
      }
      const image = await readFile(req.imagePath);
      turn = {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: image.toString("base64"),
            },
            // Cache the image: it is the expensive part and it never changes
            // within one conversation.
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: userPrompt(req.question) },
        ],
      };
    }

    const messages = [...prior, turn];

    const t0 = performance.now();
    const res = await this.client.messages.create({
      model: this.model,
      // Generous ceiling; the word cap in the prompt is what actually binds.
      max_tokens: 512,
      system: systemPrompt(req.maxWords),
      messages,
    });
    const ms = performance.now() - t0;

    const answer = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    const usage: TokenUsage = {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheCreation: res.usage.cache_creation_input_tokens ?? 0,
      total: 0,
    };
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;

    return {
      answer,
      provider: this.name,
      model: this.model,
      ms,
      usage,
      // Carry the whole exchange forward, so the next question can resume it.
      session: {
        kind: "messages",
        messages: [...messages, { role: "assistant", content: answer }],
      },
    };
  }
}
