# Contributing

This is a personal project that works, used daily by one person on one Mac.
Contributions are welcome, with that context in mind.

## Before you open a PR

**Open an issue first for anything beyond a small fix.** It is a young project
with opinions, and some things were left out deliberately — see
[docs/BACKLOG.md](docs/BACKLOG.md) before building something that was already
considered and rejected.

Three decisions that will not change without a strong argument:

- **It asks for Screen Recording and Microphone, and nothing else.** No
  Accessibility, no Input Monitoring. The hotkey uses `RegisterEventHotKey`
  precisely because a `CGEventTap` would see every keystroke. A change that adds
  a permission needs to be worth that.
- **It glances when told to. It does not watch.** Continuous capture was costed
  and rejected.
- **Claims come with measurements.** If a change is about performance, include
  the before and after, taken on real hardware.

## Running it

```bash
npm run setup      # deps, build, Swift app, whisper.cpp, models
npm run setup:cert # stable signing, so permissions survive rebuilds
glance doctor      # what is missing, with the fix beside each line
```

`glance doctor` is the first thing to run when something is wrong, and the first
thing to paste into an issue.

## A warning that will save you an evening

macOS binds Screen Recording and Microphone grants to the app's **code
signature**. An ad-hoc signature is a hash of the binary, so every rebuild looks
like a new app and both permissions silently stop applying — while the toggles
still read "on", and a denied `screencapture` returns your wallpaper rather than
an error.

Run `npm run setup:cert` once. If it gives you trouble, Keychain Access →
Certificate Assistant → Create a Certificate (Self Signed Root, type Code
Signing, named `Glance Local Signing`) does the same thing more reliably.

## Style

Match what is there. In particular, comments explain **why**, especially where
the code looks odd — most of the strange-looking decisions in this repo are
load-bearing, and the reason is usually a measurement.

## Platforms

macOS only for now. Windows and Linux are discussed in
[docs/BACKLOG.md](docs/BACKLOG.md); the short version is that `ffmpeg` and
`whisper.cpp` port unchanged and almost nothing else does.
