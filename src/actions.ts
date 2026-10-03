import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./greet.js";

const run = promisify(execFile);

/** The marker the model appends when the user has asked for something to be done. */
export const ACTION_MARKER = "###ACTION###";

/**
 * Things glance is allowed to do.
 *
 * The model never produces a command. It picks a verb and supplies parameters;
 * glance builds the command itself. Anything outside this vocabulary is ignored
 * and read out as ordinary prose.
 *
 * That is the whole of the security design here. A model that can emit shell is
 * a model that can do anything, driven by whatever happens to be on screen —
 * and glance cannot tell instructions on a web page from the user's intent.
 */
export type Action =
  | { verb: "open_app"; app: string }
  | { verb: "open_path"; path: string }
  | { verb: "open_settings"; pane: string }
  | { verb: "open_url"; url: string }
  | { verb: "send_message"; app: "Messages" | "WhatsApp"; to: string; text: string }
  | { verb: "diagnose"; app: string };

/** Schemes that may be opened. Anything else — file:, ssh:, custom — is refused. */
const URL_SCHEMES = new Set(["https:", "http:", "mailto:", "sms:", "whatsapp:"]);

/** System Settings panes, by the name a person would say. */
const PANES: Record<string, string> = {
  sound: "com.apple.Sound-Settings.extension",
  displays: "com.apple.Displays-Settings.extension",
  network: "com.apple.Network-Settings.extension",
  bluetooth: "com.apple.BluetoothSettings",
  notifications: "com.apple.Notifications-Settings.extension",
  privacy: "com.apple.settings.PrivacySecurity.extension",
  "screen recording": "com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "com.apple.preference.security?Privacy_Microphone",
  accessibility: "com.apple.preference.universalaccess",
  keyboard: "com.apple.Keyboard-Settings.extension",
  battery: "com.apple.Battery-Settings.extension",
  storage: "com.apple.settings.Storage",
  users: "com.apple.Users-Groups-Settings.extension",
  general: "com.apple.systempreferences.GeneralSettings",
};

/** Off unless explicitly enabled. Someone who never turns this on is unchanged. */
export function actionsEnabled(): boolean {
  if (process.env.GLANCE_ACTIONS === "1") return true;
  if (process.env.GLANCE_ACTIONS === "0") return false;
  return readConfig().actions === true;
}

/** Apps actually installed, so a name can be matched rather than interpolated. */
function installedApps(): string[] {
  const dirs = ["/Applications", "/System/Applications", join(homedir(), "Applications")];
  const out: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith(".app")) out.push(f.replace(/\.app$/, ""));
    } catch { /* directory may not exist */ }
  }
  return out;
}

/**
 * Resolve a spoken app name to one that is installed.
 *
 * Matching against the installed list is what makes shell escaping impossible:
 * `WhatsApp"; rm -rf ~; echo "` matches nothing and is refused, rather than
 * being quoted and hoped about.
 */
function resolveApp(name: string): string | null {
  const apps = installedApps();
  const want = name.trim().toLowerCase();
  return (
    apps.find((a) => a.toLowerCase() === want) ??
    apps.find((a) => a.toLowerCase().startsWith(want)) ??
    apps.find((a) => a.toLowerCase().includes(want)) ??
    null
  );
}

/**
 * Pull an action out of a model answer, validating every field.
 *
 * Returns null for anything unrecognised — the same posture as parseSteps():
 * a bad parse costs the action, never the answer.
 */
export function parseAction(answer: string): { prose: string; action: Action | null } {
  const idx = answer.indexOf(ACTION_MARKER);
  if (idx === -1) return { prose: answer.trim(), action: null };

  const prose = answer.slice(0, idx).trim();
  const body = answer.slice(idx + ACTION_MARKER.length).trim();

  let raw: Record<string, unknown>;
  try {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) return { prose: prose || answer.trim(), action: null };
    raw = JSON.parse(m[0]);
  } catch {
    return { prose: prose || answer.trim(), action: null };
  }

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const fail = { prose: prose || answer.trim(), action: null };

  switch (raw.verb) {
    case "open_app":
    case "diagnose": {
      const app = resolveApp(str(raw.app));
      if (!app) return fail;
      return { prose, action: { verb: raw.verb as "open_app" | "diagnose", app } };
    }
    case "open_path": {
      const p = str(raw.path).replace(/^~/, homedir());
      if (!p || !existsSync(p)) return fail;
      return { prose, action: { verb: "open_path", path: p } };
    }
    case "open_settings": {
      const pane = str(raw.pane).toLowerCase();
      if (!PANES[pane]) return fail;
      return { prose, action: { verb: "open_settings", pane } };
    }
    case "open_url": {
      const u = str(raw.url);
      try {
        if (!URL_SCHEMES.has(new URL(u).protocol)) return fail;
      } catch {
        return fail;
      }
      return { prose, action: { verb: "open_url", url: u } };
    }
    case "send_message": {
      const app = str(raw.app);
      const to = str(raw.to);
      const text = str(raw.text);
      if (!to || !text) return fail;
      if (app !== "Messages" && app !== "WhatsApp") return fail;
      return { prose, action: { verb: "send_message", app, to, text } };
    }
    default:
      return fail;
  }
}

/**
 * Ask the daemon to confirm, and wait for the answer.
 *
 * Written as a file the menu-bar app polls, the same way answer.json and
 * task-display.json already are — the hotkey path runs detached with no
 * terminal, so there is nowhere to prompt.
 */
export async function confirmAction(a: Action, timeoutMs = 60_000): Promise<boolean> {
  const dir = join(homedir(), ".glance");
  const req = join(dir, "confirm.json");
  const res = join(dir, "confirm-result.json");
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(res, { force: true });
    const id = String(Date.now());
    writeFileSync(req, JSON.stringify({ id, description: describeAction(a), at: Date.now() }, null, 2));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const r = JSON.parse(readFileSync(res, "utf8"));
        if (r.id === id) {
          rmSync(req, { force: true });
          rmSync(res, { force: true });
          return r.approved === true;
        }
      } catch { /* not answered yet */ }
    }
    rmSync(req, { force: true });
    return false;   // no answer is a no
  } catch {
    return false;
  }
}

/** Exactly what will happen, for the confirmation. No action runs unconfirmed. */
export function describeAction(a: Action): string {
  switch (a.verb) {
    case "open_app": return `Open ${a.app}`;
    case "open_path": return `Open ${a.path}`;
    case "open_settings": return `Open System Settings — ${a.pane}`;
    case "open_url": return `Open ${a.url}`;
    case "send_message": return `Send to ${a.to} via ${a.app}:\n\n“${a.text}”`;
    case "diagnose": return `Look at why ${a.app} is misbehaving (reads logs only)`;
  }
}

export async function runAction(a: Action): Promise<string> {
  switch (a.verb) {
    case "open_app":
      await run("open", ["-a", a.app]);
      return `Opened ${a.app}.`;

    case "open_path":
      await run("open", ["-R", a.path]);
      return `Opened ${a.path}.`;

    case "open_settings":
      await run("open", [`x-apple.systempreferences:${PANES[a.pane]}`]);
      return `Opened ${a.pane} settings.`;

    case "open_url":
      await run("open", [a.url]);
      return "Opened it.";

    case "send_message":
      return sendMessage(a);

    case "diagnose":
      return diagnose(a.app);
  }
}

/**
 * WhatsApp has no AppleScript dictionary, so its message is prefilled by URL and
 * the user presses send. Messages does, which needs macOS Automation permission
 * — prompted once per app, and not Accessibility.
 */
async function sendMessage(a: Extract<Action, { verb: "send_message" }>): Promise<string> {
  if (a.app === "WhatsApp") {
    await run("open", [`whatsapp://send?phone=${encodeURIComponent(a.to)}&text=${encodeURIComponent(a.text)}`]);
    return "WhatsApp is open with the message ready — press send.";
  }
  // Parameters go in as AppleScript string literals with quotes escaped; they
  // are never concatenated into a shell command.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    `tell application "Messages"\n` +
    `  send "${esc(a.text)}" to buddy "${esc(a.to)}" of service 1\n` +
    `end tell`;
  try {
    await run("osascript", ["-e", script]);
    return `Sent to ${a.to}.`;
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/not authori[sz]ed|-1743|Automation/i.test(msg)) {
      throw new Error(
        "macOS blocked glance from controlling Messages. Allow it in System Settings > " +
          "Privacy & Security > Automation, under glance.",
      );
    }
    throw err;
  }
}

/**
 * Why an app is misbehaving, from read-only sources.
 *
 * A fixed set of probes — never a command the model composed. The output goes
 * back as context for an ordinary spoken answer.
 */
async function diagnose(app: string): Promise<string> {
  const parts: string[] = [];

  try {
    const { stdout } = await run("/bin/ps", ["-Ao", "pid,%cpu,%mem,state,comm"]);
    const lines = stdout.split("\n").filter((l) => l.toLowerCase().includes(app.toLowerCase()));
    parts.push(
      lines.length
        ? `Processes:\n${lines.slice(0, 6).join("\n")}`
        : `${app} is not running.`,
    );
  } catch { /* ps is best-effort */ }

  try {
    const dir = join(homedir(), "Library/Logs/DiagnosticReports");
    const crashes = readdirSync(dir)
      .filter((f) => f.toLowerCase().startsWith(app.toLowerCase().replace(/\s+/g, "")))
      .sort()
      .slice(-2);
    if (crashes.length) {
      const head = readFileSync(join(dir, crashes[crashes.length - 1]!), "utf8").slice(0, 1200);
      parts.push(`Recent crash reports: ${crashes.join(", ")}\n${head}`);
    } else {
      parts.push("No crash reports for it.");
    }
  } catch { /* the directory may not exist */ }

  return parts.join("\n\n");
}
