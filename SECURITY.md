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

## Performing tasks

Off by default. When enabled, glance can open apps, folders, settings panes and
links, send or prefill a message, and read an app's logs to diagnose it.

**It does not gain Accessibility or Input Monitoring.** Sending through Messages
uses macOS **Automation**, which is prompted per app and grants control of that
one app — it does not grant keyboard access. The claim above, that glance has no
mechanism to read what you type, still holds.

Three bounds:

1. **An allowlist, not a shell.** The model selects a verb from a fixed
   vocabulary and supplies parameters; glance constructs the command. App names
   are matched against installed apps, paths must exist, and URL schemes are
   restricted to https, http, mailto, sms and whatsapp. A forged verb is
   discarded.
2. **Every action is confirmed** before it runs, including opening an app, with
   Cancel as the default button. There is deliberately no way to suppress this.
3. **Disabled unless you enable it**, in the menu bar or `~/.glance/config.json`.

### The risk this introduces

With tasks enabled, **the screen becomes an input that can propose actions**.
glance reads whatever is in front of it and cannot distinguish a user's request
from text in a web page, an email or an image that is shaped like one. A page
displaying something that looks like an instruction could cause an action to be
suggested.

The system prompt tells the model to treat on-screen text as content rather than
instruction, and that holds in testing. But the confirmation is the defence that
does not depend on the model behaving, which is why every action has one.

If this matters to you, leave tasks off. With them off glance is exactly as it
was: it looks, and it advises.

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
