# glance — build plan

Written 2026-09-30. Target machine: MacBookPro14,1 (2017), i5-7360U, 2 cores /
4 threads, 16 GB, macOS 13.7.8.

Deferred work is indexed in [BACKLOG.md](BACKLOG.md). Measurements are in
[phase0-findings.md](phase0-findings.md).

---

## Decisions already settled

These were argued through before the repo existed. Revisit them only with a
reason, not by drift.

| Decision | Choice | Why |
|---|---|---|
| Platform | macOS only **for v1** | It is the machine that exists. **Revised 2026-09-30:** Windows and Linux were a flat non-goal; they are now a possible v2 (see *Beyond v1*). This does not change v1 — building cross-platform now would slow the only version that currently has a user. |
| Trigger | Global hotkey | Always-watching burns ~1M tokens/hour. A hotkey burns zero while idle. |
| Autonomy | Look and advise; act only on request, behind a toggle | Originally "look and advise only". **Revised 2026-10-03:** glance can now open apps, folders, settings and links, send a message, and diagnose an app — from an allowlist, confirmed every time, off by default. It still cannot click or type, which is measured rather than assumed: the Phase 6 probe located 1 of 4 controls accurately with 250-330px errors, so clicking would click the wrong thing. No Accessibility, no Input Monitoring. |
| Brain | `claude -p` headless **or** Messages API | Subscription path needs no API key and no second bill. **Measured 2026-09-30: it also costs ~59k tokens and 8s per glance**, so an `ANTHROPIC_API_KEY` path exists alongside it (~1.2k tokens, ~2-3s). Chosen by config, not compiled in. |
| Speech out | `say` with a Premium voice | Built in, offline, free. `Ava (Premium)` and `Daniel (Enhanced)` are installed and both sound good. **Speaks at ~2.5 words/second** at the shipped 150 wpm — this caps answer length. |
| Speech in | whisper.cpp `base.en` | Local and offline. **Proven 2026-09-30: 2.47s for a 4.5s clip under load.** `tiny.en` is 2x faster and equally accurate so far. |
| Language | TypeScript on Node 22 | Same reasoning as anvil: avoids the PyTorch-on-Intel-Mac dead end. |

---

## Phase 0 — Prove the two risky assumptions — ✅ COMPLETE

Both assumptions held. Full measurements in
[phase0-findings.md](phase0-findings.md); the summary is that neither kill
criterion fired, but the **token budget below was wrong by ~24x** and has been
rewritten from measurement.

### 0.1 — Does headless Claude Code do what we think? — ✅ PASSED

Claude Code is currently installed only as the VSCode extension bundle, not as
a standalone CLI. Install it, then verify three things:

- `npm i -g @anthropic-ai/claude-code`, then `claude -p "hello"` returns text.
- It authenticates on the **subscription**, not an `ANTHROPIC_API_KEY`. Verify
  by confirming no key is set and the call still succeeds.
- It can read an image from a file path: `claude -p "describe /tmp/shot.png"`
  should make it use its Read tool on the image and describe it.

**Kill criterion:** if headless mode cannot read images, the whole design
changes — we would need the Anthropic API directly, which means a second bill
and the project's main premise is gone.

### 0.2 — Can this CPU transcribe speech fast enough? — ✅ PASSED

The 7B LLM benchmark on this machine was a disaster (0.84 t/s). whisper
`base.en` is ~150 MB, a completely different weight class, so it should be
fine — but "should" is exactly what was wrong last time.

- Build or download whisper.cpp (prefer a Hugging Face or direct release
  tarball; GitHub Releases downloads at ~16 KB/s on this network).
- Benchmark `base.en` on a 5-second and a 15-second voice clip.
- **Target:** a 5-second clip transcribed in under 3 seconds. Beyond that the
  tool feels broken.
- Check `uptime` and close Chrome before benchmarking. This machine idles with
  ~2 GB already swapped and a loaded benchmark once read 3.8x too low.

**Fallback if too slow:** macOS built-in dictation, or type the question
instead of speaking it. Voice input is the most droppable feature here —
voice *output* is what makes it feel like an assistant.

Results are in [phase0-findings.md](phase0-findings.md).

---

## Phase 1 — The dumb loop — ✅ COMPLETE

No voice. No hotkey. No daemon. Just prove the spine works end to end.

A CLI: `glance "what is this error telling me?"`

1. `screencapture -x -t jpg /tmp/glance/shot.jpg` (`-x` = no shutter sound)
2. Downscale to 1024px wide with `sips` or `ffmpeg` (ffmpeg is already installed)
3. `claude -p` with a system prompt and the image path
4. Print the answer as text

**Done when:** you can point it at a real error on screen and get a useful
answer. If the answers are bad here, no amount of voice polish saves it.

The system prompt is real work, not a detail. It has to say: you are looking
at one still frame of someone's screen, you cannot act, be brief because this
will be read aloud, and say plainly when you cannot see enough to tell.

---

## Phase 2 — Voice — ✅ COMPLETE

Split in two, in this order.

**2a — Speech out.** Pipe the answer to `say`. Immediately makes it feel like
a different product. Needs answers kept short — spoken text has no skim.

**2b — Speech in.** Record from the mic, stop on silence, transcribe with
whatever Phase 0 proved out.

**Done when:** you can speak a question and hear an answer, still launched
manually from a terminal. ✅ `glance --listen` does this. Verified end to end:
4.2 s recorded, stopped on silence, transcribed in 2.3 s, answered and spoken.

Two things learned here:

- **Capture follows the mouse, not the menu bar.** `--display` defaults to
  `cursor`, resolved by a small Swift helper against `CGGetActiveDisplayList`,
  because on a two-monitor desk the main display is usually not the one you are
  looking at.
- **The word cap does not bound speaking time.** Comma-separated lists speak at
  1.4 words/sec against 2.5 for prose, so the prompt now forbids enumerations
  outright.

---

## Phase 3 — Hotkey and daemon — ✅ COMPLETE

- Global hotkey capture (`node-global-key-listener`, or a small Swift menu-bar
  shim if that proves unreliable on macOS 13).
- A `launchd` LaunchAgent so it starts at login and sits idle.
- Some visible state — menu bar icon or a sound — so you always know whether
  it is listening. **An assistant that might be listening and might not is
  worse than one that clearly isn't.**

**Done when:** it survives a reboot and responds to the hotkey without a
terminal open. ✅ Installed as `com.glance.agent`, running under launchd with
PPID 1.

### The permissions question is settled, and the answer is better than hoped

The open question was whether a hotkey library would work on macOS 13 without
Accessibility. It does not need one: **Carbon's `RegisterEventHotKey` registers
⌥Space with no privacy permission at all** — no Accessibility, no Input
Monitoring, no prompt.

That matters beyond convenience. `CGEventTap` and
`NSEvent.addGlobalMonitorForEvents` observe *every* keystroke, which is why they
need Input Monitoring. `RegisterEventHotKey` asks the window server to deliver
one specific chord and nothing else. So glance holds **only Screen Recording and
Microphone** — it has no way to read what you type or control the machine, even
if it were compromised. The "it cannot control your machine" claim is now
enforced by the permission set, not just by our choosing not to write the code.

### Visible state

A menu-bar item, per the plan's requirement that you always know whether it is
listening:

| Icon | Meaning |
|---|---|
| `eye` | idle — mic closed, nothing captured |
| `waveform` | listening — recording your question |
| `ellipsis.circle` | thinking — capture sent, waiting on the model |

A second press while busy beeps rather than starting a second run, so it cannot
talk over itself.

### Greeting on login and unlock

A spoken welcome when you log in or unlock the screen, varied by time of day and
using a name from `~/.glance/config.json`.

Two details worth keeping:

- **It listens for `com.apple.screenIsUnlocked`**, a distributed notification,
  which needs no permission — the same reasoning that chose
  `RegisterEventHotKey` over an event tap. glance still observes nothing.
- **The name comes from config, not the OS.** The account's full name is often
  not what someone wants said aloud, and the greeting runs under launchd, which
  never sees the shell environment — so an exported variable would be silently
  ignored.

It will not greet twice within five minutes, so rebuilds and quick
lock-unlock cycles stay quiet. `GLANCE_GREETING=0` disables it.

### Whisper is now resident

`whisper-server` starts on demand and stays warm, which removes the cold-start
cliff identified in Phase 0:

| Path | 4.5 s clip |
|---|---|
| Cold `whisper-cli` spawn | 7.44 s |
| Warm `whisper-cli` spawn | 2.45 s |
| **Resident `whisper-server`** | **~1.7 s** |

The server is started *while the user is still speaking*, so the load overlaps
with recording and costs nothing. `whisper-cli` remains the fallback if the
server cannot start.

---

## Phase 4 — Follow-ups — ✅ COMPLETE

Most questions are follow-ups: "what about the button on the left?" These
must reuse the screenshot already in the conversation instead of capturing a
new one. Use Claude Code's session resume; prompt caching makes the repeat
cheap.

**Done when:** a three-question exchange about one screen takes one capture,
not three. ✅

Measured on the subscription path:

| | Tokens | Time | Captured |
|---|---|---|---|
| First question | 59,584 | 18.5 s | yes |
| **Follow-up** | **30,896** | **12.3 s** | **no** |

About half the tokens and a third less time, and the answer was demonstrably
about the *original* screenshot — asked what was on the far left, it described
the Explorer sidebar from the earlier frame.

### How a follow-up is chosen

- `--follow` / `-f` from the terminal.
- From the hotkey, pressing ⌥Space within 45 s of an answer continues the
  conversation. No second chord to learn, and the menu-bar icon fills in
  (`eye.fill`) while that window is open so it is visible rather than guessed at.
- `--new`, or **New conversation** in the menu, forces a fresh capture.

### Staleness is the thing worth getting right

A conversation expires **5 minutes** after its screenshot was taken. Past that,
`--follow` refuses and captures again.

This matters more than the token saving. An answer drawn from a screen the user
has already navigated away from is not a slightly stale answer — it is a
confident, fluent, wrong one, and nothing in the output would hint at it. Better
to spend a capture.

The session also invalidates if the provider or model changes, since neither
handle can be replayed against the other.

---

## Phase 5 — Burst mode

"Watch me for the next three minutes."

- Time-boxed, ends itself. No mode that can run all day.
- Grabs a frame every second **locally** and compares it to the previous one
  with a perceptual hash. That comparison never leaves the machine and costs
  zero tokens.
- Sends to Claude only when the screen genuinely changed.

This is the closest thing to the original "always watching" idea that is
actually affordable. The threshold needs tuning to ignore blinking cursors and
the menu bar clock — fiddly, but getting it wrong costs CPU, never tokens.

---

## Token budget

**Rewritten 2026-09-30 from measurement.** The original estimate counted only
the image and was wrong by ~24x, because `claude -p` boots a whole coding agent
— system prompt, tool schemas, skill listings, settings, MCP — before it looks
at the picture. That preamble, not the screenshot, is the cost.

An image itself costs roughly `(width x height) / 750` tokens, so a 1024x576
screenshot is only ~790 tokens. Everything else is harness.

| | Subscription (`claude -p`, lean flags) | API key (Messages API) |
|---|---|---|
| One round trip | **~59,000 measured** | ~1,200 projected |
| Latency | **8.0 s measured** | ~2-3 s projected |
| 50 triggers in a day | **~2,950,000** | ~60,000 |
| Marginal money cost | none | ~$0.003 / glance |

The lean flags are not optional on the subscription path — without them the
same question cost **167,148 tokens and 30.4 s** on Opus with 5 turns:

```
--model claude-haiku-4-5-20251001
--allowedTools Read
--strict-mcp-config --mcp-config '{"mcpServers":{}}'
--setting-sources ""
--max-turns 3
```

~50k tokens is the floor on that path; the preamble is irreducible.

**This changes the original conclusion.** "Trigger-based use sits comfortably
inside the usage windows" was reasoned from the image cost alone and does not
survive measurement — 50 triggers a day will not sit comfortably inside a Pro
window. Heavy days, follow-ups and Phase 5 burst mode belong on the API path.
The constraint is still the usage window rather than money, but it binds much
sooner than assumed.

## Permissions this will need

All granted once, in System Settings → Privacy & Security:

- **Screen Recording** — for `screencapture`
- **Microphone** — for voice input
- **Input Monitoring** — for the global hotkey

Accessibility is deliberately *not* needed, because the tool never clicks or
types. That is a feature: it cannot control the machine even if it wanted to.

---

## Non-goals

These are non-goals **for v1**. The first two are revisited in *Beyond v1*.

- Windows or Linux support
- Clicking, typing, or any screen control
- Storing or indexing screen history
- Any cloud service beyond the Claude Code call itself
- Sharing code with `anvil`

---

## Open questions

- Does the hotkey library work reliably on macOS 13 without Accessibility?
  May force the Swift shim earlier than Phase 3.
- Is one still frame enough context, or do useful answers need 2-3 frames
  (before/after a click)? Phase 1 will show this.
- ~~`say` voices are dated. Is the built-in Siri voice reachable from the
  CLI?~~ **Resolved 2026-09-30.** Siri voices are not the answer, but Premium
  ones are: `Ava (Premium)` and `Daniel (Enhanced)` are installed, reachable
  from `say -v`, and both sound good. No extra latency — synthesis is local.
- Is `tiny.en` good enough to replace `base.en`? It is 2x faster and half the
  memory, which matters on a machine this swap-constrained, and so far it
  transcribes identically. Needs testing on real mic audio, not TTS.
- How is the display chosen when two are connected? The external DELL is the
  main display here, so `screencapture` with no `-D` is not "the screen the
  user is looking at".

## Phase 6 (proposed) — Point at what to click

**Idea:** for students and founders learning their way through a task, do not
just say "open the Run menu" — draw an arrow or highlight on the actual screen,
in real time, at the thing to click.

**This does not break the "look and advise only" rule.** An overlay points; the
human still clicks. glance still cannot touch anything, and a transparent
click-through window needs **no new permission**, so the guarantee that it
cannot control the machine survives intact. That is what makes the feature
attractive rather than alarming.

### Probed 2026-09-30 — the coordinates are not accurate enough yet

The whole feature rests on one thing: can the model say *where* a control is,
precisely enough to point at it? An arrow on the wrong button is worse than no
arrow, because it misleads the exact person who cannot yet tell it is wrong.

Tested as a Phase-0-style probe: one 1024x640 screenshot, `haiku-4-5` asked for
centre coordinates of four visible controls, each prediction then verified by
cropping the image at that point.

| Target | Error in the 1024px image | Verdict |
|---|---|---|
| Outline sidebar | ~20 px | usable |
| "Type a question" menu item | ~80 px | landed in empty menu space |
| "Auto" button | ~80 px | pointed left of the control |
| "Quit glance" | wrong region entirely | unusable |

**One of four.** And those errors are in the downscaled image — on the 3360 px
display they scale to roughly **250-330 real pixels**, several controls wide.

**Kill criterion, not met.** Do not build the overlay on top of this.

### What would have to change first

In rough order of cost:

1. **Stop downscaling for this path.** 1024 px wide throws away the precision
   the task needs. Full resolution costs ~4x the image tokens, which matters far
   more on the subscription path than the API one.
2. **Try a stronger model.** Haiku was chosen for latency, not for spatial
   grounding. This probe should be repeated on a larger model before concluding
   anything about the ceiling.
3. **Ask for a region, not a point.** "The button is in the lower-right of the
   editor" drawn as a soft highlight degrades honestly when the model is
   uncertain; a precise arrow does not.
4. **Two-step zoom.** Ask which quadrant, crop to it, ask again. More round
   trips, but each one sees more detail per pixel.

The accessibility API would give exact element bounds, and is deliberately **not
on this list** — it needs the Accessibility permission, which is the one thing
this design has never asked for. Trading that away for a pointer would cost more
than the feature is worth.

### If it does work

Only then is the overlay worth building, and it is the easy half: a borderless,
transparent, click-through `NSWindow` at screen level, drawing a pulsing ring
that fades after a few seconds. No permission, no interaction, disappears on its
own.

## Answer panel — built

A small panel of text next to the cursor, so an answer can be read instead of
only heard.

**This is Phase 6's easy half.** The pointer idea failed because the model could
not locate controls accurately — 250-330 real pixels of error. The cursor's
position needs no model at all, so the same window machinery works with none of
the guesswork, and still no new permission: it is an ordinary window we draw,
not a screen overlay.

Details that matter:

- **Non-activating**, so it never steals focus from the window the question was
  about.
- **Selectable text**, so a path or flag can be copied out — exactly the case
  where a spoken answer is useless.
- **Lingers by length**, roughly 200 words per minute with a four-second floor,
  so a three-word answer does not vanish before it is noticed.

### Answers match the modality of the question

A typed question gets the panel only. A spoken question gets both.

Someone typing is at the keyboard with their eyes on the screen: reading is
natural and being spoken at is intrusive. Someone speaking has their attention
elsewhere — so speak it, and leave the panel up anyway, because spoken text
cannot be re-read.

`--speak` / `--no-speak` override it per run; `answerMode` in
`~/.glance/config.json` overrides it permanently (`both`, `voice`, `popup`,
`none`).

## Icon

An eye whose iris is a screen.

An eye on its own is generic — every monitoring tool uses one, and it reads as
surveillance, which is the opposite of what glance does. Putting a display
inside the pupil says what it actually looks at, and a single open eye says it
looks once rather than watching continuously.

**It is drawn in code** (`native/icon/make-icon.swift`), not exported from a
design tool, because **each size needs its own artwork**:

- **Below 48px** the outlined eye and its iris merge into an unreadable blob —
  there are not enough pixels to hold the gap open. Small sizes draw a *solid*
  eye with the screen knocked out of it instead.
- **64px and up** use the lighter outline, with a glint punched out of the
  screen that doubles as a pupil highlight and a display reflection.

Both holes are even-odd fills rather than cleared regions: clearing punches
through to transparency, which is invisible against a light background. That
bug made the pupil vanish entirely at small sizes until it was caught by
blowing the 16px render up and actually looking at it.

This is not only decoration. glance previously appeared **anonymous in the
Screen Recording permission list**, and an unnamed, unillustrated app asking to
watch your screen is exactly what a cautious person should refuse.

Rebuild with `npm run setup:icon`; `build-app.sh` installs it automatically.

## Task checklists — built

Some answers are a job to carry out, not a thing to understand. As prose they
are spoken once and gone, leaving the user to hold six ordered actions in their
head while doing them.

**Zero extra tokens.** The steps come back in the same response as the answer,
via an output contract: prose first, then a `###STEPS###` marker and the list.
Decomposing in a second call would have cost another ~59,000 tokens on the
subscription path. Measured: a task-producing question cost 60,718, in line with
every other question.

### Why a marker rather than JSON

The prompt already works hard to get plain spoken prose with no lists. Asking
for a JSON envelope fights that instruction and invites markdown fences. A
trailing marker leaves the prose untouched and **degrades safely** — a malformed
or missing marker just means a normal prose answer, never a lost one.

### Decisions

- **Conservative, enforced in code.** Three or more sequential actions, with the
  floor in `parseSteps()` rather than trusted to the prompt, because models
  drift toward being helpful and a checklist for a small thing is an obstacle.
- **A follow-up keeps the task; a new question replaces it.** Follow-ups are
  clarifying questions about work already under way, so the resuming prompt
  explicitly suppresses step lists.
- **Replacement archives rather than deletes.** The chosen behaviour loses
  progress, and this project has already been bitten once by a loss that looked
  like silence. `glance task restore` brings it back.
- **Speech never reads the list.** At 2.5 words/second six steps is over a
  minute of audio. The prose summary plus the current step only.
- **Collapsed by default, expandable on click.** A six-line checklist parked by
  the cursor covers the thing being worked on, and only one line is actionable
  at a time.

### Following up on a task

Found in real use: ⌥R repeated the last *answer*, which mid-task is the summary
from before you started — exactly the wrong thing. It now repeats the step you
are on, with how many remain.

Three changes, together, turn a counter into something that follows along:

- **⌥R repeats the current step**, and says what is left. Working through a list
  without knowing how much remains is the difference between a task and a
  treadmill, and a spoken answer cannot convey a progress bar.
- **⌥⇧N checks the work.** A fresh screenshot, the same conversation, and a
  judgement on whether the step actually happened — advancing if so, naming what
  is missing if not. Separate from ⌥N on purpose: ticking is free and instant,
  verifying costs a capture and ~30,000 tokens, so the user chooses rather than
  every step silently charging them. It mirrors ⌥Space / ⌥⇧Space, where plain is
  the fast path and shift is the one that costs more.
- **The task travels with ordinary questions.** A live task is injected into the
  prompt as context, so "how many steps left?" is answerable without a second
  call. Free: it rides along in a request already being sent.

This needed one provider change — resuming a conversation *with* a new
screenshot, which previously was not expressible: resuming meant reusing the old
image, and a new image meant a new conversation.

## Making the speech sound less mechanical

The voice was fine; the delivery was not. Three changes, all local — no cloud
TTS, so the claim that speech never leaves the machine still holds.

**The first hypothesis was wrong, and that is the useful part.** Technical
strings read slowly — 62 words/minute for a path against 148 for prose — so the
obvious move was rewriting them to be shorter. Measured, rewriting mostly made
them *longer*:

| | As-is | Rewritten |
|---|---|---|
| `~/.glance/config.json` | 3.0 s | 2.3 s |
| `checkout.js:6:22` | 2.8 s | 3.2 s |
| `⌥⇧Space` | 1.1 s | 1.8 s |

Spelling a path out character by character is *correct* for an unknown string.
It simply does not sound like a person. Duration was the wrong target;
naturalness costs a little time rather than saving it.

What actually changed:

- **150 words per minute**, down from the default ~167. Conversational rather
  than hurried, and configurable via `speechRate`.
- **Text written for the ear** before speaking, in `forSpeech()`. Paths become
  "your config file", `⌥⇧` becomes "Option Shift", `checkout.js:6:22` becomes
  "checkout dot J S, line 6". **The panel keeps the text verbatim** — it is
  where someone copies a path from.
- **Sentence pauses** via `[[slnc 320]]`, which Ava honours (+446 ms measured).
  A short break is most of what separates reading a document from talking.

One security note worth keeping: `say` executes `[[...]]` as embedded commands,
so a model answer containing `[[slnc 9000]]` would pause for nine seconds, or
silence itself with `[[volm 0]]`. `forSpeech()` neutralises those first, before
any rule that could introduce brackets. The model's output is not a trusted
source of speech directives.

**The shipped figures moved**, and every citation had to move with them: prose
2.9 → **2.5 words/sec**, lists 1.9 → **1.4**. The finding holds and got starker
— a list now takes ~75% longer per word than prose.

### Two things real use found immediately

**Drafting had nowhere to go.** Asked to write a WhatsApp application and send
it, glance read the chat, found the job, matched it to the user's role and wrote
a good message — then stopped, because `send_message` opens a *new* conversation
via `whatsapp://` and needs a phone number. It could not reach the chat already
on screen, and typing into it would need Accessibility.

The answer was the clipboard. `copy` puts the draft where ⌘V will reach,
needs no permission, and works in every app rather than the few with an
AppleScript dictionary. Drafting is most of what this feature is for, and the
clipboard is how drafts get where they are going.

**The follow-up window lied about the screen.** Asked "can you see the updated
view?" after opening a folder, glance answered from the *previous* screenshot —
twice — because ⌥Space inside 45 seconds reuses it. That is right for "what
about the button on the left?" and wrong for "look at it now", and the two are
indistinguishable by timing.

So the words now beat the clock: a question implying the screen has moved on
forces a capture whatever the timer says. The failure it trades into — an
occasional unnecessary capture — is far cheaper than confidently describing a
screen the user has already left.

## Network failures

glance makes one slow call over the network and then waits. Three things were
wrong with how it handled that going badly.

**The wait was unbounded.** Neither provider had a timeout, so a hung
connection left the badge pulsing beside the cursor forever — no answer, no
error, the same "failure that looks like silence" that cost fifteen silent
failures during the permission work. Both paths now give up after 120s
(`GLANCE_TIMEOUT_MS`).

**Being slow looked identical to being broken.** After 30s (`GLANCE_SLOW_MS`)
the badge changes and says so. This matters for a practical reason: a user who
believes the tool has died presses the hotkey again, starting a second ~59,000
token request alongside the first.

**Offline and "the service is down" were indistinguishable**, despite having
completely different fixes. On failure — and only on failure, since a
reachability probe on the happy path is latency spent to learn nothing — glance
checks two independent endpoints and says which it is.

Faults are classified by walking the error's `cause` chain, because the
Anthropic SDK reports only `Connection error.` and hides the real reason
underneath. Without that the user saw a raw library string.

**Retries differ by path, deliberately.** The API path retries twice with
backoff; a retry there costs a fraction of a cent. The subscription path never
retries automatically, because each attempt costs ~59,000 tokens of a usage
window. It offers `glance retry` instead, which reuses the stored question —
losing a spoken question to a network blip and having to say it all again is the
most irritating way to fail.

## Phase 7 (proposed) — "Hey glance" wake word

Wake it by voice instead of reaching for a hotkey. Costs **zero tokens**:
detection is entirely local and the screen is still only captured after the
wake word fires.

### The decision to make first, before any code

A wake word means **the microphone is always open**, which contradicts what the
README promises today:

> Not always-on. The microphone and the screen are read only after a trigger.

That claim can be honestly revised — nothing is recorded, nothing leaves the
machine, the screen is still only read after the wake word — but the revised
version is a weaker promise, and "always listening" is precisely what people are
suspicious of. It should be chosen deliberately, not drifted into.

### Approaches

| Approach | CPU | New permission | Cost |
|---|---|---|---|
| **Energy-gated whisper** | ~0% idle, brief spikes | none | free |
| Porcupine (`@picovoice/porcupine-node` 4.0.2) | ~1-2% constant | none | free tier, needs an access key and a custom wake-word model |
| macOS `SFSpeechRecognizer` | low | **Speech Recognition** | free |

**Energy-gated whisper first.** ffmpeg's `silencedetect` — already used to know
when the user stops talking — watches for sound, and only then does `tiny.en`
transcribe a short buffer and look for the phrase. Silence costs nothing, which
matters on two cores that already idle under load.

It also adds no dependency, no account, and **no new permission**. The minimal
permission set is the strongest thing glance has; `SFSpeechRecognizer` would
spend it for convenience.

Porcupine is the better production answer — purpose-built, lower false-positive
rate — but needs a Picovoice account and a trained model, which is friction for
something not yet known to work.

### Probe this before building it

False positives are the risk. A wake word that fires on "hey, glance at this" in
conversation, or on the television, is worse than the hotkey. On a machine
already at load 4 with 4.5 GB swapped, a detector that wakes whisper too often
will be felt.

So the question is the same shape as Phase 0's: **can it run all day without
being annoying or slow?** Measure idle CPU and false-positive rate over a few
minutes first, the way the Phase 6 pointer idea was probed and rejected.

---

# Beyond v1 — distribution and the product question

**Recorded 2026-09-30 so the full picture lives in one place. None of this is
in scope until Phases 1-5 ship on macOS.** It is written down to stop it being
re-argued from memory later, not to start it now.

## The idea

Package glance so founders and students can install it on a MacBook, a Windows
laptop or a Linux machine, and eventually run it as a paid product at roughly
**$1/month**. Users bring their own Claude subscription, so the marginal cost of
serving one is near zero and the price can stay that low.

The appeal is real: the people most likely to want this — students staring at
errors, founders working alone with nobody to ask — are exactly the people who
already pay for Claude and have nobody sitting next to them.

## Cross-platform is a second implementation, not a port

v1 rests almost entirely on macOS primitives. Very little of the plumbing
survives a move; what survives is the part already written in TypeScript, plus
the two heaviest components.

| Concern | macOS (built) | Windows | Linux |
|---|---|---|---|
| Screen capture | `screencapture` | `Windows.Graphics.Capture` | `grim` (Wayland), `maim`/`scrot` (X11) |
| Downscale | `ffmpeg` | `ffmpeg` ✅ same | `ffmpeg` ✅ same |
| Speech **in** | whisper.cpp | whisper.cpp ✅ same | whisper.cpp ✅ same |
| Speech **out** | `say` | SAPI via PowerShell | `espeak-ng` or `piper` |
| Global hotkey | `node-global-key-listener` / Swift shim | `node-global-key-listener` | **hard** — Wayland deliberately blocks global hotkeys; needs a portal or per-compositor config |
| Autostart | `launchd` | Task Scheduler | systemd user unit |
| Permissions | TCC prompts | largely none | varies |

**The good news is the expensive parts already port.** whisper.cpp and ffmpeg
both build everywhere, and they are the two components that took real work to
prove. The provider interface is plain TypeScript and is already
platform-agnostic.

**The bad news is Linux audio and Wayland hotkeys.** Wayland's whole security
model exists to stop background processes reading the screen and grabbing keys
— which is precisely what glance does. Expect that to be the hardest single
item, and possibly to need a Flatpak portal rather than a hotkey at all.

Practical order if this happens: **Windows before Linux.** More of the target
users, and no equivalent of the Wayland problem.

## Three things to resolve before this is a business

These are open questions, not blockers to v1. They are written here because the
answers change the shape of the product, and finding out late would be
expensive.

### 1. Is bring-your-own-subscription actually permitted?

The entire economic premise — "$1/month because they already pay for Claude" —
depends on it being acceptable for a **paid third-party product** to drive a
user's own Claude Pro/Max subscription through `claude -p`.

A user running a local tool against their own subscription for their own use is
one thing. Charging for software whose core function is to consume that
subscription is a different thing, and it is not obviously fine. This needs
checking against Anthropic's Usage Policy and Consumer Terms, and probably
asking them directly, **before** any payment infrastructure is built.

If the answer is no, the fallback is the API path that v1 already supports —
users supply their own `ANTHROPIC_API_KEY`, which is unambiguously allowed. The
dual-provider design built in Phase 1 is what makes that pivot cheap. That is a
good reason to keep both paths working even while only one is used.

### 2. "SaaS" is in tension with the privacy promise

The README's strongest claim is that **nothing is stored or streamed anywhere**.
That is currently true and it is the main reason someone would trust a tool that
can see their screen.

If "convert it to SaaS" means screenshots reach a server, that claim dies, and
with it the best argument for installing it. If it means only licensing,
accounts and billing live on a server while capture and inference stay local,
the promise survives intact.

**Decide which one it is early.** The second is a much better product and a much
smaller system to run. Almost everything people mean by SaaS — accounts,
subscriptions, updates — can be done without the screen ever leaving the
machine.

### 3. $1/month has to cover code signing

Distributing to non-technical users means signed, notarised binaries. Unsigned,
macOS Gatekeeper blocks the app outright and Windows SmartScreen warns against
it — for a tool that asks for screen and microphone access, that first-run
warning is fatal to trust.

- Apple Developer Program: **$99/year**
- Windows code-signing certificate: roughly **$100-400/year**

So there is a floor of ~$200-500/year before the first dollar of profit, plus
payment processing, support and update infrastructure. At $1/month that is
~40 subscribers to break even on certificates alone, and Stripe's fees take a
meaningful slice of a $1 transaction. Annual pricing handles that better than
monthly.

None of this makes it a bad idea. It does mean the price is a decision about
positioning, not a calculation — $1 is low enough that the overhead per user,
not the compute, is the thing that determines whether it works.

## What this means for v1

Nothing changes in the current build. Two things are worth doing anyway,
because they cost nothing now and would be expensive to retrofit:

1. **Keep platform calls behind small modules.** `capture.ts` and `speak.ts`
   already isolate every macOS binary. Keep it that way — that discipline is the
   entire difference between a port and a rewrite.
2. **Keep the API provider working**, even while the subscription path is the
   default. It is the escape hatch if question 1 above resolves badly.
