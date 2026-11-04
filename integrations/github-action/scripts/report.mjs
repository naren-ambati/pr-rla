// Writes the job summary and the step outputs for run.sh. Plain Node, no dependencies.
//
// Everything pr-rla printed is data from an audit repository, so it is escaped before it goes into
// markdown: table cells lose their pipes, angle brackets and backticks, and a code block's fence is
// longer than any run of backticks inside it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const command = env.INPUT_COMMAND ?? "status";
const rc = Number(env.PRRLA_RC);
const result = env.PRRLA_RESULT === "pass" ? "pass" : "fail";

const readText = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");

/** One markdown table cell: one line, nothing that renders as markup or HTML. */
const cell = (s) =>
  String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/[\\|`<>&]/g, (c) => ({ "\\": "\\\\", "|": "\\|", "`": "'", "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

/** A fenced code block whose fence cannot be closed from inside. */
const fenced = (s) => {
  const longest = Math.max(0, ...(String(s).match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${String(s).replace(/\n+$/, "")}\n${fence}`;
};

/**
 * The certificate's state, from the result's `certificate` (pr-rla's one display decision: CERTIFIED only when
 * `certified`): CERTIFIED, WITHHELD, NOT_CERTIFIED, ESCALATE, REFUSED or INCOMPLETE. `sequence.state` is the SPRT's
 * raw state and is never reported as the claim; a result without `certificate` falls back to it.
 */
function stateOf(st, certificate) {
  if (certificate && typeof certificate === "object" && typeof certificate.state === "string") return certificate.state.replace(/ /g, "_");
  if (!st || typeof st !== "object" || !st.sequence) return "NOT_CERTIFIED";
  if (st.refusal) return "REFUSED";
  if (st.sequence.state === "ESCALATE") return "ESCALATE";
  // The SPRT's raw CERTIFIED is never the claim: only a result's `certificate` (pr-rla's one display decision, which only
  // verify can make CERTIFIED) says so. Without one, a reached target is withheld, not certified.
  if (st.sequence.state === "CERTIFIED") return "WITHHELD";
  return "NOT_CERTIFIED";
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(3) : "");

function parseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function build() {
  const out = { state: "", prefix: "", llr: "" };
  const md = [];
  const jsonText = readText(env.PRRLA_JSON);
  const text = readText(env.PRRLA_TEXT);
  const errs = readText(env.PRRLA_ERRS);
  const parsed = command === "status" || command === "verify" ? parseJson(jsonText) : null;
  let comment = "";

  md.push(`## pr-rla ${command}`);
  if (parsed && parsed.error) {
    const e = parsed.error;
    md.push("", `pr-rla could not finish: **${cell(e.code)}**: ${cell(e.message)}`);
    if (e.host) md.push("", `Host: ${cell(e.host)}`);
    if (e.next) md.push("", `Next: ${cell(e.next)}`);
  } else if (parsed) {
    // status puts the sequence at the top; verify carries it as `status`, and only when check 7 read the verdicts.
    // An offline verify of a tracker ledger reads none: it has a verdict, and no state to report. (Check 7 may still
    // FAIL there on what it checks locally, P1: the index's publication, the checkpoint file.)
    const st = command === "verify" ? parsed.status : parsed;
    const verdictsRead = command !== "verify" || (st !== null && typeof st === "object");
    const state = verdictsRead ? stateOf(st, parsed.certificate) : "";
    out.state = state;
    if (verdictsRead && st && st.sequence) {
      if (Number.isInteger(st.labelledPrefix) && Number.isInteger(st.drawsIssued)) out.prefix = `${st.labelledPrefix}/${st.drawsIssued}`;
      out.llr = num(st.sequence.llr);
    }
    const line = command === "verify" ? parsed.statusLine : parsed.line;
    md.push("", `### ${command === "verify" ? `${cell(parsed.verdict)}${state ? ` · ${state}` : ""}` : state}`);
    if (line) md.push("", fenced(line));
    const rows = state ? [["State", state]] : [];
    if (out.prefix) rows.push(["Labelled prefix", out.prefix]);
    if (verdictsRead && st && st.sequence) rows.push(["LLR / target", `${num(st.sequence.llr)} / ${num(st.sequence.target)}`], ["Fails", st.sequence.fails]);
    if (parsed.mode) rows.push(["Mode", parsed.mode]);
    if (command === "verify") rows.push(["Verified with", parsed.verifiedWith ?? ""]);
    if (rows.length) md.push("", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`));
    if (command === "verify" && Array.isArray(parsed.checks)) {
      md.push("", "| # | Check | Status | Summary |", "|---|---|---|---|", ...parsed.checks.map((c) => `| ${cell(c.n)} | ${cell(c.name)} | ${cell(c.status)} | ${cell(c.summary)} |`));
      for (const c of parsed.checks.filter((x) => x.status !== "PASS" && x.status !== "SKIP" && Array.isArray(x.details) && x.details.length)) {
        md.push("", `Check ${cell(c.n)} (${cell(c.name)}), ${cell(c.status)}:`, ...c.details.slice(0, 6).map((d) => `- ${cell(d)}`));
      }
    }
    if (line) comment = `**pr-rla ${command}**: ${command === "verify" ? cell(parsed.verdict) : state}\n\n${fenced(line)}\n`;
  } else if (command === "status" || command === "verify") {
    md.push("", "pr-rla printed no JSON result.");
    if (jsonText.trim()) md.push("", fenced(jsonText.split("\n").slice(0, 20).join("\n").slice(0, 2000)));
  } else {
    // checkpoint and sample print text, not JSON.
    if (text.trim()) md.push("", fenced(text.split("\n").slice(0, 40).join("\n").slice(0, 4000)));
    else md.push("", "pr-rla printed nothing.");
  }

  // Warnings matter as much as failures here: a credential that was withheld ("not approved on this machine") shows only on stderr.
  if (errs.trim()) md.push("", "pr-rla also said, on standard error:", "", fenced(errs.split("\n").slice(0, 20).join("\n").slice(0, 2000)));

  // Exit 4 means the command stopped part way and printing it again finishes it: put that command in the summary.
  if (rc === 4) {
    const again = text.split("\n").find((l) => /^\s*run again:/.test(l));
    md.push("", `**Re-run:** ${again ? "" : "the same command again: "}`, "", fenced(again ? again.replace(/^\s*run again:\s*/, "") : env.PRRLA_COMMAND_LINE ?? ""));
  }

  const headline = parsed && !parsed.error ? (command === "verify" ? parsed.statusLine ?? parsed.verdict : parsed.line) : parsed?.error ? `${parsed.error.code}: ${parsed.error.message}` : "";
  if (headline) console.log("pr-rla: " + String(headline).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));

  md.push("", `**Job result: ${result === "pass" ? "PASS" : "FAIL"}** (${cell(env.PRRLA_REASON ?? `exit ${rc}`)})`, "");
  return { out, summary: md.join("\n"), comment };
}

const { out, summary, comment } = build();

if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, ["state", "prefix", "llr"].map((k) => `${k}=${out[k]}\n`).join(""));
if (env.PRRLA_COMMENT_FILE && comment) writeFileSync(env.PRRLA_COMMENT_FILE, comment);
