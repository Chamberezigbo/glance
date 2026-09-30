import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

/**
 * Which `screencapture -D` index is the display the user is actually looking at.
 *
 * This needs detecting, not assuming. On the target machine `system_profiler`
 * enumerates the built-in panel first but `screencapture -D 1` is the external
 * DELL — the two orderings are reversed. Defaulting to 1 would be right there
 * by luck and wrong on the next machine.
 *
 * So: ask system_profiler which display is main and at what logical resolution,
 * then capture each index and keep the one whose pixels match (allowing for a
 * 2x Retina backing store).
 */
/** Repo root, so we can find the compiled Swift helper. */
const repoRoot = join(fileURLToPath(import.meta.url), "../..");

/**
 * Which display the mouse is on — i.e. the one the user is actually looking at.
 *
 * Needs a tiny Swift helper because the mapping from cursor position to a
 * `screencapture -D` index only exists through CGGetActiveDisplayList, which
 * has no shell equivalent. Returns null if it is not built, so callers can
 * fall back rather than fail.
 */
export async function findCursorDisplay(): Promise<number | null> {
  const bin = join(repoRoot, "bin/cursor-display");
  if (!existsSync(bin)) return null;
  try {
    const { stdout } = await run(bin, []);
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

export async function findMainDisplay(): Promise<number> {
  let target: { w: number; h: number } | null = null;
  try {
    const { stdout } = await run("system_profiler", ["-json", "SPDisplaysDataType"]);
    const data = JSON.parse(stdout);
    for (const gpu of data.SPDisplaysDataType ?? []) {
      for (const d of gpu.spdisplays_ndrvs ?? []) {
        if (d.spdisplays_main === "spdisplays_yes") {
          const res: string = d._spdisplays_resolution ?? d.spdisplays_resolution ?? "";
          const m = res.match(/(\d+)\s*x\s*(\d+)/);
          if (m) target = { w: Number(m[1]), h: Number(m[2]) };
        }
      }
    }
  } catch {
    // system_profiler is slow and occasionally unavailable; fall through.
  }
  if (!target) return 1;

  const dir = mkdtempSync(join(tmpdir(), "glance-probe-"));
  try {
    return await probeDisplays(dir, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function probeDisplays(dir: string, target: { w: number; h: number }): Promise<number> {
  for (let d = 1; d <= 8; d++) {
    const probe = join(dir, `d${d}.jpg`);
    try {
      await run("screencapture", ["-x", "-t", "jpg", "-D", String(d), probe]);
      const dims = await imageSize(probe);
      if (!dims) continue;
      const matches =
        (dims.w === target.w && dims.h === target.h) ||
        (dims.w === target.w * 2 && dims.h === target.h * 2);
      if (matches) return d;
    } catch {
      break; // ran past the last display
    }
  }
  return 1;
}

async function imageSize(path: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
    const w = stdout.match(/pixelWidth:\s*(\d+)/);
    const h = stdout.match(/pixelHeight:\s*(\d+)/);
    if (!w || !h) return null;
    return { w: Number(w[1]), h: Number(h[1]) };
  } catch {
    return null;
  }
}

/**
 * Where screenshots go.
 *
 * A *stable* directory, not a fresh temp one. The subscription provider runs
 * `claude -p` with the image's directory as its cwd, and Claude Code keys
 * session history by cwd — so a per-run temp directory meant every glance
 * created its own orphaned project folder in ~/.claude/projects, named after a
 * directory that had already been deleted. Nine of them appeared in a single
 * afternoon.
 *
 * One stable directory means one session history, which is also the
 * precondition for resuming a conversation in Phase 4.
 */
export function sessionDir(): string {
  const dir = join(homedir(), ".glance", "session");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Capture {
  path: string;
  /** The screencapture -D index actually used. */
  display: number;
  width: number;
  height: number;
  bytes: number;
  captureMs: number;
  scaleMs: number;
}

/**
 * Grab one frame and downscale it.
 *
 * ffmpeg rather than sips: measured at 0.11s/20KB against 0.46s/49KB for the
 * identical output dimensions.
 */
export async function resolveDisplay(want: number | "main" | "cursor"): Promise<number> {
  if (typeof want === "number") return want;
  if (want === "cursor") {
    const d = await findCursorDisplay();
    if (d !== null) return d;
    // Helper not built — the main display is a better guess than 1.
  }
  return findMainDisplay();
}

export async function capture(opts: {
  display: number | "main" | "cursor";
  width: number;
  dir: string;
}): Promise<Capture> {
  const display = await resolveDisplay(opts.display);
  const raw = join(opts.dir, "shot.jpg");
  const small = join(opts.dir, "shot-small.jpg");

  const t0 = performance.now();
  // -x suppresses the shutter sound. A silent tool should stay silent.
  await run("screencapture", ["-x", "-t", "jpg", "-D", String(display), raw]);
  const t1 = performance.now();

  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error",
    "-i", raw,
    "-vf", `scale=${opts.width}:-2`,
    "-y", small,
  ]);
  const t2 = performance.now();

  const dims = (await imageSize(small)) ?? { w: opts.width, h: 0 };
  const { statSync } = await import("node:fs");
  return {
    path: small,
    display,
    width: dims.w,
    height: dims.h,
    bytes: statSync(small).size,
    captureMs: t1 - t0,
    scaleMs: t2 - t1,
  };
}
