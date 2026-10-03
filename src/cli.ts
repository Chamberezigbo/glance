#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type Config } from "./config.js";
import { capture, sessionDir } from "./capture.js";
import { createProvider } from "./providers/index.js";
import { doctor } from "./doctor.js";
import { speak, bestVoice, installedVoices, speechRate } from "./speak.js";
import { listen, setState, calibrate } from "./listen.js";
import { greet, greetingText } from "./greet.js";
import * as session from "./session.js";
import * as task from "./task.js";
import * as actions from "./actions.js";
import * as apply from "./apply.js";
import { isOnline, classify, SLOW_AFTER_MS } from "./net.js";
import { answerMode, publishAnswer, publishError, humanError } from "./answer.js";

const USAGE = `
glance — ask a question about what is on your screen

  glance "what is this error telling me?"     ask by typing
  glance --listen                             ask out loud, answer out loud
  glance --listen --no-speak                  ask out loud, answer as text
  glance doctor                               check this machine is set up
  glance calibrate                            measure your room, so it stops
                                              cutting you off mid-sentence
  glance voices                               hear each installed voice say the
                                              same line, and pick one
  glance apply ["job posting text"]           tailor your CV to a job on screen
                                              (or pasted), render it as a PDF,
                                              and open a Mail draft with it
                                              attached. Never sends.
  glance repeat                               show and speak the last answer
                                              again (⌥R, or the menu bar)
  glance next                                 tick the current step, move to the
                                              next one (⌥N)
  glance task                                 show the checklist
  glance task clear | restore                 drop it, or bring it back
  glance check                                look at the screen and judge
                                              whether the current step is done
  glance retry                                ask the last failed question again

Environment
  GLANCE_TIMEOUT_MS=120000    give up on a request after this long
  GLANCE_SLOW_MS=30000        warn that it is taking unusually long

Big multi-step answers become a checklist you work through one step at a time.
Small questions stay plain prose.
  glance greet --force                        hear the login greeting now

Environment
  GLANCE_NAME="Chamberlain"   what to call you (empty string = no name)
  GLANCE_GREETING=0           turn the login greeting off
  GLANCE_ANSWER_MODE=both     both | voice | popup | none
  GLANCE_RATE=150             speaking rate in words per minute

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
  if (argv[0] === "retry") {
    // Ask the last failed question again, so a network blip does not cost the
    // user the trouble of saying or typing it a second time.
    try {
      const { readFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const pending = JSON.parse(
        readFileSync(join(homedir(), ".glance", "pending.json"), "utf8"),
      );
      if (!pending.question) throw new Error("empty");
      console.error(`glance: retrying "${pending.question}"`);
      const forward = [pending.question, ...(pending.follow ? ["--follow"] : [])];
      process.argv = [process.argv[0]!, process.argv[1]!, ...forward];
      return await main();
    } catch {
      console.error("glance: nothing to retry.");
      return 1;
    }
  }

  if (argv[0] === "check") {
    // Look at the screen and judge whether the current step actually happened.
    //
    // Deliberately separate from `next`. Ticking a step is free and instant;
    // verifying costs a capture and a resumed round trip (~30,000 tokens). The
    // user decides which they want, rather than every step silently costing
    // them one.
    const t = task.load();
    if (!t) { console.error("glance: no task in progress."); return 1; }
    const c = task.currentStep(t);
    if (!c) { console.error("glance: nothing to check."); return 1; }

    const cfgC = resolveConfig({});
    const dirC = sessionDir();
    setState("thinking");
    try {
      const providerC = createProvider(cfgC);
      const priorC = session.load();
      const shotC = await capture({ display: cfgC.display, width: cfgC.width, dir: dirC });
      const res = await providerC.ask({
        question:
          `Looking at this new screenshot, has this step been completed: "${c.text}"?\n\n` +
          `Begin your reply with exactly DONE or NOT_DONE, then one short sentence of plain prose saying what you can see that tells you. ` +
          `If you genuinely cannot tell from the screen, say NOT_DONE and name the one thing you would need to see.`,
        imagePath: shotC.path,
        maxWords: 30,
        resume: session.isUsable(priorC, cfgC) ? priorC!.ref : undefined,
      });
      if (res.session) {
        session.save({
          provider: cfgC.provider, model: cfgC.model, ref: res.session,
          capturedAt: Date.now(), lastAnswerAt: Date.now(),
          turns: (priorC?.turns ?? 0) + 1,
        });
      }

      const done = /^\s*DONE\b/i.test(res.answer);
      const why = res.answer.replace(/^\s*(DONE|NOT_DONE)\b[:.\s-]*/i, "").trim();

      if (done) {
        const { task: updated, finished } = task.advance(t);
        const msg = finished
          ? `Yes — ${why} That was the last step.`
          : `Yes — ${why} ${task.spokenStep(updated!)}`;
        console.log(msg);
        task.publishTask(updated);
        publishAnswer(msg, { question: c.text, followUp: true });
        if (!argv.includes("--silent")) await speak(msg).catch(() => {});
      } else {
        const msg = `Not yet. ${why}`;
        console.log(msg);
        task.publishTask(t);
        publishAnswer(msg, { question: c.text, followUp: true });
        if (!argv.includes("--silent")) await speak(msg).catch(() => {});
      }
      return 0;
    } catch (err) {
      const { spoken, shown } = humanError(err, null);
      console.error(`glance: ${shown}`);
      publishError(shown, c.text);
      if (!argv.includes("--silent")) await speak(spoken).catch(() => {});
      return 1;
    } finally {
      setState("idle");
    }
  }

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
    // Mid-task, the thing worth repeating is the step you are on — not the
    // summary you were given before you started. Repeating the old answer here
    // is actively unhelpful, which is how this was found.
    const live = task.load();
    if (live) {
      const line = task.spokenStep(live);
      console.log(line);
      publishAnswer(line, { question: live.title, followUp: true });
      task.publishTask(live);
      if (!argv.includes("--silent")) await speak(line).catch(() => {});
      return 0;
    }
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
  if (argv[0] === "apply") {
    // Tailor the CV to a job and leave the application as a draft.
    //
    // Stops at the draft deliberately. Everything before it is tedious and worth
    // automating; the send is the one step where being wrong cannot be taken
    // back, and a misread role or a badly tailored CV damages exactly the thing
    // this is meant to help.
    const cfgA = resolveConfig({});
    const dirA = sessionDir();
    const pasted = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");

    const cvPath = await apply.findCV();
    if (!cvPath) {
      console.error('glance: no CV found. Add {"cv": "/path/to/your-cv.pdf"} to ~/.glance/config.json');
      return 1;
    }
    console.error(`  CV:  ${cvPath}`);

    let cvText: string;
    try {
      cvText = await apply.readCV(cvPath);
    } catch (err) {
      console.error(`glance: ${humanError(err, null).shown}`);
      return 1;
    }

    setState("thinking");
    try {
      const provider = createProvider(cfgA);
      // The job description comes from the screen unless it was pasted, so a
      // posting in a chat or a browser works without copying it out first.
      const shot = pasted ? null : await capture({ display: cfgA.display, width: cfgA.width, dir: dirA });
      if (!pasted) console.error("  job: reading it from your screen");

      const res = await provider.ask({
        question:
          `The user is applying for a job. ${pasted ? `The posting:\n\n${pasted}` : "The job posting is on the screenshot."}\n\n` +
          `Their current CV:\n\n${cvText}\n\n` +
          `Do three things, separated by the exact markers below.\n\n` +
          `===ROLE===\n` +
          `One line: the job title, the company, and the email address to apply to if one is given (write "none" if not).\n\n` +
          `===CV===\n` +
          `The CV, rewritten for THIS role, in markdown with # for the name, ## for section headings and - for bullets. ` +
          `Reorder and reword so the most relevant experience comes first, and mirror the posting's own vocabulary where it is honest to do so. ` +
          `Do NOT invent employers, dates, titles or skills — every claim must already be in the CV above. ` +
          `Keep it to one page of content.\n\n` +
          `===EMAIL===\n` +
          `A short application email. First line the subject, then a blank line, then the body. ` +
          `Under 150 words, specific about why this person fits this role, no flattery, no "I am writing to apply".`,
        imagePath: shot?.path,
        maxWords: 2000,
      });

      const section = (name: string): string => {
        const m = res.answer.split(`===${name}===`)[1];
        return m ? m.split(/===[A-Z]+===/)[0]!.trim() : "";
      };
      const role = section("ROLE");
      const cvMd = section("CV");
      const email = section("EMAIL");
      if (!cvMd || !email) {
        console.error("glance: could not read the posting well enough to tailor anything.");
        console.log(res.answer);
        return 1;
      }

      const toMatch = role.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      const company = (role.match(/at\s+([\w &.-]+)/i)?.[1] ?? "role").trim();
      const subjectLine = email.split("\n")[0]!.replace(/^subject:\s*/i, "").trim();
      const bodyText = email.split("\n").slice(1).join("\n").trim();

      const pdfPath = apply.outputPath(company);
      await apply.renderPDF(apply.cvHTML(cvMd, "CV"), pdfPath);

      console.log(`\n  ${role}\n`);
      console.log(`  tailored CV: ${pdfPath}`);
      console.log(`  subject:     ${subjectLine}`);
      console.log(`\n${bodyText}\n`);

      if (!argv.includes("--no-draft")) {
        await apply.draftEmail({
          to: toMatch?.[0] ?? "",
          subject: subjectLine,
          body: bodyText,
          attachment: pdfPath,
        });
        console.error("  Mail is open with the draft and the CV attached. Read it, then send it yourself.");
      }
      return 0;
    } catch (err) {
      const { shown } = humanError(err, null);
      console.error(`glance: ${shown}`);
      return 1;
    } finally {
      setState("idle");
    }
  }

  if (argv[0] === "voices") {
    // Choosing a voice by name is guesswork; choosing by ear takes a minute.
    // macOS ships roughly ten more Premium voices as free downloads, and there
    // is no way to judge them without hearing the same sentence through each.
    const all = await installedVoices();
    const good = all.filter((v) => /\((Premium|Enhanced)\)/.test(v));
    const list = good.length ? good : all.slice(0, 8);
    const sample =
      "That error is a type mismatch. You're passing a string where a number is expected.";
    console.log(`Playing the same sentence through ${list.length} voice(s) at ${speechRate()} wpm.\n`);
    for (const v of list) {
      console.log(`  ${v}`);
      await speak(`${v.replace(/\s*\((Premium|Enhanced)\)/, "")}. ${sample}`, v).catch(() => {});
    }
    if (!good.length) {
      console.log("\nOnly legacy voices are installed. System Settings > Accessibility >");
      console.log("Spoken Content > System voice > Manage Voices has better ones, free.");
    } else {
      console.log(`\nSet one with: {"voice": "${list[0]}"} in ~/.glance/config.json`);
    }
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
  // The words beat the clock. "Look at it now" must capture, even inside the
  // follow-up window — otherwise glance confidently reports on a screen the
  // user has already navigated away from.
  const asksFresh = session.wantsFreshLook(typed);
  const resuming =
    canResume && !asksFresh && (follow || (doListen && session.inFollowWindow(prior)));

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

    // Say so when it is taking longer than usual. A user who thinks the tool is
    // broken presses the hotkey again, which starts a second expensive request
    // alongside the first one still in flight.
    const slowWarning = setTimeout(() => {
      setState("slow");
      console.error(`glance: still waiting after ${Math.round(SLOW_AFTER_MS / 1000)}s — the network may be slow.`);
    }, SLOW_AFTER_MS);

    // A live task travels with the question, so "what's left?" is answerable
    // without a second call or the user repeating themselves.
    // Any task loaded here predates this question — a new one is only created
    // from the answer, further down.
    const live = task.load();
    const asked = live ? `${task.contextLine(live)}\n\n${question}` : question;

    const result = await provider.ask({
      question: asked,
      imagePath: shot?.path,
      maxWords: cfg.maxWords,
      resume: resuming ? prior!.ref : undefined,
    }).finally(() => clearTimeout(slowWarning));

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

    // An action, if the user asked for one. Parsed before steps so the marker
    // block never reaches speech or the panel.
    const { prose: afterAction, action } =
      actions.actionsEnabled()
        ? actions.parseAction(result.answer)
        : { prose: result.answer, action: null };

    // Some answers are sequences, not explanations. Split them before anything
    // is spoken or shown — the marker block must never reach either.
    const { prose, steps } = task.parseSteps(afterAction);

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
      // Never read a checklist aloud. At the measured 2.5 words/second, six
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
        (speakMs ? `\n  spoken    ${(speakMs / 1000).toFixed(1)}s` : `\n  spoken    ~${(words / 2.5).toFixed(1)}s if read aloud (prose; lists run ~75% longer)`) +
        `\n  total     ${(total / 1000).toFixed(1)}s`,
      );
    }
    // Every action is confirmed, including opening an app. The screen is an
    // input glance cannot vet — a page showing instruction-like text could get
    // an action proposed — so a human sees each one before it runs.
    if (action) {
      const what = actions.describeAction(action);
      console.error(`\nglance wants to: ${what}`);
      const ok = await actions.confirmAction(action);
      if (!ok) {
        console.error("glance: cancelled.");
        publishAnswer(`Cancelled: ${what}`, { question, followUp: true });
      } else {
        try {
          const outcome = await actions.runAction(action);
          console.log(outcome);
          publishAnswer(outcome, { question, followUp: true });
          if (mode === "both" || mode === "voice") await speak(outcome).catch(() => {});
        } catch (err) {
          const { spoken, shown } = humanError(err, null);
          console.error(`glance: ${shown}`);
          publishError(shown, question);
          if (mode === "both" || mode === "voice") await speak(spoken).catch(() => {});
        }
      }
    }

    if (keep && shot) console.error(`\nscreenshot: ${shot.path}`);
    return 0;
  } catch (err) {
    // Only probe the network once something has already failed — a reachability
    // check on the happy path is latency spent to learn nothing.
    const fault = classify(err);
    const online = fault ? await isOnline().catch(() => null) : null;

    // Keep the question. Losing a spoken one to a network blip means saying the
    // whole thing again, which is the most irritating way to fail.
    if (fault) {
      try {
        const { writeFileSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        writeFileSync(
          join(homedir(), ".glance", "pending.json"),
          JSON.stringify({ question: typed, follow: follow, at: Date.now() }, null, 2),
        );
      } catch { /* retry is a convenience */ }
    }

    // Say something. A failure that only reaches a log file is indistinguishable
    // from being ignored, which is the single worst way for this to behave.
    const { spoken, shown } = humanError(err, online);
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
