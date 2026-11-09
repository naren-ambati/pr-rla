// Renders docs/images/transcripts/*.json (real captured output) and the GitHub Action job summaries into PNGs.
// Usage: node render.mjs <repo-root> <live-dir> [id ...]   (needs playwright@1.65.0 and marked@18.1.3 installed beside it)
// Run `npx playwright@1.65.0 install chromium` once (a read-only download). Nothing here edits the captured text.
import { chromium } from "playwright";
import { marked } from "marked";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, live, ...only] = process.argv.slice(2);
const TR = join(repo, "docs", "images", "transcripts");
const OUT = join(repo, "docs", "images");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const termCss = `
*{box-sizing:border-box}
body{margin:0;background:#ffffff;padding:20px;width:1060px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#1f2328}
.card{border:1px solid #d0d7de;border-radius:10px;background:#f6f8fa;overflow:hidden}
.bar{display:flex;justify-content:space-between;gap:16px;padding:8px 14px;background:#eaeef2;border-bottom:1px solid #d0d7de;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#57606a}
.bar b{color:#1f2328;font-weight:600}
.body{padding:14px 16px}
.cmd{font-size:13px;line-height:1.45;font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 6px}
.cmd .p{color:#0969da}
pre.out{margin:0 0 6px;font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;color:#1f2328}
.meta{font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#6e7781;margin:0 0 14px}
.meta .bad{color:#cf222e;font-weight:600}.meta .ok{color:#1a7f37;font-weight:600}.meta .warn{color:#9a6700;font-weight:600}
.body>*:last-child{margin-bottom:0}`;

function terminal(t) {
  const date = t.capturedAt.slice(0, 10);
  const blocks = t.commands
    .map((c) => {
      const cls = c.exit === 0 ? "ok" : "warn";
      return `<div class="cmd"><span class="p">$</span> ${esc(c.command)}</div><pre class="out">${esc(c.output)}</pre><div class="meta"><span class="${cls}">exit ${c.exit}</span>${c.seconds != null ? ` · ${c.seconds} s` : ""}</div>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>${termCss}</style><div class="card" id="c"><div class="bar"><span><b>pr-rla ${esc(t.version)}</b> · ${esc(t.title)}</span><span>captured ${date}</span></div><div class="body">${blocks}</div></div>`;
}

const ghCss = `
*{box-sizing:border-box}
body{margin:0;background:#fff;padding:20px;width:1060px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328}
.card{border:1px solid #d0d7de;border-radius:6px;overflow:hidden}
.bar{display:flex;justify-content:space-between;gap:16px;padding:8px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a}
.bar b{color:#1f2328;font-weight:600}
.md{padding:16px 24px 20px}
h2{font-size:1.5em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em;margin:0 0 16px}h3{font-size:1.25em;margin:20px 0 12px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:85%}
pre{background:#f6f8fa;border-radius:6px;padding:12px 16px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
:not(pre)>code{background:#818b981f;border-radius:6px;padding:.2em .4em}
table{border-collapse:collapse;margin:0 0 16px;display:block;max-width:100%;overflow:auto}
th,td{border:1px solid #d1d9e0;padding:6px 13px;text-align:left}th{font-weight:600}tr:nth-child(2n){background:#f6f8fa}
ul{padding-left:2em;margin:0 0 16px}li{margin:.25em 0}p{margin:0 0 16px}`;

function summary(name, title) {
  const d = JSON.parse(readFileSync(join(live, "ci-capture", `${name}.json`), "utf8"));
  const date = new Date().toISOString().slice(0, 10);
  const html = marked.parse(d.summary);
  return { html: `<!doctype html><meta charset="utf-8"><style>${ghCss}</style><div class="card" id="c"><div class="bar"><span><b>Job summary</b> · ${esc(title)}</span><span>GITHUB_STEP_SUMMARY, captured ${date}</span></div><div class="md">${html}</div></div>` };
}

const pages = [];
for (const f of readdirSync(TR).filter((f) => f.endsWith(".json")).sort()) {
  const t = JSON.parse(readFileSync(join(TR, f), "utf8"));
  pages.push({ id: t.id, html: terminal(t) });
}
pages.push({ id: "ci-github-summary-certified", ...summary("action-certified", "pr-rla verify, CERTIFIED fixture") });
pages.push({ id: "ci-github-summary-withheld", ...summary("action-withheld", "pr-rla status, WITHHELD fixture") });

mkdirSync(join(OUT, "raw"), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1.5 });
for (const p of pages) {
  if (only.length && !only.includes(p.id)) continue;
  await page.setContent(p.html);
  await page.locator("#c").screenshot({ path: join(OUT, "raw", `${p.id}.png`) });
  console.log("rendered", p.id);
}
await browser.close();
