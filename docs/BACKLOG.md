# glance — backlog

Everything deferred, in one place, so nothing lives only in a chat log.

Last updated 2026-09-30. Detail lives in [PLAN.md](PLAN.md) and
[phase0-findings.md](phase0-findings.md); this file is the index and the reason
each item is waiting.

**Built so far:** Phases 0-4. Typed and spoken questions, screen capture on the
monitor the mouse is on, spoken answers, two global hotkeys, a menu-bar daemon
that starts at login, a resident whisper server, follow-up questions that reuse
the last screenshot, and a spoken greeting at login and unlock.

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

### Phase 5 — Burst mode

"Watch me for the next three minutes." Time-boxed, compares frames locally with
a perceptual hash, sends to the model only on real change.

**Note:** affordable only on the API path. At ~59,000 tokens per glance the
subscription path cannot support it, and no amount of hashing changes that.

---

### Task checklists — what was left out

- **Voice control of steps.** Saying "next" or "done" instead of pressing ⌥N.
  Needs the wake-word work in Phase 7, or a listening window after each step.
- **Per-step screenshots.** Re-capturing between steps so glance can confirm a
  step actually worked. Costs a capture and a round trip each time, and the
  staleness problem from Phase 4 returns with it.
- **Editing steps.** Reordering, skipping, or adding your own.

## Known rough edges

Small, real, and worth fixing before anyone else uses this.

**Fixed:** failures used to reach only the log file, so the icon returned to
idle in silence and a broken glance was indistinguishable from an ignored one —
which is how fifteen consecutive failures went unnoticed during the permission
work. Errors now appear in the panel in red, beep, and are spoken in plain
language when the question was asked out loud.

| Issue | Effect |
|---|---|
| Hotkey path only speaks the answer | Text goes to `glance.log`; nothing to re-read or copy |
| Word cap is advisory | The model runs over it; truncating would cut mid-sentence, so it warns instead |
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

## Distribution — what shipping to other people actually requires

Measured 2026-09-30. Signing is the cheap part; the dependencies are the problem.

### 1. Code signing and notarization — $99/year

| | |
|---|---|
| Apple Developer Program | **$99/year** |
| Developer ID certificate | included |
| Notarization | included, but requires the **hardened runtime** |

Without it Gatekeeper blocks the app outright. For something asking to record
your screen and listen to your microphone, a "this app cannot be opened"
warning on first run is fatal — that is precisely the moment a student decides
whether to trust it.

**It is not only about warnings.** macOS binds Screen Recording and Microphone
grants to the code signature. Ad-hoc signing changes identity on every build, so
**every update silently revokes both permissions** and the user has to re-grant
them by hand. A stable Developer ID is what makes updates survivable. We hit
this locally and worked around it with a self-signed certificate
(`npm run setup:cert`), which fixes one machine and nothing else.

Note: the hardened runtime also means **every nested binary must be signed** —
`ffmpeg`, `whisper-cli`, `whisper-server`, and the Node runtime. Not just the
app.

### 2. Size — what a user does not already have

| Component | Size |
|---|---|
| Node runtime | ~110 MB (single binary; 567 MB as an nvm install) |
| whisper models | **221 MB** |
| whisper binaries | 7 MB |
| ffmpeg | bundled, see licence below |
| glance itself | ~100 KB |

Roughly **350 MB+** before the model path. Mitigation: ship the app small and
download models on first run, which is also what makes `tiny.en` (74 MB) worth
settling.

### 3. The Claude CLI dependency is the real cliff

glance shells out to `claude -p`. A user must have Claude Code **installed and
logged in** before glance does anything at all. That is a 221 MB download and an
OAuth flow standing between "downloaded glance" and "asked a question".

This is the weakest point in the whole product, and it lands directly on the
$1/month premise — the pitch is "you already pay for Claude", but the install
still assumes a developer tool the target audience has never heard of.

Two ways out, neither free:

- **Ship the API path instead.** One key, no CLI, no 221 MB. But then the user
  pays per glance and the "they already pay for Claude" story disappears.
- **Bundle or automate the CLI install.** Bigger download, and it inherits the
  open licensing question above.

### 4. ffmpeg is GPL as installed

The local build reports `--enable-gpl`. Redistributing that binary would impose
GPL terms on the combined work. Fixable, but deliberately: ship an
LGPL-configured ffmpeg build, or drop ffmpeg for capture and use AVFoundation
directly from the Swift app, which removes the dependency altogether.

### 5. The Mac App Store is probably not an option

Sandboxing blocks the global hotkey and the subprocess model that glance is
built on. Direct download (signed `.dmg`) or a Homebrew cask are the realistic
channels.

### Recommended shape, when the time comes

1. Signed, notarized `.dmg`, direct download
2. Models fetched on first run, not bundled
3. ffmpeg replaced by native AVFoundation capture — removes the licence problem
   and a dependency at once
4. API key as the default path, subscription as the advanced option — inverting
   today's default, because it removes the 221 MB prerequisite

## Housekeeping

- **The repo has no commits.** Three phases and five fixed bugs of untracked work.
- `~/.claude/projects` is **367 MB**, mostly real Claude Code history rather than
  glance's. Not investigated; nothing deleted.
