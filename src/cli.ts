#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type Config } from "./config.js";
import { capture, sessionDir } from "./capture.js";
import { createProvider } from "./providers/index.js";
import { doctor } from "./doctor.js";
import { speak, bestVoice } from "./speak.js";
import { listen, setState, calibrate } from "./listen.js";
import { greet, greetingText } from "./greet.js";
import * as session from "./session.js";
import * as task from "./task.js";
import { answerMode, publishAnswer, publishError, humanError } from "./answer.js";

const USAGE = `
glance — ask a question about what is on your screen

  glance "what is this error telling me?"     ask by typing
  glance --listen                             ask out loud, answer out loud
  glance --listen --no-speak                  ask out loud, answer as text
  glance doctor                               check this machine is set up
  glance calibrate                            measure your room, so it stops
                                              cutting you off mid-sentence
  glance repeat                               show and speak the last answer
                                              again (⌥R, or the menu bar)
  glance next                                 tick the current step, move to the
                                              next one (⌥N)
  glance task                                 show the checklist
  glance task clear | restore                 drop it, or bring it back

Big multi-step answers become a checklist you work through one step at a time.
Small questions stay plain prose.
  glance greet --force                        hear the login greeting now

Environment
  GLANCE_NAME="Chamberlain"   what to call you (empty string = no name)
  GLANCE_GREETING=0           turn the login greeting off
  GLANCE_ANSWER_MODE=both     both | voice | popup | none

Options
  --provider <subscription|api>  which model path to use (default: api if
                                 ANTHROPIC_API_KEY is set, else subscription)
  --model <id>                   override the model
  --display <n|main|cursor>      which screen to capture (default: cursor —
                                 the monitor your mouse is on)
  --width <px>                   downscale width (default: 1024)
  --max-words <n>                cap the answer (default: 45, ~15s spoken)
  --follow, -f                   continue the last conversation without taking
                                 a new screenshot. Roughly half the tokens and
                                 a third of the time
  --new                          force a fresh screenshot, ignoring any
                                 conversation in progress
  --listen                       record the question from the mic instead of
                                 typing it; stops when you stop talking
  --whisper <base|tiny>          transcription model (default: base, more
                                 accurate; tiny is ~2x faster)
  --speak                        read the answer aloud with \`say\`
  --no-speak                     with --listen, print instead of speaking
  --voice <name>                 voice for --speak (default: best installed)
  --popup                        show the answer in a panel by the cursor
  --no-popup                     suppress that panel

By default glance answers the way you asked: typed questions get the panel,
spoken questions get both the panel and a spoken answer. Override with
--speak / --no-speak, or set answerMode in ~/.glance/config.json.
  --verbose                      print timing and token counts
  --keep                         keep the screenshot and print its path
`;

interface Args {
  question: string;
  cfg: Partial<Config>;
  speak: boolean;
  keep: boolean;
  listen: boolean;
  whisper: "base" | "tiny";
  follow: boolean;
  fresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const cfg: Partial<Config> = {};
  const words: string[] = [];
  let doSpeak = false;
  let noSpeak = false;
  let keep = false;
  let doListen = false;
  let whisper: "base" | "tiny" = "base";
  let follow = false;
  let fresh = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--provider": cfg.provider = next() as Config["provider"]; break;
      case "--model": cfg.model = next(); break;
      case "--display": {
        const v = next();
        cfg.display = v === "main" || v === "cursor" ? v : Number(v);
        break;
      }
      case "--width": cfg.width = Number(next()); break;
      case "--max-words": cfg.maxWords = Number(next()); break;
      case "--voice": cfg.voice = next(); doSpeak = true; break;
      case "--speak": doSpeak = true; break;
      case "--no-speak": noSpeak = true; break;
      case "--popup": process.env.GLANCE_ANSWER_MODE = noSpeak ? "popup" : "both"; break;
      case "--no-popup": process.env.GLANCE_ANSWER_MODE = "voice"; break;
      case "--listen": case "-l": doListen = true; break;
      case "--follow": case "-f": follow = true; break;
      case "--new": fresh = true; break;
      case "--whisper": whisper = next() as "base" | "tiny"; break;
      case "--verbose": case "-v": cfg.verbose = true; break;
      case "--keep": keep = true; break;
      default:
        if (a && !a.startsWith("--")) words.push(a);
    }
  }
  // --speak / --no-speak now only override the modality default in answer.ts.
  const speak = noSpeak ? false : doSpeak || doListen;
  if (noSpeak) process.env.GLANCE_ANSWER_MODE = "popup";
  else if (doSpeak && !doListen) process.env.GLANCE_ANSWER_MODE = "both";
  return { question: words.join(" "), cfg, speak, keep, listen: doListen, whisper, follow, fresh };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "doctor") return doctor();
  if (argv[0] === "next") {
    const t = task.load();
    if (!t) {
      console.error("glance: no task in progress.");
      return 1;
    }
    const { task: updated, step, finished } = task.advance(t);
    if (finished) {
      const msg = `Done — that was the last step of ${t.steps.length}.`;
      console.log(msg);
      publishAnswer(msg, { question: t.question, followUp: false });
      task.publishTask(null);
      if (!argv.includes("--silent")) await speak(msg).catch(() => {});
      return 0;
    }
    console.log(step!);
    task.publishTask(updated!);
    publishAnswer(task.spokenStep(updated!), { question: t.question, followUp: true });
    if (!argv.includes("--silent")) await speak(task.spokenStep(updated!)).catch(() => {});
    return 0;
  }

  if (argv[0] === "task") {
    const sub = argv[1];
    if (sub === "clear") {
      task.clear();
      task.publishTask(null);
      console.log("Task cleared. `glance task restore` brings it back.");
      return 0;
    }
    if (sub === "restore") {
      const t = task.restore();
      if (!t) { console.error("glance: nothing to restore."); return 1; }
      task.publishTask(t);
      console.log(task.render(t));
      return 0;
    }
    const t = task.load();
    if (!t) { console.error("glance: no task in progress."); return 1; }
    console.log(task.render(t));
    return 0;
  }

  if (argv[0] === "repeat" || argv[0] === "last") {
    // Bring back the last answer. Spoken answers cannot be re-read and panels
    // time out, so without this a missed answer is simply gone — and the case
    // glance is best at, following steps, is exactly where you need it twice.
    try {
      const { readFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const p = join(homedir(), ".glance", "answer.json");
      const last = JSON.parse(readFileSync(p, "utf8"));
      if (!last.text) throw new Error("empty");
      console.log(last.text);
      // Re-stamp so the daemon treats it as new and shows it again.
      publishAnswer(last.text, {
        question: last.question ?? "",
        followUp: Boolean(last.followUp),
        isError: Boolean(last.isError),
      });
      if (!argv.includes("--silent")) await speak(last.text).catch(() => {});
      return 0;
    } catch {
      const msg = "Nothing to repeat yet.";
      console.error(`glance: ${msg}`);
      return 1;
    }
  }
  if (argv[0] === "greet") {
    const force = argv.includes("--force");
    const spoken = await greet({ force });
    if (!spoken) console.error("(skipped — greeted recently, or GLANCE_GREETING=0)");
    return 0;
  }
  if (argv[0] === "greeting") {
    // Print without speaking, for checking the wording.
    console.log(await greetingText());
    return 0;
  }
  if (argv[0] === "calibrate") {
    console.log("Measuring your room for 4 seconds — stay quiet...");
    const c = await calibrate();
    console.log(`\n  ambient noise   ${c.ambientDb.toFixed(1)} dB`);
    console.log(`  silence cutoff  ${c.noiseDb.toFixed(1)} dB`);
    console.log("\nSaved. glance will use this when deciding you have stopped talking.");
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || (argv.length === 0 && !process.env.GLANCE_LISTEN)) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  const { question: typed, cfg: overrides, speak: doSpeak, keep, listen: doListen, whisper, follow, fresh } = parseArgs(argv);
  if (!typed && !doListen) {
    console.error("glance: no question given.\n" + USAGE);
    return 1;
  }

  const cfg = resolveConfig(overrides);
  // Stable, so Claude Code keeps one session history instead of one per glance.
  const dir = sessionDir();
  const t0 = performance.now();
  let heard: Awaited<ReturnType<typeof listen>> | null = null;

  // Decide up front whether this continues the last conversation. --new always
  // wins; otherwise --follow asks for it, and the hotkey path infers it from how
  // recently the last answer finished.
  const prior = session.load();
  const canResume = !fresh && session.isUsable(prior, cfg);
  const resuming = canResume && (follow || (doListen && session.inFollowWindow(prior)));

  if (follow && !canResume && !fresh) {
    console.error(
      prior
        ? "glance: that conversation is too old to continue — taking a new screenshot."
        : "glance: no conversation to follow up on — taking a new screenshot.",
    );
  }

  try {
    let question = typed;
    if (!doListen) setState("thinking");
    if (doListen) {
      heard = await listen({
        dir,
        model: whisper,
        onStart: (device) => console.error(`listening on ${device} — speak, then pause...`),
      });
      question = heard.text;
      if (!question) {
        const msg = "I didn't catch that. Try again, or type the question instead.";
        console.error(`glance: ${msg}`);
        publishError(msg, "");
        if (answerMode(true) !== "popup") await speak(msg).catch(() => {});
        return 1;
      }
      console.error(`heard: "${question}"\n`);
    }

    const provider = createProvider(cfg);
    if (cfg.verbose) {
      console.error(`glance: ${cfg.provider} (${cfg.providerReason}), model ${cfg.model}`);
    }

    // The whole point of a follow-up: do not capture again.
    const shot = resuming
      ? null
      : await capture({ display: cfg.display, width: cfg.width, dir });

    const result = await provider.ask({
      question,
      imagePath: shot?.path,
      maxWords: cfg.maxWords,
      resume: resuming ? prior!.ref : undefined,
    });

    if (result.session) {
      session.save({
        provider: cfg.provider,
        model: cfg.model,
        ref: result.session,
        capturedAt: resuming ? prior!.capturedAt : Date.now(),
        lastAnswerAt: Date.now(),
        turns: (resuming ? prior!.turns : 0) + 1,
      });
    }

    // Some answers are sequences, not explanations. Split them before anything
    // is spoken or shown — the marker block must never reach either.
    const { prose, steps } = task.parseSteps(result.answer);

    let started: task.Task | null = null;
    if (steps.length > 0 && !resuming) {
      // A new question replaces any task in progress, archived so it can be
      // restored. A follow-up never does: it is a clarifying question about the
      // work already under way.
      const replaced = task.load();
      if (replaced) task.clear();
      started = task.create({ title: question, steps, question });
      task.save(started);
      task.publishTask(started);
      if (replaced) console.error("glance: replaced the previous task (`glance task restore` undoes this).");
    }

    console.log(started ? `${prose}\n\n${task.render(started)}` : prose);

    const mode = answerMode(doListen);
    if (mode === "both" || mode === "popup") {
      publishAnswer(prose, { question, followUp: resuming });
    }

    let speakMs = 0;
    if (mode === "both" || mode === "voice") {
      setState("speaking");
      const s0 = performance.now();
      // Never read a checklist aloud. At the measured 2.9 words/second, six
      // steps is over a minute of audio and unusable. The prose says what the
      // task involves; only the step you are on gets spoken.
      const toSay = started ? `${prose} ${task.spokenStep(started)}` : prose;
      await speak(toSay, cfg.voice ?? (await bestVoice()));
      speakMs = performance.now() - s0;
    }

    // The word cap is a time budget, so a breach is worth seeing rather than
    // silently tolerating. Truncating the answer would cut it mid-sentence,
    // which is worse than being a few words long.
    const words = prose.split(/\s+/).filter(Boolean).length;
    if (cfg.verbose && words > cfg.maxWords) {
      console.error(`\n  note: answer ran ${words} words against a ${cfg.maxWords} cap (~${((words - cfg.maxWords) / 3.1).toFixed(1)}s over)`);
    }

    if (cfg.verbose) {
      const total = performance.now() - t0;
      console.error(
        (heard
          ? `\n  recorded  ${heard.audioSec.toFixed(1)}s of audio` +
            `\n  heard     ${(heard.transcribeMs / 1000).toFixed(1)}s  (whisper ${heard.model}, ${heard.warm ? "resident" : "cold spawn"})`
          : "") +
        (shot
          ? `\n  capture   ${shot.captureMs.toFixed(0)}ms  (display ${shot.display}, ${shot.width}x${shot.height}, ${(shot.bytes / 1024).toFixed(0)}KB)` +
            `\n  scale     ${shot.scaleMs.toFixed(0)}ms`
          : `\n  capture   skipped — follow-up on the earlier screenshot (turn ${(prior?.turns ?? 0) + 1})`) +
        `\n  model     ${(result.ms / 1000).toFixed(1)}s  ${result.usage.total.toLocaleString()} tokens` +
        ` (in ${result.usage.input}, out ${result.usage.output}, cache r${result.usage.cacheRead}/w${result.usage.cacheCreation})` +
        (result.costUsd !== undefined ? `  $${result.costUsd.toFixed(4)}` : "") +
        `\n  answer    ${words} words` +
        (speakMs ? `\n  spoken    ${(speakMs / 1000).toFixed(1)}s` : `\n  spoken    ~${(words / 2.9).toFixed(1)}s if read aloud (prose; lists run ~50% longer)`) +
        `\n  total     ${(total / 1000).toFixed(1)}s`,
      );
    }
    if (keep && shot) console.error(`\nscreenshot: ${shot.path}`);
    return 0;
  } catch (err) {
    // Say something. A failure that only reaches a log file is indistinguishable
    // from being ignored, which is the single worst way for this to behave.
    const { spoken, shown } = humanError(err);
    console.error(`glance: ${shown}`);
    publishError(shown, typed);
    if (doListen && answerMode(true) !== "popup") {
      await speak(spoken).catch(() => {});
    }
    return 1;
  } finally {
    setState("idle");
    // The directory is reused, so only the screenshot is cleared, and only when
    // it was not explicitly kept for inspection.
    if (!keep) rmSync(join(dir, "shot.jpg"), { force: true });
  }
}

main().then((code) => process.exit(code));
