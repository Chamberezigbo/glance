# glance — backlog

Everything deferred, in one place, so nothing lives only in a chat log.

Last updated 2026-09-30. Detail lives in [PLAN.md](PLAN.md) and
[phase0-findings.md](phase0-findings.md); this file is the index and the reason
each item is waiting.

**Built so far:** Phases 0-3. Typed and spoken questions, screen capture on the
monitor the mouse is on, spoken answers, two global hotkeys, a menu-bar daemon
that starts at login, and a resident whisper server.

---

## Blocked on a measurement

Things we cannot decide without a number we do not yet have.

### Point at what to click — Phase 6

Draw an arrow or highlight at the control the user should click. The strongest
idea for the student and founder audience, and it does **not** break the
look-and-advise-only rule: an overlay points, the human clicks.

**Blocked.** Probed 2026-09-30: one of four targets located accurately enough,
errors of 250-330 real pixels on a 3360 px display. Detail and the four things
that would have to change are in PLAN.md, Phase 6.

**Next step:** rerun the same probe at full resolution on a stronger model. That
is one experiment, not a build.

### base.en vs tiny.en

`tiny.en` is 2x faster and half the memory, which matters on a machine that
idles 4 GB into swap. On TTS audio both transcribed identically.

**Blocked** on a test with real microphone audio in a real room — TTS speech is
unrealistically clean, so the current comparison proves nothing about accuracy.

**Next step:** ten real spoken questions through both, compare word error rate.

### The API path has never actually run

Every measurement on this repo is from the subscription path. The API provider
is written, compiles, and errors correctly when no key is present — but has not
transcribed a single real request.

**Blocked** on an `ANTHROPIC_API_KEY`.

**Why it matters:** it is projected at ~1,200 tokens and 2-3 s against a
measured ~59,000 tokens and 16-18 s. If that holds, it changes which half of the
system is worth optimising, and it is the fallback if the licensing question
below resolves badly.

---

## Planned, not started

### Phase 4 — Follow-ups

"What about the button on the left?" should reuse the screenshot already in the
conversation rather than capturing a new one.

**Now much cheaper than planned.** Screenshots moved to a stable
`~/.glance/session`, so Claude Code already keeps one session history instead of
one orphaned project folder per glance. Resuming is close to a flag.

### Phase 5 — Burst mode

"Watch me for the next three minutes." Time-boxed, compares frames locally with
a perceptual hash, sends to the model only on real change.

**Note:** affordable only on the API path. At ~59,000 tokens per glance the
subscription path cannot support it, and no amount of hashing changes that.

---

## Known rough edges

Small, real, and worth fixing before anyone else uses this.

| Issue | Effect |
|---|---|
| Hotkey path only speaks the answer | Text goes to `glance.log`; nothing to re-read or copy |
| Word cap is advisory | The model runs over it; truncating would cut mid-sentence, so it warns instead |
| No error is spoken | If a glance fails, the icon returns to idle in silence — easy to read as "it ignored me" |
| whisper-server is never shut down | Stays resident holding 141 MB until the machine restarts |
| `--keep` semantics | Now that the session directory is stable, the flag only controls whether the raw shot is deleted |

---

## Decisions to make, not code to write

### Is bring-your-own-subscription permitted?

The whole $1/month premise assumes a paid product may drive a user's own Claude
Pro/Max subscription through `claude -p`. A person running a local tool on their
own subscription is one thing; charging for software whose function is to
consume it is another, and it is not obviously fine.

**Needs checking with Anthropic before any payment infrastructure exists.** The
API path is the unambiguous fallback, which is why it stays maintained.

### What does "SaaS" mean here?

If screenshots reach a server, the README's strongest claim — nothing is stored
or streamed anywhere — dies, and with it the reason to trust a tool that can see
your screen. If only accounts, licensing and billing live on a server, the
promise survives completely.

The second is a better product and a far smaller system to run.

### Cross-platform: Windows before Linux

Detail in PLAN.md, *Beyond v1*. The short version: ffmpeg and whisper.cpp
already port unchanged, `screencapture`, `say`, `launchd` and the hotkey do not,
and Wayland's security model exists specifically to prevent what glance does.

### Distribution costs money before it earns any

Apple Developer Program $99/year, Windows code-signing certificate $100-400/year.
Unsigned, Gatekeeper blocks the app outright — fatal for a tool asking for screen
and microphone access. ~40 subscribers at $1/month just to cover certificates.

---

## Housekeeping

- **The repo has no commits.** Three phases and five fixed bugs of untracked work.
- `~/.claude/projects` is **367 MB**, mostly real Claude Code history rather than
  glance's. Not investigated; nothing deleted.
