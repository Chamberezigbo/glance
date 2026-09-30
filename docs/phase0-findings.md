# Phase 0 findings

Measured 2026-09-30 on the target machine. Numbers here are first-hand, not estimates.

## The machine

| | |
|---|---|
| Model | MacBookPro14,1 (2017) |
| CPU | Intel Core i5-7360U @ 2.3 GHz — 2 physical cores, 4 threads, x86_64 |
| RAM | 16 GB |
| GPU | Intel Iris Plus 640, 1536 MB dynamic VRAM, Metal 3 |
| macOS | 13.7.8 (22H730) |
| Disk | 746 GB free of 932 GB |

**Two displays, and the external one is primary.**

| `-D` index | Display | Capture size |
|---|---|---|
| 1 | DELL E2311H (**main display**) | 1920 × 1080 |
| 2 | Built-in Retina LCD | 2880 × 1800 |

This is not in PLAN.md and it matters: `screencapture` with no `-D` does not
mean "the screen the user is looking at." Display choice has to be explicit,
and the built-in panel is 2.5x the pixels — and therefore 2.5x the image
tokens — of the external one.

**The machine is under real pressure at idle.** Load average 2.50 / 5.17 / 5.77
on 2 physical cores. 3.8 GB of 5.1 GB swap in use, ~12 MB of RAM free, 8 days
of uptime. Any benchmark taken here is a floor, not a typical result.

## Toolchain

Present: `node` v22.23.2, `npm` 10.9.8, `ffmpeg` 9.0.1, `sips`, `screencapture`,
`say`, `osascript`, `python3` 3.14.7, `brew` 7.0.7, `cmake` 4.4.3,
`clang` 14.0.3, `swift` 5.8.1, `make`, `git`, `curl`.

Missing: `jq`, `sox`. Neither is required — `ffmpeg` covers silence detection
and Node covers JSON.

Everything whisper.cpp needs in order to build from source is already here.

## Permissions

- **Screen Recording — granted.** Both displays captured successfully.
- **Microphone — granted.** `ffmpeg -f avfoundation -i ":1"` recorded fine.
- **Input Monitoring — untested.** Needed only at Phase 3.

Audio inputs: `:0` iPhone Microphone (Continuity), `:1` Built-in Microphone
(the default). The index is not stable across sessions — an iPhone appearing or
leaving renumbers the list, so the device must be resolved by *name* at runtime,
never hardcoded as `:1`.

## Capture and downscale are not a bottleneck

| Step | Time |
|---|---|
| `screencapture -x -t jpg -D 1` | 0.17 s |
| `sips -Z 1024` | 0.46 s → 49 KB |
| `ffmpeg -vf scale=1024:-1` | **0.11 s → 20 KB** |

**Use ffmpeg, not sips.** 4x faster and 2.5x smaller output at identical
dimensions (1024 × 576).

## 0.1 — Headless Claude Code: PASSES, with a caveat that reshapes the plan

A standalone CLI already exists on this machine and did not need installing:

```
~/.vscode/extensions/anthropic.claude-code-2.1.285-darwin-x64/resources/native-binary/claude
```

232 MB Mach-O x86_64, executable, reports `2.1.285 (Claude Code)`. PLAN.md's
assumption that only the extension bundle exists is out of date.

**The kill criterion is cleared on all three counts:**

- `claude -p` returns text. ✅
- It reads an image from a path and describes it correctly — it identified the
  frontmost app from a screenshot. ✅
- It authenticates on the **subscription**, not an API key. ✅ No
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_BASE_URL` is set,
  and the call still succeeded. `~/.claude.json` shows
  `billingType: stripe_subscription`, `organizationType: claude_pro`.

### The caveat: the harness overhead, not the image, is the cost

PLAN.md budgets **~2,500 tokens** and an implied second or two per round trip.
Both are wrong, by a lot, because `claude -p` boots a whole coding agent —
system prompt, tool schemas, skill listings, settings, MCP config — before it
ever looks at the picture.

One trivial question about one 1024 × 576 screenshot, measured:

| Invocation | Wall time | Total tokens | Turns |
|---|---|---|---|
| Default (`claude -p`, Opus) | 30.4 s | **167,148** | 5 |
| Lean (haiku, no settings, no MCP, `--max-turns 3`) | 8.0 s | **58,920** | 2 |
| PLAN.md's estimate | — | 2,500 | — |

The lean flags are worth a lot — **3.8x faster, 2.8x fewer tokens** — and are
what the subscription path should always use:

```
--model claude-haiku-4-5-20251001
--allowedTools Read
--strict-mcp-config --mcp-config '{"mcpServers":{}}'
--setting-sources ""
--max-turns 3
```

But ~50k tokens is the **floor**, because the agent preamble is irreducible.
That is ~24x the plan's estimate, and it inverts the token-budget table:

| | PLAN.md said | Actually measured (lean) |
|---|---|---|
| One round trip | ~2,500 | ~59,000 |
| 50 triggers in a day | ~125,000 | **~2,950,000** |

50 triggers a day will not sit comfortably inside a Pro usage window. The
conclusion in PLAN.md — "trigger-based use sits comfortably inside them" — was
reasoned from the image cost alone and does not survive measurement.

Latency is the other half of the problem. 8 seconds is the best case on the
subscription path, and that is before recording and transcribing speech. The
plan's feel target ("beyond 3 seconds the tool feels broken") cannot be met
this way.

### Why this makes the dual-auth decision the right one

A direct Messages API call carries none of that preamble: one image plus one
question is roughly 1,200 tokens and one round trip. That is the cost model
PLAN.md actually assumed — it is just not what `claude -p` does.

So the two paths are not interchangeable conveniences. They have different
performance envelopes and should be chosen deliberately:

| | Subscription (`claude -p`) | API key (Messages API) |
|---|---|---|
| Marginal money cost | none | ~$0.003 / glance |
| Tokens per glance | ~59,000 | ~1,200 |
| Latency | ~8 s best case | ~2–3 s projected |
| Consumes | Pro/Max usage window | pay-as-you-go balance |
| Best for | idle-heavy, occasional use | burst mode, follow-ups, snappy feel |

Phase 5 burst mode is only affordable on the API path. Nothing changes that.

## 0.2 — whisper.cpp: PASSES

Built from source at commit `6e4ab85` (ggml 0.25.1), CPU-only, **Accelerate BLAS**
backend. Homebrew was the wrong route: `whisper.cpp` 1.9.4 has **no bottle** for
Ventura x86_64 and pulls in `ggml`, `llama.cpp` and `sdl2-compat`, all from
source. A direct cmake build is self-contained and much lighter.

Models are from Hugging Face, per the plan's note about GitHub Releases being
unusably slow on this network: `ggml-base.en.bin` (141 MB) and
`ggml-tiny.en.bin` (74 MB).

**Benchmarked under load** — load average 6.27 on 2 cores, 4.3 GB of 5.1 GB
swap in use, Chrome + VS Code + Spotify running. These are worst-case floors,
not typical results.

| Model | Audio | Best of 3 | Realtime factor |
|---|---|---|---|
| `base.en` | 4.5 s | **2.47 s** | 1.8x |
| `base.en` | 13.9 s | 3.45 s | 4.0x |
| `tiny.en` | 4.5 s | **1.30 s** | 3.5x |
| `tiny.en` | 13.9 s | 2.09 s | 6.6x |

**The target is met.** PLAN.md asked for a 5-second clip in under 3 seconds;
`base.en` does it in 2.47 s on a machine that is thrashing. Voice input stays
in the design.

### Cold start is the real problem, not throughput

The first `base.en` run took **7.44 s** for the same 4.5 s clip — 3x the warm
number — because it paged 141 MB off disk with only 793 MB of RAM free. That
single measurement would have failed the kill criterion and killed voice input
for the wrong reason.

Mitigation: keep the model resident. **Done in Phase 3** — `whisper-server`
runs on demand and is started while the user is still speaking, so the load
overlaps with recording. Measured at **~1.7 s**, better than even a warm CLI
spawn (2.45 s) and far better than a cold one (7.44 s). `whisper-cli` stays as
the fallback.

### tiny.en is a serious candidate, not just a fallback

On this sample both models produced **identical, perfect transcription**, and
`tiny.en` is 2x faster and half the memory — which matters more than speed on a
machine this swap-constrained. PLAN.md treats macOS dictation as the fallback;
`tiny.en` is a better one and costs nothing to keep around.

Worth testing on real mic audio before choosing. TTS-generated speech is clean
and easy; a real microphone in a real room is the case that separates them.

## Voice output: resolved, and better than expected

`Ava (Premium)` (en_US) and `Daniel (Enhanced)` (en_GB) downloaded and both
register with `say`. My earlier reading was wrong: Premium voices **are**
available and reachable from the CLI on macOS 13. Both were judged good.

Measured speaking rate on a realistic 27-word answer:

| Voice | Duration |
|---|---|
| Ava (Premium) | 8.82 s |
| Daniel (Enhanced) | 8.55 s |
| Samantha (old built-in) | 7.92 s |

**~2.9-3.1 words per second for flowing prose.** This is a hard design
constraint, not a style note:
every 3 words of answer costs the user a second of standing there listening. A
60-word answer takes 20 seconds to say. The system prompt needs a word cap, and
it is probably the most important line in it.

## Revised after Phase 1 was actually built

The 8.0 s figure below came from a minimal probe ("name the frontmost app in
under 10 words", 290 output tokens). With the real system prompt and a real
question, two live runs measured **16.1 s and 18.1 s** for the model step, at
59,539 and 60,176 tokens.

The token count held almost exactly. The **latency roughly doubled**, because
the answer is longer (437 and 1,031 output tokens against 290) and the machine
is under load. So the realistic subscription-path figure is **~16-18 s**, not
8 s, and the end-to-end total below should be read as **~32 s**, not 24 s.

That widens the gap between the two auth paths rather than narrowing it, and
makes the word cap matter more: output length is now the main thing under our
control on the slow path.

### Comma-separated lists are the slowest thing you can say

Measured after Phase 2, on `Ava (Premium)`:

| Style | Words | Spoken | Rate |
|---|---|---|---|
| Prose | 25 | 8.7 s | **2.9 words/sec** |
| Comma-separated list | 23 | 12.1 s | **1.9 words/sec** |

The synthesiser pauses at every comma, so an enumeration costs ~50% more time
per word than ordinary prose. A word cap alone therefore does **not** bound how
long an answer takes to say — the first live voice run produced a 23-word answer
that took 13.7 s aloud, nearly double what the cap implied.

The system prompt now forbids reading out lists explicitly, rather than only
asking for brevity.

## Measured end-to-end budget

Subscription path, all figures first-hand except where marked:

| Step | Time |
|---|---|
| User speaks | ~4.5 s |
| Transcribe (`base.en`, warm) | 2.5 s |
| `screencapture` | 0.2 s |
| Downscale (ffmpeg) | 0.1 s |
| `claude -p` (lean flags) | 8.0 s |
| Speak a 27-word answer | 8.8 s |
| **Total, keypress to silence** | **~24 s** |

On the API-key path the model step drops to a projected 2–3 s, taking the total
to ~18 s and making **speech, not the model, the bottleneck**. That is the
clearest argument for the dual-provider design: the two paths do not just
differ in billing, they change which part of the system is worth optimising.

## What these findings change

1. **Dual auth is architectural, not a convenience.** The provider must be an
   interface with two implementations, chosen by config, because the two differ
   ~50x in token cost and ~3x in latency.
2. **Display selection must be explicit**, and should default to the main
   display rather than to display 1 by accident.
3. **Resolve the mic by name, not by index.**
4. **Use ffmpeg for downscaling**, not sips.
5. **Re-do the token budget table in PLAN.md** from measurement.
6. **Phase 1 should print timing and token counts** on every run. The plan's
   economics were wrong by 24x on estimate alone; the tool should never let
   that go unmeasured again.
7. **Keep whisper resident** via `whisper-server`, never spawn `whisper-cli`
   per glance. Cold start is 3x warm and would make the first glance after
   boot feel broken.
8. **Cap answer length in words, in the system prompt.** At 3.1 words/second,
   brevity is the single biggest lever on how the tool feels.
9. **Both Phase 0 kill criteria are cleared.** Nothing in the plan's design
   needs to be abandoned — but the token budget and the latency expectations
   both need rewriting from measurement.
