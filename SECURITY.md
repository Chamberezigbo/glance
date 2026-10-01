# Security

glance can see your screen and hear your microphone, so it is worth being clear
about what it does with that.

## What it has access to

Two macOS permissions, and no others:

- **Screen Recording** — to capture one frame when you ask
- **Microphone** — to record a question when you ask out loud

It does **not** have Accessibility or Input Monitoring. That is deliberate and
structural: the global hotkey uses Carbon's `RegisterEventHotKey`, which asks
the window server to deliver one specific chord. A `CGEventTap` — what most
hotkey libraries use — observes every keystroke, which is why those tools need
Input Monitoring.

So glance has no mechanism to read what you type or to control your machine,
regardless of what its code does.

## What leaves your machine

Only when you ask: **one downscaled screenshot and your question**, sent to
Claude, either through your Claude Code subscription or the Anthropic API with
your own key.

Speech recognition is local (whisper.cpp). Speech output is local (`say`).
Nothing is sent on a timer, in the background, or when idle.

## What is stored

- `~/.glance/session/` — the most recent screenshot, overwritten each time
- `~/.glance/answer.json` — the most recent answer
- `glance.log` — questions and answers, in plain text
- Conversations are kept by Claude Code under `~/.claude/projects/`

None of this is encrypted. `glance.log` in particular accumulates everything you
have asked and been told, so treat it as you would shell history. Delete the
whole `~/.glance` directory at any time; nothing depends on it surviving.

## Reporting a vulnerability

Open an issue for anything non-sensitive. For something that should not be
public, email the address on the commits in this repository.

This is a personal project with no security team and no response-time promise.
It is also small enough to read end to end, which is the more useful assurance.
