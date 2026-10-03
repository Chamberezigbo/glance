#!/usr/bin/env python3
"""Render the launch charts as PNGs.

A script rather than a one-off file, because the numbers behind these charts
change when the product changes — the speech figures moved the moment the
speaking rate did, and the chart that was already made became wrong. Bar widths
are computed from the data here so they cannot drift from it.

  python3 scripts/make-charts.py        -> docs/media/chart-*.png
"""
import subprocess, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "media"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MAX_PX = 1130.0

SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
.viz-root{{color-scheme:light;--surface-1:#fcfcfb;--text-primary:#0b0b0b;
--text-secondary:#52514e;--text-muted:#898781;--baseline:#c3c2b7;
--accent:#2a78d6;--deemphasis:#898781;}}
*{{margin:0;padding:0;box-sizing:border-box}}body{{background:var(--surface-1)}}
.viz-root{{width:1600px;height:900px;background:var(--surface-1);
font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
padding:86px 96px;display:flex;flex-direction:column}}
h1{{font-size:60px;line-height:1.12;font-weight:650;color:var(--text-primary);letter-spacing:-.025em}}
.sub{{font-size:27px;color:var(--text-secondary);margin-top:20px;line-height:1.45}}
.plot{{margin-top:68px;flex:1}}.row{{margin-bottom:54px}}
.label{{font-size:25px;color:var(--text-secondary);margin-bottom:14px}}
.track{{display:flex;align-items:center;gap:22px}}
.bar{{height:24px;border-radius:0 4px 4px 0}}
.value{{font-size:34px;font-weight:650;color:var(--text-primary);font-variant-numeric:tabular-nums}}
.axis{{border-top:1px solid var(--baseline);margin-top:6px}}
.note{{font-size:24px;color:var(--text-secondary);margin-top:40px;line-height:1.5}}
.note b{{color:var(--text-primary);font-weight:650}}
.src{{font-size:19px;color:var(--text-muted);margin-top:auto;padding-top:30px}}
</style></head><body><div class="viz-root">{body}</div></body></html>"""


def row(label, px, value, accent):
    colour = "var(--accent)" if accent else "var(--deemphasis)"
    ink = "" if accent else ' style="color:var(--text-secondary)"'
    return (f'<div class="row"><div class="label">{label}</div>'
            f'<div class="track"><div class="bar" style="width:{px:.0f}px;background:{colour};"></div>'
            f'<div class="value"{ink}>{value}</div></div></div>')


def render(name, title, sub, rows, note):
    body = (f"<h1>{title}</h1><div class='sub'>{sub}</div><div class='plot'>"
            + "".join(rows)
            + f"<div class='axis'></div><div class='note'>{note}</div></div>"
            + "<div class='src'>glance &middot; github.com/Chamberezigbo/glance</div>")
    html = ROOT / f".chart-{name}.html"
    html.write_text(SHELL.format(body=body))
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                    f"--screenshot={OUT / f'chart-{name}.png'}",
                    "--window-size=1600,900", str(html)],
                   check=True, capture_output=True)
    html.unlink(missing_ok=True)
    print(f"  docs/media/chart-{name}.png")


# --- tokens: estimate vs measurement -----------------------------------------
EST, MEASURED = 2_500, 59_000
render("tokens",
       "I estimated 2,500 tokens per question.<br>I measured 59,000.",
       "Cost of one question to a macOS screen assistant, measured on real hardware.",
       [row("What I estimated", MAX_PX * EST / MEASURED, f"{EST:,}", False),
        row("What I measured", MAX_PX, f"{MEASURED:,}", True)],
       "The screenshot is only <b>~790 tokens</b> of that.<br>"
       "The rest is an entire coding agent booting up before it looks at the image.")

# --- speech: time to say a 60-word answer ------------------------------------
WORDS, PROSE_WPS, LIST_WPS = 60, 2.5, 1.4
prose, lst = WORDS / PROSE_WPS, WORDS / LIST_WPS
render("speech",
       "A word limit doesn't bound<br>how long an answer takes to hear.",
       f"Time for a speech synthesiser to read a {WORDS}-word answer aloud. "
       "Measured with macOS <code>say</code> at 150 words per minute.",
       [row(f"Written as plain prose &mdash; {PROSE_WPS} words/sec",
            MAX_PX * prose / lst, f"{prose:.0f}s", False),
        row(f"Written as a comma-separated list &mdash; {LIST_WPS} words/sec",
            MAX_PX, f"{lst:.0f}s", True)],
       f"Same number of words. <b>{lst - prose:.0f} seconds longer</b>, because the "
       "synthesiser pauses at every comma.<br>So my prompt now forbids lists outright.")
