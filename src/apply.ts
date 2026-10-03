import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./greet.js";

const run = promisify(execFile);
const repoRoot = join(fileURLToPath(import.meta.url), "../..");

/**
 * Tailor a CV to a job, and leave the application as a draft to review.
 *
 * It stops at the draft deliberately. Everything up to that point is tedious and
 * worth automating; the send is the one step where being wrong is expensive and
 * cannot be taken back. An application that misreads the role, or attaches a CV
 * that reads badly, damages exactly the thing it is meant to help.
 */

/** Where tailored CVs are written. Never overwrites the original. */
export function outputDir(): string {
  const d = join(homedir(), ".glance", "applications");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Find the user's CV: configured, or searched for by name. */
export async function findCV(): Promise<string | null> {
  const configured = readConfig().cv as string | undefined;
  if (configured && existsSync(configured.replace(/^~/, homedir()))) {
    return configured.replace(/^~/, homedir());
  }
  try {
    // The 'c' suffix makes the match case-insensitive. Without it the bracket
    // form silently matches nothing, which reads as "you have no CV".
    const queries = ["kMDItemFSName == '*cv*'c", "kMDItemFSName == '*resume*'c"];
    const found = new Set<string>();
    for (const q of queries) {
      const { stdout } = await run("mdfind", [q]);
      for (const line of stdout.split("\n")) {
        if (/\.(pdf|docx?|pages)$/i.test(line)) found.add(line);
      }
    }

    // A search for "cv" finds other people's too — a CV someone emailed you
    // sits in Downloads looking exactly like yours. Attaching the wrong one to
    // a job application is unrecoverable, so prefer a filename carrying the
    // user's own name before falling back to anything else.
    const own = String(readConfig().name ?? "").trim().toLowerCase();
    const hits = [...found].sort((a, b) => {
      const mine = (p: string) => (own && p.toLowerCase().includes(own) ? 1 : 0);
      return (mine(b) - mine(a)) || (Number(b.endsWith(".pdf")) - Number(a.endsWith(".pdf")));
    });
    return hits[0] ?? null;
  } catch {
    return null;
  }
}

/** Read a CV's text, whatever format it is in. */
export async function readCV(path: string): Promise<string> {
  if (/\.pdf$/i.test(path)) {
    const bin = join(repoRoot, "bin/pdf-text");
    if (!existsSync(bin)) throw new Error("bin/pdf-text is not built. Run: npm run setup:hotkey");
    const { stdout } = await run(bin, [path], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  }
  // textutil handles doc, docx, rtf and html; it does not handle pdf, which is
  // why the Swift helper above exists.
  const { stdout } = await run("textutil", ["-convert", "txt", "-stdout", path], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Render a tailored CV to PDF.
 *
 * HTML through headless Chrome, which is already how the launch charts are
 * made. Generating a PDF directly would mean a layout engine; borrowing the one
 * on the machine is a far smaller thing to maintain.
 */
export async function renderPDF(html: string, outPath: string): Promise<string> {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) throw new Error("Google Chrome is needed to render the PDF.");
  const tmp = outPath.replace(/\.pdf$/, ".html");
  writeFileSync(tmp, html);
  await run(chrome, [
    "--headless", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${outPath}`, tmp,
  ]);
  return outPath;
}

/** A clean, ATS-readable CV page. Deliberately plain: no columns, no graphics. */
export function cvHTML(markdown: string, name: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = esc(markdown)
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (/^#{3}\s/.test(t)) return `<h3>${t.replace(/^#{3}\s/, "")}</h3>`;
      if (/^#{2}\s/.test(t)) return `<h2>${t.replace(/^#{2}\s/, "")}</h2>`;
      if (/^#\s/.test(t)) return `<h1>${t.replace(/^#\s/, "")}</h1>`;
      if (/^[-•*]\s/.test(t)) return `<li>${t.replace(/^[-•*]\s/, "")}</li>`;
      return `<p>${t}</p>`;
    })
    .join("\n")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>
  @page { margin: 14mm 15mm; }
  body { font: 10.5pt/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; }
  h1 { font-size: 19pt; margin: 0 0 2pt; letter-spacing: -0.3pt; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.8pt;
       margin: 14pt 0 5pt; padding-bottom: 3pt; border-bottom: 0.7pt solid #bbb; }
  h3 { font-size: 11pt; margin: 10pt 0 2pt; }
  p  { margin: 0 0 5pt; }
  ul { margin: 4pt 0 8pt; padding-left: 15pt; }
  li { margin-bottom: 3pt; }
</style></head><body>
${body}
</body></html>`;
}

/**
 * Open a draft in Mail, with the CV attached. It is never sent.
 *
 * `visible:true` puts the compose window in front of the user. There is no send
 * command here and there should not be one — the review is the point.
 */
export async function draftEmail(opts: {
  to: string;
  subject: string;
  body: string;
  attachment?: string;
}): Promise<void> {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    'tell application "Mail"',
    `  set msg to make new outgoing message with properties {subject:"${esc(opts.subject)}", content:"${esc(opts.body)}", visible:true}`,
    "  tell msg",
    opts.to ? `    make new to recipient at end of to recipients with properties {address:"${esc(opts.to)}"}` : "",
    opts.attachment
      ? `    make new attachment with properties {file name:(POSIX file "${esc(opts.attachment)}")} at after the last paragraph`
      : "",
    "  end tell",
    "  activate",
    "end tell",
  ].filter(Boolean);

  try {
    await run("osascript", ["-e", lines.join("\n")]);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/not authori[sz]ed|-1743|Automation/i.test(msg)) {
      throw new Error(
        "macOS blocked glance from controlling Mail. Allow it in System Settings > " +
          "Privacy & Security > Automation, under glance.",
      );
    }
    throw err;
  }
}

/** A filename that says what it is, and cannot collide. */
export function outputPath(company: string): string {
  const slug = (company || "role").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  return join(outputDir(), `CV-${slug}-${stamp}.pdf`);
}
