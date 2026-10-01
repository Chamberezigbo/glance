import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A multi-step task the user is working through.
 *
 * Some answers are instructions, not explanations — "how do I open-source this
 * repo" is six things done in order. As prose that is spoken once and gone, and
 * the user has to hold the whole sequence in their head while doing it.
 *
 * Costs nothing extra: the steps arrive in the same model response as the
 * answer. Decomposing in a second call would cost another ~59,000 tokens on the
 * subscription path, which is why the output contract does the work instead.
 */
export interface Task {
  title: string;
  steps: { text: string; done: boolean }[];
  /** Index of the step currently being worked on. */
  current: number;
  /** The question that produced it, for context when it is restored. */
  question: string;
  createdAt: number;
}

/** The marker the model appends when an answer is really a sequence. */
export const STEPS_MARKER = "###STEPS###";

/**
 * Three is the threshold, enforced here rather than trusted to the prompt.
 *
 * Two actions is a sentence; a checklist for it is furniture. Models drift
 * toward being helpful, so the floor lives in code where it cannot drift.
 */
const MIN_STEPS = 3;

function dir(): string {
  return join(homedir(), ".glance");
}
function path(): string {
  return join(dir(), "task.json");
}
function previousPath(): string {
  return join(dir(), "task-previous.json");
}

/**
 * Split a model answer into the prose to speak and the steps to track.
 *
 * Deliberately lenient. The model is simultaneously being told to write plain
 * spoken prose, so the marker is the part most likely to come back malformed —
 * and a parse failure must never cost the user their answer. Anything
 * unrecognised simply stays prose, which still reads perfectly well.
 */
export function parseSteps(answer: string): { prose: string; steps: string[] } {
  const idx = answer.indexOf(STEPS_MARKER);
  if (idx === -1) return { prose: answer.trim(), steps: [] };

  const prose = answer.slice(0, idx).trim();
  const steps = answer
    .slice(idx + STEPS_MARKER.length)
    .split("\n")
    .map((line) => line.trim())
    // Numbered, bulleted, or bare — accept whichever the model produced.
    .map((line) => line.replace(/^(\d+[.)]\s*|[-*•]\s*)/, "").trim())
    .filter((line) => line.length > 0);

  // Below the floor it is not a task, and the prose answer already covers it.
  if (steps.length < MIN_STEPS) return { prose: prose || answer.trim(), steps: [] };
  return { prose: prose || answer.trim(), steps };
}

export function load(): Task | null {
  try {
    const t = JSON.parse(readFileSync(path(), "utf8")) as Task;
    return t.steps?.length ? t : null;
  } catch {
    return null;
  }
}

export function save(t: Task): void {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(path(), JSON.stringify(t, null, 2));
  } catch {
    // A lost task costs one re-ask, never an answer.
  }
}

/**
 * Put a task aside, keeping it recoverable.
 *
 * A new question replaces the current task, which is the behaviour asked for —
 * but silently discarding six steps of progress is the kind of quiet loss this
 * project has already been bitten by once. Archiving costs nothing and makes
 * `glance task restore` possible.
 */
export function clear(): void {
  try {
    if (existsSync(path())) renameSync(path(), previousPath());
  } catch {
    rmSync(path(), { force: true });
  }
}

export function restore(): Task | null {
  try {
    if (!existsSync(previousPath())) return null;
    renameSync(previousPath(), path());
    return load();
  } catch {
    return null;
  }
}

export function create(opts: { title: string; steps: string[]; question: string }): Task {
  return {
    title: opts.title,
    steps: opts.steps.map((text) => ({ text, done: false })),
    current: 0,
    question: opts.question,
    createdAt: Date.now(),
  };
}

export interface AdvanceResult {
  task: Task | null;
  /** The step now being worked on, or null when the task is finished. */
  step: string | null;
  finished: boolean;
}

/** Tick the current step and move to the next. */
export function advance(t: Task): AdvanceResult {
  const step = t.steps[t.current];
  if (step) step.done = true;

  if (t.current >= t.steps.length - 1) {
    // Save the final tick before archiving, or a restored task comes back one
    // step short of finished and looks abandoned rather than complete.
    save(t);
    clear();
    return { task: null, step: null, finished: true };
  }
  t.current += 1;
  save(t);
  return { task: t, step: t.steps[t.current]!.text, finished: false };
}

/** What the current step is, for display and speech. */
export function currentStep(t: Task): { index: number; total: number; text: string } | null {
  const s = t.steps[t.current];
  if (!s) return null;
  return { index: t.current + 1, total: t.steps.length, text: s.text };
}

/**
 * How a step is spoken: position first, then the step, then what remains.
 *
 * The tail matters more than it looks. Working through a list without knowing
 * how much is left is the difference between a task and a treadmill, and the
 * count is the one thing a spoken answer cannot convey on its own.
 */
export function spokenStep(t: Task): string {
  const c = currentStep(t);
  if (!c) return "";
  const left = t.steps.length - t.current - 1;
  const tail = left === 0 ? " This is the last one." : left === 1 ? " One more after this." : ` ${left} more after this.`;
  return `Step ${c.index} of ${c.total}. ${c.text}${tail}`;
}

/**
 * Give the model the task as context when answering an unrelated question.
 *
 * Costs nothing — it rides along in a prompt that was being sent anyway — and
 * turns "what's left?" or "am I nearly done?" into answerable questions instead
 * of ones glance would answer about the screen, having forgotten the task
 * entirely.
 */
export function contextLine(t: Task): string {
  const done = t.steps.filter((s) => s.done).map((s) => s.text);
  const todo = t.steps.slice(t.current).map((s) => s.text);
  return [
    `The user is part-way through a task: "${t.title}".`,
    done.length ? `Already done: ${done.join("; ")}.` : "Nothing done yet.",
    `Still to do: ${todo.join("; ")}.`,
    "If they ask about progress or what is next, answer from this. Otherwise answer their question normally and do not mention the task.",
  ].join(" ");
}

/**
 * Hand the task to the menu-bar app, which draws the panel.
 *
 * Same pattern as publishAnswer() in answer.ts: a file rather than stdout,
 * because the hotkey path runs detached with its output redirected to a log.
 * Passing null clears the panel when a task finishes or is dropped.
 */
export function publishTask(t: Task | null): void {
  try {
    mkdirSync(dir(), { recursive: true });
    const file = join(dir(), "task-display.json");
    if (!t) {
      rmSync(file, { force: true });
      return;
    }
    const c = currentStep(t);
    writeFileSync(
      file,
      JSON.stringify(
        {
          title: t.title,
          current: c?.index ?? 0,
          total: c?.total ?? t.steps.length,
          step: c?.text ?? "",
          steps: t.steps,
          at: Date.now(),
        },
        null,
        2,
      ),
    );
  } catch {
    // Display is a convenience; never let it break a task.
  }
}

/** Plain-text rendering for a terminal. */
export function render(t: Task): string {
  const lines = t.steps.map((s, i) => {
    const mark = s.done ? "✓" : i === t.current ? "●" : "○";
    return `  ${mark} ${s.text}`;
  });
  const done = t.steps.filter((s) => s.done).length;
  return `${t.title}  (${done}/${t.steps.length})\n${lines.join("\n")}`;
}
