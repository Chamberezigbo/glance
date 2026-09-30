# glance

An on-demand screen assistant for macOS. You press a key, ask a question out
loud, and it looks at your screen once and answers you out loud.

It does **not** watch continuously. It glances when told to — hence the name.

The brain is Claude Code running headless (`claude -p`), which authenticates
with an existing Claude Pro/Max subscription. There is no second subscription
and no per-token API bill.

Status: **working.** Phases 0-3 are built — you can type or speak a question,
from a terminal or a global hotkey, and hear the answer back.

- [docs/PLAN.md](docs/PLAN.md) — the build plan, phase by phase
- [docs/phase0-findings.md](docs/phase0-findings.md) — what was measured on real hardware
- [docs/BACKLOG.md](docs/BACKLOG.md) — everything deferred, and why

## Using it

```
⌥Space                    ask out loud, hear the answer
⌥⇧Space                   type a question instead
glance "why is this failing?"    from a terminal
glance doctor             check this machine is set up
```

## What it is

```
  ⌥Space ──▶ record mic ──▶ whisper.cpp (local) ──┐
             screencapture ──▶ downscale ─────────┤
                                                  ▼
                                        claude -p  (your subscription)
                                                  │
                                    `say` ◀───────┘  spoken answer
```

## What it is not

- Not a screen recorder. Nothing is stored or streamed anywhere.
- Not an agent that clicks or types for you. It advises; you act.
- Not always-on. The microphone and the screen are read only after a trigger.
- Not related to `anvil` (the sibling repo). anvil is a coding harness with a
  local-model router. glance uses Claude Code itself as the model. They share
  no code and solve opposite problems.
