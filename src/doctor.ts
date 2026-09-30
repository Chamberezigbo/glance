import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findClaudeCli } from "./config.js";

const run = promisify(execFile);
const repoRoot = join(dirnameOf(import.meta.url), "..");

function dirnameOf(url: string): string {
  return join(fileURLToPath(url), "..");
}

type Status = "ok" | "warn" | "fail";
interface Check { name: string; status: Status; detail: string; }

async function has(cmd: string): Promise<boolean> {
  try { await run("which", [cmd]); return true; } catch { return false; }
}

/**
 * What this machine is missing. Written for someone who just cloned the repo
 * on a MacBook that is not the one it was developed on.
 */
export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  checks.push({
    name: "macOS",
    status: process.platform === "darwin" ? "ok" : "fail",
    detail: process.platform === "darwin" ? process.platform : `${process.platform} — glance is macOS only`,
  });

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node >= 22",
    status: major >= 22 ? "ok" : "fail",
    detail: process.versions.node,
  });

  for (const cmd of ["screencapture", "ffmpeg", "say", "sips"]) {
    const present = await has(cmd);
    checks.push({
      name: cmd,
      status: present ? "ok" : cmd === "ffmpeg" ? "fail" : "warn",
      detail: present ? "found" : cmd === "ffmpeg" ? "missing — `brew install ffmpeg`" : "missing",
    });
  }

  // Screen Recording permission: the only reliable test is to try it.
  try {
    const tmp = join("/tmp", `glance-doctor-${process.pid}.jpg`);
    await run("screencapture", ["-x", "-t", "jpg", tmp]);
    checks.push({
      name: "Screen Recording permission",
      status: existsSync(tmp) ? "ok" : "fail",
      detail: existsSync(tmp) ? "granted" : "denied — System Settings > Privacy & Security > Screen Recording",
    });
  } catch {
    checks.push({
      name: "Screen Recording permission",
      status: "fail",
      detail: "denied — grant it to your terminal in System Settings > Privacy & Security > Screen Recording",
    });
  }

  // At least one model path must work.
  const key = Boolean(process.env.ANTHROPIC_API_KEY);
  const cli = findClaudeCli();
  checks.push({
    name: "API key path",
    status: key ? "ok" : "warn",
    detail: key ? "ANTHROPIC_API_KEY is set" : "no ANTHROPIC_API_KEY (optional if the subscription path works)",
  });
  checks.push({
    name: "Subscription path",
    status: cli ? "ok" : "warn",
    detail: cli ? cli : "no claude CLI found — `npm i -g @anthropic-ai/claude-code`",
  });
  if (!key && !cli) {
    checks.push({
      name: "A working model path",
      status: "fail",
      detail: "neither an API key nor a Claude CLI is available — glance cannot reach a model",
    });
  }

  // Voice output quality is a manual download, so warn rather than fail.
  try {
    const { stdout } = await run("say", ["-v", "?"]);
    const premium = stdout.split("\n").filter((l) => /\((Premium|Enhanced)\)/.test(l)).length;
    checks.push({
      name: "Speech voices",
      status: premium > 0 ? "ok" : "warn",
      detail: premium > 0
        ? `${premium} Premium/Enhanced voice(s) installed`
        : "only legacy voices — System Settings > Accessibility > Spoken Content > Manage Voices",
    });
  } catch {
    checks.push({ name: "Speech voices", status: "warn", detail: "could not query `say`" });
  }

  // Phase 2b only, so missing whisper is not a Phase 1 failure.
  const whisper = join(repoRoot, "vendor/whisper.cpp/build/bin/whisper-cli");
  checks.push({
    name: "whisper-cli (voice input, Phase 2b)",
    status: existsSync(whisper) ? "ok" : "warn",
    detail: existsSync(whisper) ? "built" : "not built — run `npm run setup:whisper`",
  });
  const model = join(repoRoot, "models/ggml-base.en.bin");
  checks.push({
    name: "whisper model (Phase 2b)",
    status: existsSync(model) ? "ok" : "warn",
    detail: existsSync(model) ? "ggml-base.en.bin present" : "not downloaded — run `npm run setup:models`",
  });

  // The hotkey daemon and its Swift helpers are Phase 3.
  for (const [name, rel, hint] of [
    ["Hotkey daemon (Phase 3)", "bin/glance-hotkey", "not built — run `npm run setup:hotkey`"],
    ["Cursor-display helper", "bin/cursor-display", "not built — falls back to the main display"],
  ] as const) {
    const built = existsSync(join(repoRoot, rel));
    checks.push({ name, status: built ? "ok" : "warn", detail: built ? "built" : hint });
  }

  const agent = join(process.env.HOME ?? "", "Library/LaunchAgents/com.glance.agent.plist");
  checks.push({
    name: "Login agent",
    status: existsSync(agent) ? "ok" : "warn",
    detail: existsSync(agent) ? "installed — starts at login" : "not installed — run `npm run agent:install`",
  });

  const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  console.log("\nglance doctor\n");
  for (const c of checks) {
    console.log(`  [${mark[c.status]}] ${c.name.padEnd(36)} ${c.detail}`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log(
    failed
      ? `\n${failed} blocking problem(s). glance will not run until these are fixed.\n`
      : `\nReady.${warned ? ` ${warned} optional thing(s) missing — see warnings above.` : ""}\n`,
  );
  return failed ? 1 : 0;
}
