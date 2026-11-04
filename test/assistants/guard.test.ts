import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The guard hook (U6, FR3.7; functional-design.md §U6; contracts.md §7): every case is a named hook payload, in
 * the client's own documented shape (test/fixtures/hooks, synthetic, from each client's official docs read
 * 2026-11-04). Each case runs twice: through evaluate() in this process, and through guard.mjs as the hook
 * process, with the payload on stdin and the exit code and output the client reads.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = join(ROOT, "integrations", "claude-code", "hooks", "guard.mjs");
const FIX = join(ROOT, "test", "fixtures", "hooks");

type Client = "claude-code" | "codex" | "cursor";
type Env = Record<string, string | undefined>;
interface Result {
  client: Client;
  decision: "block" | "allow";
  reasons: string[];
}
interface GuardModule {
  evaluate(payload: unknown, o?: { client?: Client; env?: Env }): Result;
  render(r: Result): { exitCode: number; stdout: string; stderr: string };
  detectClient(payload: unknown): Client;
  checkShell(command: string | string[], o?: { cwd?: string; env?: Env }): string[];
  GUARD_VERSION: string;
}

let guard: GuardModule;

/** The audit repos, a project that is not one, and a home with an approvals file. */
interface World {
  base: string;
  home: string;
  audit: string;
  staged: string;
  dirty: string;
  untracked: string;
  notes: string;
  tracker: string;
  other: string;
  env: Env;
}
let w: World;

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "init.defaultBranch=main", ...a], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

function write(p: string, text: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** An audit repo with every record of one window, committed, plus a second commit that appends a verdict. */
function auditRepo(dir: string, ledger = "git-file") {
  write(join(dir, ".pr-rla.yml"), `provider: { use: json-file, options: { path: changes.json } }\nrepo: o/r\nwindow: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }\nledger: ${ledger}\n`);
  const win = join(dir, "audit", "2026-q3");
  for (const f of ["registration.json", "manifest-commitment.json", "draws.json", "ledger-index.json", "ledger-publication.json"]) write(join(win, f), "{}\n");
  write(join(win, "verdicts.jsonl"), "");
  write(join(win, "ledger-checkpoints.jsonl"), "");
  write(join(win, "ledger-history", "2026-11-04T00-00-00Z.json"), "[]\n");
  write(join(dir, "audit", "2026-q3.manifest.json"), "{}\n");
  write(join(dir, "pr-rla.lock.json"), '{"schema":"pr-rla/lock/v1","plugins":{}}\n');
  write(join(dir, ".pr-rla", "signing-key.pem"), "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n");
  write(join(dir, ".gitignore"), ".pr-rla/\nnotes-link.jsonl\n");
  write(join(dir, "review-protocol.md"), "# Protocol\n");
  write(join(dir, "notes.md"), "notes\n");
  write(join(dir, "scripts", "sneak.sh"), "#!/bin/sh\npr-rla record 3 pass --reviewer alice\n");
  write(join(dir, "scripts", "harmless.sh"), "#!/bin/sh\npr-rla status --offline\n");
  chmodSync(join(dir, "scripts", "sneak.sh"), 0o755);
  write(join(dir, "package.json"), JSON.stringify({ private: true, scripts: { rec: "pr-rla record 4 pass", st: "pr-rla status", test: "echo ok" } }));
  write(join(dir, "Makefile"), "build:\n\techo build\nrec:\n\tpr-rla record 5 pass --reviewer alice\n");
  write(join(dir, "forge.patch"), "diff --git a/audit/2026-q3/verdicts.jsonl b/audit/2026-q3/verdicts.jsonl\n--- a/audit/2026-q3/verdicts.jsonl\n+++ b/audit/2026-q3/verdicts.jsonl\n@@ -0,0 +1 @@\n+{\"draw\":1,\"verdict\":\"pass\"}\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the audit");
  writeFileSync(join(win, "verdicts.jsonl"), '{"draw":1,"verdict":"pass","reviewer":"alice"}\n');
  git(dir, "commit", "-qam", "verdict for draw 1");
}

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "prrla-guard-")));
  const home = join(base, "home");
  write(join(home, ".config", "pr-rla", "approvals.json"), '{"schema":"pr-rla/approvals/v1","plugins":{}}\n');
  const audit = join(base, "audit-repo");
  auditRepo(audit);
  const staged = join(base, "staged-repo");
  auditRepo(staged);
  writeFileSync(join(staged, "audit", "2026-q3", "verdicts.jsonl"), '{"draw":1,"verdict":"pass","reviewer":"alice"}\n{"draw":2,"verdict":"pass","reviewer":"alice"}\n');
  git(staged, "add", "audit/2026-q3/verdicts.jsonl");
  const dirty = join(base, "dirty-repo");
  auditRepo(dirty);
  writeFileSync(join(dirty, "audit", "2026-q3", "verdicts.jsonl"), '{"draw":1,"verdict":"pass","reviewer":"alice"}\n{"draw":2,"verdict":"fail","reviewer":"alice"}\n');
  const untracked = join(base, "untracked-repo");
  auditRepo(untracked);
  write(join(untracked, "audit", "2026-q4", "draws.json"), "{}\n");
  const notes = join(base, "notes-repo");
  auditRepo(notes);
  writeFileSync(join(notes, "notes.md"), "notes, edited\n");
  git(notes, "add", "notes.md");
  const tracker = join(base, "tracker-repo");
  write(join(tracker, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: o/audit, labels: { pass: reviewed-ok, fail: reviewed-bad } } }\n");
  write(join(tracker, "audit", "2026-q3", "ledger-index.json"), JSON.stringify({ labels: { pass: { name: "Reviewed-OK", id: 1 }, fail: { name: "Reviewed-Bad", id: 2 }, draw: { name: "pr-rla:draw", id: 3 } }, issues: [] }));
  const other = join(base, "web-app");
  write(join(other, "src", "registration.json"), "{}\n");
  write(join(other, "draws.json"), "{}\n");
  write(join(other, "Makefile"), "build:\n\techo build\n");
  // Archives: one whose entry is named like a record, one that is not.
  const packed = join(base, "packed");
  write(join(packed, "verdicts.jsonl"), '{"draw":1,"verdict":"pass"}\n');
  write(join(packed, "readme.txt"), "x\n");
  execFileSync("tar", ["-cf", join(audit, "evil.tar"), "-C", packed, "verdicts.jsonl"]);
  execFileSync("tar", ["-cf", join(audit, "safe.tar"), "-C", packed, "readme.txt"]);
  git(other, "init", "-q");
  symlinkSync(join(audit, "audit", "2026-q3", "verdicts.jsonl"), join(audit, "notes-link.jsonl"));
  return { base, home, audit, staged, dirty, untracked, notes, tracker, other, env: { HOME: home, PATH: process.env.PATH } };
}

// --- payloads, in each client's documented shape ------------------------------------------------------------------

const template = (name: string) => (JSON.parse(readFileSync(join(FIX, name), "utf8")) as { payload: Record<string, unknown> }).payload;

type Maker = (w: World) => { payload: Record<string, unknown>; client: Client; env?: Env };

const cc = {
  bash: (command: string, cwd?: (w: World) => string): Maker => (w) => ({ client: "claude-code", payload: { ...template("claude-code-pretooluse.json"), cwd: cwd ? cwd(w) : w.audit, tool_name: "Bash", tool_input: { command, description: "test" } } }),
  tool: (tool_name: string, input: (w: World) => Record<string, unknown>, cwd?: (w: World) => string): Maker => (w) => ({ client: "claude-code", payload: { ...template("claude-code-pretooluse.json"), cwd: cwd ? cwd(w) : w.audit, tool_name, tool_input: input(w) } }),
};
const codex = {
  bash: (command: string | string[]): Maker => (w) => ({ client: "codex", payload: { ...template("codex-pretooluse.json"), cwd: w.audit, tool_name: "Bash", tool_input: { command } } }),
  patch: (patch: string): Maker => (w) => ({ client: "codex", payload: { ...template("codex-pretooluse.json"), cwd: w.audit, tool_name: "apply_patch", tool_input: { command: patch } } }),
  tool: (tool_name: string, input: Record<string, unknown>): Maker => (w) => ({ client: "codex", payload: { ...template("codex-pretooluse.json"), cwd: w.audit, tool_name, tool_input: input } }),
};
const cursor = {
  shell: (command: string): Maker => (w) => ({ client: "cursor", payload: { ...template("cursor-before-shell-execution.json"), command, cwd: w.audit, workspace_roots: [w.audit] } }),
  mcp: (server: string, tool: string, input: Record<string, unknown>): Maker => (w) => ({ client: "cursor", payload: { ...template("cursor-before-mcp-execution.json"), mcp_server_name: server, tool_name: tool, tool_input: JSON.stringify(input), workspace_roots: [w.audit] } }),
  read: (file: (w: World) => string): Maker => (w) => ({ client: "cursor", payload: { ...template("cursor-before-read-file.json"), file_path: file(w), workspace_roots: [w.audit] } }),
  tool: (tool_name: string, input: (w: World) => Record<string, unknown>): Maker => (w) => ({ client: "cursor", payload: { ...template("cursor-pretooluse.json"), tool_name, tool_input: input(w), cwd: w.audit, workspace_roots: [w.audit] } }),
};
const withEnv = (m: Maker, env: (w: World) => Env): Maker => (w) => ({ ...m(w), env: { ...w.env, ...env(w) } });

const rec = (w: World, f: string) => join(w.audit, "audit", "2026-q3", f);
const inOther = (w: World) => w.other;
const inTracker = (w: World) => w.tracker;
const inStaged = (w: World) => w.staged;
const inDirty = (w: World) => w.dirty;
const inUntracked = (w: World) => w.untracked;
const inNotes = (w: World) => w.notes;

interface Case {
  name: string;
  make: Maker;
  block: RegExp | false;
}
const blocked = (name: string, make: Maker, why: RegExp): Case => ({ name, make, block: why });
const allowed = (name: string, make: Maker): Case => ({ name, make, block: false });

const RECORD = /pr-rla record writes a verdict/;
const RECORD_FILE = /, an audit record|ledger's history|holding audit records|names an audit record|may be an audit record/;
const LABEL = /verdict label|label endpoint|labels/;
const CONSENT = /consent/;

const cases: Case[] = [
  // ---- verdict writes and signing -------------------------------------------------------------------------------
  blocked("pr-rla record", cc.bash("pr-rla record 5 pass --reviewer alice"), RECORD),
  blocked("pr-rla -C <dir> record, from another project", cc.bash('pr-rla -C ../audit-repo record 5 fail --note "missing test"', inOther), RECORD),
  blocked("npx pr-rla@<version> record", cc.bash("npx -y pr-rla@0.1.0 record 7 pass"), RECORD),
  blocked("node <checkout>/dist/cli.js record", cc.bash("node /opt/pr-rla/dist/cli.js record 7 pass"), RECORD),
  blocked("./node_modules/.bin/pr-rla record", cc.bash("./node_modules/.bin/pr-rla record 2 pass"), RECORD),
  blocked("pr-rla record --sign (the reviewer signs their own verdict)", cc.bash("pr-rla record 3 pass --sign ~/keys/verdict_sk"), /--sign makes the reviewer's signature/),
  blocked("ssh-keygen -Y sign -n pr-rla-verdict@v1", cc.bash("ssh-keygen -Y sign -n pr-rla-verdict@v1 -f ~/keys/verdict_sk verdict-7.txt"), /signs a pr-rla verdict/),
  blocked("ssh-keygen with attached option values (-Ysign -npr-rla-verdict@v1)", cc.bash("ssh-keygen -Ysign -npr-rla-verdict@v1 -f k verdict.txt"), /signs a pr-rla verdict/),
  blocked("ssh-keygen -Y sign with a computed namespace", cc.bash('printf "%s" "$BYTES" | ssh-keygen -Y sign -f key -n "$NS"'), /signs a pr-rla verdict/),
  // ---- pr-rla's other write commands ----------------------------------------------------------------------------
  blocked("pr-rla register", cc.bash("pr-rla register"), /pr-rla register writes the audit's records/),
  blocked("pr-rla register --dry-run (register is the person's, in every form)", cc.bash("pr-rla register --dry-run"), /pr-rla register/),
  blocked("pr-rla freeze --force", cc.bash("pr-rla freeze --force"), /pr-rla freeze .*freeze_preview/),
  blocked("pr-rla sample --through", cc.bash("pr-rla sample --through 40"), /it issues draws/),
  blocked("pr-rla init --force", cc.bash("pr-rla init --repo o/r --force"), /pr-rla init/),
  blocked("pr-rla checkpoint --push", cc.bash("pr-rla checkpoint --push"), /checkpoint --push commits and pushes/),
  blocked("pr-rla checkpoint --remote/--branch (push options)", cc.bash("pr-rla checkpoint --remote origin --branch main"), /checkpoint --push/),
  blocked("--submit to a transparency log", cc.bash("pr-rla register --submit --rekor-url https://rekor.example --yes"), /--submit writes a public, permanent/),
  blocked("an unknown pr-rla subcommand (default deny)", cc.bash("pr-rla attest 5"), /not a pr-rla command the guard knows to be read-only/),
  // ---- consent: approvals, --accept-lock-grants, PR_RLA_ACCEPT_LOCK_GRANTS ---------------------------------------
  blocked("pr-rla plugin approve <use>", cc.bash("pr-rla plugin approve ./plugins/jira/index.mjs --yes"), /plugin approve records your consent/),
  blocked("pr-rla plugin approve --env --origin (a built-in's credential)", cc.bash("pr-rla plugin approve --env GHE_TOKEN --origin https://ghe.example.com --yes"), /plugin approve/),
  blocked("pr-rla plugin add", cc.bash("pr-rla plugin add pr-rla-provider-gitea --yes"), /plugin add records your consent/),
  blocked("pr-rla plugin lock", cc.bash("pr-rla plugin lock ./p.mjs --trust full --yes"), /plugin lock/),
  blocked("--accept-lock-grants after the subcommand", cc.bash("pr-rla verify --accept-lock-grants"), /--accept-lock-grants takes the repo's credential grants/),
  blocked("--accept-lock-grants before the subcommand", cc.bash("pr-rla --accept-lock-grants status"), /--accept-lock-grants/),
  blocked("PR_RLA_ACCEPT_LOCK_GRANTS=1 as a prefix", cc.bash("PR_RLA_ACCEPT_LOCK_GRANTS=1 pr-rla verify"), /PR_RLA_ACCEPT_LOCK_GRANTS/),
  blocked("export PR_RLA_ACCEPT_LOCK_GRANTS=1", cc.bash("export PR_RLA_ACCEPT_LOCK_GRANTS=1; pr-rla status"), /PR_RLA_ACCEPT_LOCK_GRANTS/),
  blocked("env PR_RLA_ACCEPT_LOCK_GRANTS=1", cc.bash("env PR_RLA_ACCEPT_LOCK_GRANTS=1 pr-rla status"), /PR_RLA_ACCEPT_LOCK_GRANTS/),
  blocked("PR_RLA_APPROVALS_FILE pointed at another file", cc.bash("PR_RLA_APPROVALS_FILE=/tmp/mine.json pr-rla verify"), /PR_RLA_APPROVALS_FILE/),
  blocked("HOME changed for pr-rla (another approvals file)", cc.bash("HOME=/tmp/fakehome pr-rla verify --offline"), /HOME or XDG_CONFIG_HOME/),
  blocked("a session started with PR_RLA_ACCEPT_LOCK_GRANTS=1", withEnv(cc.bash("pr-rla status"), () => ({ PR_RLA_ACCEPT_LOCK_GRANTS: "1" })), /this session's environment sets PR_RLA_ACCEPT_LOCK_GRANTS/),
  // ---- verdict labels -------------------------------------------------------------------------------------------
  blocked("gh issue edit --add-label pr-rla:pass", cc.bash("gh issue edit 12 --add-label pr-rla:pass"), /gh issue edit --add-label/),
  blocked("gh issue edit --remove-label (quoted)", cc.bash('gh issue edit 12 --remove-label "pr-rla:fail"'), /--remove-label/),
  blocked("gh issue edit --add-label=<list> by URL", cc.bash("gh issue edit https://github.com/o/audit/issues/12 --add-label=bug,pr-rla:pass"), LABEL),
  blocked("gh -R … issue edit, label in another case", cc.bash("gh -R o/audit issue edit 12 --add-label PR-RLA:PASS"), LABEL),
  blocked("gh issue edit with the audit's own configured label", cc.bash("gh issue edit 12 --add-label reviewed-ok", inTracker), LABEL),
  blocked("gh issue edit with a computed label", cc.bash('gh issue edit 12 --add-label "$LABEL"'), LABEL),
  blocked("gh pr edit --add-label on the audit repo", cc.bash("gh pr edit 3 --add-label pr-rla:fail"), LABEL),
  blocked("gh issue create --label pr-rla:pass", cc.bash('gh issue create --title "draw" --body x --label pr-rla:pass'), LABEL),
  blocked("gh api -X POST …/issues/n/labels", cc.bash("gh api -X POST repos/o/audit/issues/12/labels -f 'labels[]=pr-rla:pass'"), /label endpoint/),
  blocked("gh api --method DELETE …/labels/<name>", cc.bash("gh api --method DELETE repos/o/audit/issues/12/labels/pr-rla:pass"), /DELETE .* label endpoint/),
  blocked("gh api with fields (an implicit POST)", cc.bash("gh api repos/o/audit/issues/12/labels -f 'labels[]=pr-rla:pass'"), /POST .* label endpoint/),
  blocked("gh api -X PUT …/labels (replace all)", cc.bash("gh api -X PUT repos/o/audit/issues/12/labels --input labels.json"), /PUT .* label endpoint/),
  blocked("gh api -X PATCH an issue with labels", cc.bash("gh api -X PATCH repos/o/audit/issues/12 -F 'labels[]=pr-rla:pass'"), /changes an issue's labels/),
  blocked("gh api graphql addLabelsToLabelable", cc.bash(`gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: "I_1", labelIds: ["L_1"]}) { clientMutationId } }'`), /GraphQL label mutation/),
  blocked("gh api renaming a label", cc.bash("gh api -X PATCH repos/o/audit/labels/pr-rla:pass -f new_name=ok"), /label endpoint/),
  blocked("gh label delete pr-rla:fail", cc.bash("gh label delete pr-rla:fail --yes"), /gh label delete changes a pr-rla verdict label/),
  blocked("gh label edit --name pr-rla:pass", cc.bash("gh label edit bug --name pr-rla:pass"), /renames a label to a pr-rla verdict label/),
  blocked("gh alias set to a label edit", cc.bash("gh alias set approve 'issue edit --add-label pr-rla:pass'"), LABEL),
  blocked("glab issue update --label pr-rla-pass", cc.bash("glab issue update 12 --label pr-rla-pass"), /glab issue update --label/),
  blocked("glab issue update --unlabel pr-rla-fail", cc.bash("glab issue update 12 --unlabel pr-rla-fail"), /--unlabel/),
  blocked("glab api PUT an issue with add_labels", cc.bash("glab api -X PUT projects/1/issues/12 -f add_labels=pr-rla-pass"), /changes an issue's labels/),
  blocked("curl -X POST to …/labels", cc.bash(`curl -X POST -H "Authorization: Bearer $T" https://api.github.com/repos/o/audit/issues/12/labels -d '{"labels":["pr-rla:pass"]}'`), /curl POST .* label endpoint/),
  blocked("curl --request DELETE an encoded label", cc.bash("curl --request DELETE https://api.github.com/repos/o/audit/issues/12/labels/pr-rla%3Apass"), /curl DELETE/),
  blocked("curl -XPUT to GitLab with add_labels in the query", cc.bash('curl -sS -XPUT "https://gitlab.com/api/v4/projects/1/issues/12?add_labels=pr-rla-pass"'), /curl PUT .* changes an issue's labels/),
  blocked("curl -d @file (an implicit POST)", cc.bash("curl -d @label.json https://api.github.com/repos/o/audit/issues/12/labels"), /curl POST/),
  blocked("curl a GraphQL label mutation", cc.bash(`curl -X POST https://api.github.com/graphql -d '{"query":"mutation { addLabelsToLabelable(input:{}) { clientMutationId } }"}'`), /GraphQL label mutation/),
  blocked("wget --method=POST to …/labels", cc.bash(`wget --method=POST --body-data='{"labels":["pr-rla:pass"]}' https://api.github.com/repos/o/audit/issues/12/labels`), /wget POST/),
  blocked("HTTPie POST to …/labels", cc.bash(`http POST https://api.github.com/repos/o/audit/issues/12/labels labels:='["pr-rla:pass"]'`), /HTTPie POST/),
  blocked("another MCP server's add_issue_labels with pr-rla:pass", cc.tool("mcp__github__add_issue_labels", () => ({ owner: "o", repo: "audit", issue_number: 12, labels: ["pr-rla:pass"] })), /carries the pr-rla verdict label/),
  blocked("another MCP server's update_issue with labels", cc.tool("mcp__github__update_issue", () => ({ owner: "o", repo: "audit", issue_number: 12, labels: ["bug", "pr-rla:fail"] })), /verdict label/),
  blocked("a GitLab MCP update with add_labels", cc.tool("mcp__gitlab__update_issue", () => ({ project_id: 1, issue_iid: 12, add_labels: "pr-rla-pass" })), /verdict label/),
  blocked("an MCP shell tool running pr-rla record", cc.tool("mcp__shell__run_command", () => ({ command: "pr-rla record 1 pass" })), RECORD),
  blocked("an MCP filesystem write to verdicts.jsonl", cc.tool("mcp__filesystem__write_file", (w) => ({ path: rec(w, "verdicts.jsonl"), content: "{}" })), RECORD_FILE),
  // ---- audit records, through the file tools -----------------------------------------------------------------------
  blocked("Write verdicts.jsonl", cc.tool("Write", (w) => ({ file_path: rec(w, "verdicts.jsonl"), content: "{}\n" })), RECORD_FILE),
  blocked("Edit draws.json", cc.tool("Edit", (w) => ({ file_path: rec(w, "draws.json"), old_string: "{}", new_string: '{"draws":[]}' })), RECORD_FILE),
  blocked("MultiEdit registration.json", cc.tool("MultiEdit", (w) => ({ file_path: rec(w, "registration.json"), edits: [{ old_string: "{}", new_string: "{ }" }] })), RECORD_FILE),
  blocked("Write manifest-commitment.json", cc.tool("Write", (w) => ({ file_path: rec(w, "manifest-commitment.json"), content: "{}" })), RECORD_FILE),
  blocked("Edit <window>.manifest.json", cc.tool("Edit", (w) => ({ file_path: join(w.audit, "audit", "2026-q3.manifest.json"), old_string: "{}", new_string: "{ }" })), RECORD_FILE),
  blocked("Write ledger-index.json", cc.tool("Write", (w) => ({ file_path: rec(w, "ledger-index.json"), content: "{}" })), RECORD_FILE),
  blocked("Write ledger-publication.json", cc.tool("Write", (w) => ({ file_path: rec(w, "ledger-publication.json"), content: "{}" })), RECORD_FILE),
  blocked("Edit ledger-checkpoints.jsonl", cc.tool("Edit", (w) => ({ file_path: rec(w, "ledger-checkpoints.jsonl"), old_string: "", new_string: "{}" })), RECORD_FILE),
  blocked("Write a new file under ledger-history/", cc.tool("Write", (w) => ({ file_path: rec(w, "ledger-history/2026-11-05T00-00-00Z.json"), content: "[]" })), RECORD_FILE),
  blocked("Edit pr-rla.lock.json", cc.tool("Edit", (w) => ({ file_path: join(w.audit, "pr-rla.lock.json"), old_string: "{}", new_string: "{ }" })), /plugin lock/),
  blocked("Edit .pr-rla.yml", cc.tool("Edit", (w) => ({ file_path: join(w.audit, ".pr-rla.yml"), old_string: "git-file", new_string: "github-issues" })), /audit configuration/),
  blocked("Write the approvals file (~/.config/pr-rla/approvals.json)", cc.tool("Write", (w) => ({ file_path: join(w.home, ".config", "pr-rla", "approvals.json"), content: "{}" })), /approvals file/),
  blocked("Write the approvals file PR_RLA_APPROVALS_FILE names", withEnv(cc.tool("Write", (w) => ({ file_path: join(w.home, "consent.json"), content: "{}" })), (w) => ({ PR_RLA_APPROVALS_FILE: join(w.home, "consent.json") })), /approvals file/),
  blocked("Write verdicts.jsonl through ../", cc.tool("Write", (w) => ({ file_path: `${join(w.audit, "audit", "2026-q3")}/../2026-q3/verdicts.jsonl`, content: "{}" })), RECORD_FILE),
  blocked("Write Verdicts.JSONL (another case, one file on a case-insensitive disk)", cc.tool("Write", (w) => ({ file_path: rec(w, "Verdicts.JSONL"), content: "{}" })), RECORD_FILE),
  blocked("Write through a symlink to verdicts.jsonl", cc.tool("Write", (w) => ({ file_path: join(w.audit, "notes-link.jsonl"), content: "{}" })), RECORD_FILE),
  blocked("Write a .pr-rla.yml anywhere (a new audit is the person's)", cc.tool("Write", (w) => ({ file_path: join(w.other, "new-audit", ".pr-rla.yml"), content: "ledger: git-file\n" })), /audit configuration/),
  // ---- audit records, through the shell -----------------------------------------------------------------------------
  blocked("echo >> verdicts.jsonl", cc.bash(`echo '{"draw":5,"verdict":"pass"}' >> audit/2026-q3/verdicts.jsonl`), RECORD_FILE),
  blocked("a subshell that cd's into the window first", cc.bash("(cd audit/2026-q3 && echo x >> verdicts.jsonl)"), RECORD_FILE),
  blocked("a redirect through ../ from another project", cc.bash("echo x >> ../audit-repo/audit/2026-q3/verdicts.jsonl", inOther), RECORD_FILE),
  blocked("tee -a verdicts.jsonl", cc.bash("printf 'x\\n' | tee -a audit/2026-q3/verdicts.jsonl"), /tee writes/),
  blocked("mv over draws.json", cc.bash("jq '.draws=[]' audit/2026-q3/draws.json > /tmp/d.json && mv /tmp/d.json audit/2026-q3/draws.json"), /mv moves onto/),
  blocked("cp over registration.json", cc.bash("cp /tmp/forged.json audit/2026-q3/registration.json"), /cp overwrites/),
  blocked("sed -i on verdicts.jsonl", cc.bash("sed -i '' 's/fail/pass/' audit/2026-q3/verdicts.jsonl"), /sed -i edits/),
  blocked("rm -rf the window directory", cc.bash("rm -rf audit/2026-q3"), /holding audit records/),
  blocked("rm with a brace expansion", cc.bash("rm audit/2026-q3/{notes.md,draws.json}"), /rm removes .*draws\.json/),
  blocked("rm with a glob", cc.bash("rm audit/*/verdicts.jsonl"), /rm removes/),
  blocked("a variable that names verdicts.jsonl", cc.bash('F=verdicts.jsonl; echo x > "audit/2026-q3/$F"'), RECORD_FILE),
  blocked("an unknown directory before verdicts.jsonl", cc.bash('echo x > "$AUDIT_DIR/verdicts.jsonl"'), /may be an audit record/),
  blocked("truncate ledger-checkpoints.jsonl", cc.bash("truncate -s 0 audit/2026-q3/ledger-checkpoints.jsonl"), /truncate empties/),
  blocked("ln -sf onto verdicts.jsonl", cc.bash("ln -sf /tmp/forged.jsonl audit/2026-q3/verdicts.jsonl"), /ln writes/),
  blocked("a redirect onto the approvals file through ~", cc.bash("echo '{}' > ~/.config/pr-rla/approvals.json"), /approvals file/),
  blocked("cp onto the approvals file through $HOME", cc.bash('cp mine.json "$HOME/.config/pr-rla/approvals.json"'), /approvals file/),
  blocked("python -c appending to verdicts.jsonl", cc.bash(`python3 -c "open('audit/2026-q3/verdicts.jsonl','a').write('x')"`), /writes a file named like a pr-rla audit record/),
  blocked("node -e appendFileSync to verdicts.jsonl", cc.bash(`node -e "require('fs').appendFileSync('audit/2026-q3/verdicts.jsonl', '{}')"`), /writes a file named like a pr-rla audit record/),
  blocked("git checkout -- verdicts.jsonl", cc.bash("git checkout -- audit/2026-q3/verdicts.jsonl"), /git checkout would change/),
  blocked("git rm draws.json", cc.bash("git rm audit/2026-q3/draws.json"), /git rm would change/),
  blocked("find -name verdicts.jsonl -delete", cc.bash("find audit -name verdicts.jsonl -delete"), /find -delete removes/),
  blocked("dd of=verdicts.jsonl", cc.bash("dd if=/dev/null of=audit/2026-q3/verdicts.jsonl"), /dd writes/),
  blocked("touch draws.json", cc.bash("touch audit/2026-q3/draws.json"), /touch writes/),
  // ---- trying to sneak past --------------------------------------------------------------------------------------------
  blocked("sh -c", cc.bash("sh -c 'pr-rla record 5 pass'"), RECORD),
  blocked("bash -lc with a cd", cc.bash('bash -lc "cd audit && pr-rla record 5 pass"'), RECORD),
  blocked("an env -i prefix", cc.bash("env -i PATH=/usr/bin pr-rla record 5 pass"), RECORD),
  blocked("a VAR=value prefix", cc.bash("FOO=bar pr-rla record 5 pass"), RECORD),
  blocked("quoted words", cc.bash(`"pr-rla" 'record' 5 pass`), RECORD),
  blocked("backslashes inside the words", cc.bash("p\\r-rla rec\\ord 5 pass"), RECORD),
  blocked("ANSI-C quoting with a hex escape", cc.bash("$'pr-rla' $'\\x72ecord' 5 pass"), RECORD),
  blocked("a subshell", cc.bash("(pr-rla record 5 pass)"), RECORD),
  blocked("a command substitution", cc.bash("echo $(pr-rla record 5 pass)"), RECORD),
  blocked("backticks", cc.bash("echo `pr-rla record 5 pass`"), RECORD),
  blocked("xargs supplying the arguments", cc.bash("echo 5 pass | xargs pr-rla record"), /through xargs/),
  blocked("xargs -I running sh -c", cc.bash("echo 5 | xargs -I{} sh -c 'pr-rla record {} pass'"), RECORD),
  blocked("find -exec", cc.bash("find . -name draws.json -exec pr-rla record 1 pass \\;"), RECORD),
  blocked("eval", cc.bash('eval "pr-rla record 5 pass"'), RECORD),
  blocked("a variable holding the program name", cc.bash("P=pr-rla; $P record 5 pass"), RECORD),
  blocked("a computed program name", cc.bash("$(which pr-rla) record 5 pass"), /the command name is computed/),
  blocked("a script piped into sh", cc.bash("echo 'pr-rla record 5 pass' | sh"), RECORD),
  blocked("a heredoc fed to bash", cc.bash("bash <<'EOF'\npr-rla record 5 pass\nEOF"), RECORD),
  blocked("a script file run with bash", cc.bash("bash scripts/sneak.sh"), RECORD),
  blocked("an executable script run directly", cc.bash("./scripts/sneak.sh"), RECORD),
  blocked("a script written and run in one line", cc.bash("printf 'pr-rla record 6 pass\\n' > x.sh && bash x.sh"), RECORD),
  blocked("an npm script", cc.bash("npm run rec"), RECORD),
  blocked("an alias", cc.bash("alias rec='pr-rla record'; rec 5 pass"), RECORD),
  blocked("an if/then block", cc.bash("if true; then pr-rla record 5 pass; fi"), RECORD),
  blocked("a shell function", cc.bash("f() { pr-rla record 5 pass; }; f"), RECORD),
  blocked("timeout and nice wrappers", cc.bash("timeout 30 nice -n 5 pr-rla record 5 pass"), RECORD),
  blocked("sudo -u", cc.bash("sudo -u reviewer pr-rla record 5 pass"), RECORD),
  blocked("a git alias defined with -c", cc.bash("git -c alias.rec='!pr-rla record 5 pass' rec"), RECORD),
  blocked("watch", cc.bash("watch -n 60 pr-rla sample"), /it issues draws/),
  blocked("a chain with && and ||", cc.bash("true && pr-rla checkpoint --push || true"), /checkpoint --push/),
  blocked("a computed pr-rla subcommand", cc.bash("pr-rla $SUB 5 pass"), /subcommand is computed/),
  blocked("a computed argument after a read-only subcommand", cc.bash("pr-rla status $EXTRA"), /computed argument/),
  blocked("--note --help is a note, not help", cc.bash("pr-rla record 5 pass --note --help"), RECORD),
  blocked("node -e running pr-rla record", cc.bash(`node -e "require('child_process').execSync('pr-rla record 5 pass')"`), /runs a pr-rla write command/),
  // ---- git: committing a verdict, rewriting or discarding the audit's history -----------------------------------------
  blocked("git commit with verdicts.jsonl staged", cc.bash('git commit -m "verdict"', inStaged), /git commit would commit audit\/2026-q3\/verdicts\.jsonl/),
  blocked("git add -A && git commit with verdicts.jsonl modified", cc.bash("git add -A && git commit -m wip", inDirty), /git commit would commit/),
  blocked("git commit -am with verdicts.jsonl modified", cc.bash("git commit -am wip", inDirty), /git commit would commit/),
  blocked("git commit --amend over a verdict commit", cc.bash("git commit --amend -m reworded"), /rewrite a commit that holds/),
  blocked("git push --force in an audit repo", cc.bash("git push --force origin main"), /forced or deleting git push/),
  blocked("git push +refspec", cc.bash("git push origin +main"), /forced or deleting git push/),
  blocked("git push --force-with-lease", cc.bash("git push --force-with-lease"), /forced or deleting git push/),
  blocked("git reset --hard with a verdict uncommitted", cc.bash("git reset --hard", inDirty), /would discard an uncommitted change/),
  blocked("git reset --hard HEAD~1 dropping a verdict commit", cc.bash("git reset --hard HEAD~1"), /would drop commits that change audit records/),
  blocked("git stash with a verdict uncommitted", cc.bash("git stash", inDirty), /git stash would take/),
  blocked("git clean -fdx with an untracked record", cc.bash("git clean -fdx", inUntracked), /git clean would delete/),
  blocked("git rebase in an audit repo", cc.bash("git rebase -i HEAD~3"), /rewrites the audit repo's history/),
  blocked("git apply of a patch to verdicts.jsonl", cc.bash("git apply forge.patch"), /git apply would change/),
  blocked("git restore . with a verdict uncommitted", cc.bash("git restore .", inDirty), /would discard an uncommitted change/),
  // ---- the signing key -------------------------------------------------------------------------------------------------
  blocked("Read the signing key", cc.tool("Read", (w) => ({ file_path: join(w.audit, ".pr-rla", "signing-key.pem") })), /signing key/),
  blocked("cat the signing key", cc.bash("cat .pr-rla/signing-key.pem"), /signing key/),
  blocked("a redirect reading the signing key", cc.bash("base64 < .pr-rla/signing-key.pem"), /signing key/),
  // ---- Codex -----------------------------------------------------------------------------------------------------------
  blocked("Codex: Bash pr-rla record", codex.bash("pr-rla record 5 pass"), RECORD),
  blocked("Codex: an argv command (bash -lc …)", codex.bash(["bash", "-lc", "pr-rla record 5 pass"]), RECORD),
  blocked("Codex: apply_patch updating verdicts.jsonl", codex.patch("*** Begin Patch\n*** Update File: audit/2026-q3/verdicts.jsonl\n@@\n+{}\n*** End Patch\n"), RECORD_FILE),
  blocked("Codex: apply_patch moving a file onto draws.json", codex.patch("*** Begin Patch\n*** Update File: notes.md\n*** Move to: audit/2026-q3/draws.json\n@@\n-notes\n+{}\n*** End Patch\n"), RECORD_FILE),
  blocked("Codex: apply_patch adding .pr-rla.yml", codex.patch("*** Begin Patch\n*** Add File: sub/.pr-rla.yml\n+ledger: git-file\n*** End Patch\n"), /audit configuration/),
  blocked("Codex: another MCP server's label tool", codex.tool("mcp__github__add_issue_labels", { owner: "o", repo: "audit", issue_number: 12, labels: ["pr-rla:pass"] }), /verdict label/),
  blocked("Codex: gh issue edit --add-label", codex.bash("gh issue edit 3 --add-label pr-rla:pass"), LABEL),
  // ---- Cursor ----------------------------------------------------------------------------------------------------------
  blocked("Cursor: beforeShellExecution pr-rla record", cursor.shell("pr-rla record 5 pass"), RECORD),
  blocked("Cursor: beforeShellExecution curl to …/labels", cursor.shell("curl -X POST https://api.github.com/repos/o/audit/issues/12/labels -d x"), /label endpoint/),
  blocked("Cursor: beforeMCPExecution with a verdict label", cursor.mcp("github", "add_issue_labels", { owner: "o", repo: "audit", issue_number: 12, labels: ["pr-rla:pass"] }), /verdict label/),
  blocked("Cursor: beforeReadFile on the signing key", cursor.read((w) => join(w.audit, ".pr-rla", "signing-key.pem")), /signing key/),
  blocked("Cursor: preToolUse Write verdicts.jsonl", cursor.tool("Write", (w) => ({ file_path: rec(w, "verdicts.jsonl"), contents: "{}" })), RECORD_FILE),
  blocked("Cursor: preToolUse Delete draws.json", cursor.tool("Delete", (w) => ({ path: rec(w, "draws.json") })), RECORD_FILE),
  blocked("Cursor: preToolUse Shell plugin approve", cursor.tool("Shell", () => ({ command: "pr-rla plugin approve ./x.mjs --yes" })), CONSENT),
  blocked("Cursor: preToolUse Write with an undocumented path field", cursor.tool("Write", (w) => ({ target_file: rec(w, "registration.json"), code_edit: "{}" })), RECORD_FILE),

  blocked("yarn running the pr-rla bin", cc.bash("yarn pr-rla record 5 pass"), RECORD),
  blocked("node with a computed script path", cc.bash("node $(which pr-rla) record 5 pass"), /computed/),
  blocked("a computed shell with -c", cc.bash("$SHELL -c 'pr-rla record 5 pass'"), RECORD),
  blocked("eval of a computed string", cc.bash(`eval "$(printf 'pr-rla record 5 pass')"`), /cannot fully read/),
  blocked("sh -c with a computed script", cc.bash('sh -c "$(echo pr-rla record 5 pass)"'), /cannot fully read/),
  blocked("script(1) running pr-rla", cc.bash("script -q /dev/null pr-rla record 5 pass"), RECORD),
  blocked("a wrapper the guard does not know (direnv exec)", cc.bash("direnv exec . pr-rla record 5 pass"), RECORD),
  blocked("an unlisted wrapper handed pr-rla (nix develop -c)", cc.bash("nix develop -c pr-rla record 5 pass"), RECORD),
  blocked("GNU parallel", cc.bash("parallel pr-rla record {} pass ::: 5 6"), RECORD),
  blocked("at reading its job from a pipe", cc.bash("echo 'pr-rla record 5 pass' | at now"), RECORD),
  blocked("GIT_PAGER running pr-rla", cc.bash("GIT_PAGER='pr-rla record 5 pass; cat' git log"), RECORD),
  blocked("git -c core.pager running pr-rla", cc.bash("git -c core.pager='pr-rla record 5 pass' log"), RECORD),
  blocked("git config core.hooksPath in an audit repo", cc.bash("git config core.hooksPath .githooks"), /makes git run a command as you later/),
  blocked("a Makefile recipe running pr-rla record", cc.bash("make rec"), /make would run a recipe/),
  blocked("tar unpacking a record into the window", cc.bash("tar -xf evil.tar -C audit/2026-q3"), /tar would unpack onto audit\/2026-q3\/verdicts\.jsonl/),
  blocked("Write a git hook in the audit repo", cc.tool("Write", (w) => ({ file_path: join(w.audit, ".git", "hooks", "pre-commit"), content: "#!/bin/sh\npr-rla record 1 pass\n" })), /audit repo's git directory/),
  blocked("echo into the audit repo's .git/config", cc.bash("printf '[core]\\n\\tpager = pr-rla record 1 pass\\n' >> .git/config"), /audit repo's git directory/),

  // ==== allowed ==========================================================================================================
  allowed("pr-rla status", cc.bash("pr-rla status")),
  allowed("pr-rla status --offline --json", cc.bash("pr-rla status --offline --json")),
  allowed("pr-rla -C <audit> verify --offline, from another project", cc.bash("pr-rla -C ../audit-repo verify --offline", inOther)),
  allowed("pr-rla draw-context", cc.bash("pr-rla draw-context 7 --json")),
  allowed("pr-rla simulate", cc.bash("pr-rla simulate --population 1590 --defects 159 --runs 2000")),
  allowed("pr-rla plugin check", cc.bash("pr-rla plugin check pr-rla-provider-gitea --offline")),
  allowed("pr-rla checkpoint (local: pr-rla appends its own checkpoint line)", cc.bash("pr-rla checkpoint")),
  allowed("pr-rla status --checkpoint (local)", cc.bash("pr-rla status --checkpoint")),
  allowed("pr-rla record --help", cc.bash("pr-rla record --help")),
  allowed("pr-rla --version", cc.bash("pr-rla --version")),
  allowed("PR_RLA_PLUGINS=builtin-only pr-rla verify", cc.bash("PR_RLA_PLUGINS=builtin-only pr-rla verify --offline")),
  allowed("env -u a token, then pr-rla verify", cc.bash("env -u GITHUB_TOKEN pr-rla verify --offline")),
  allowed("npx pr-rla-mcp --help", cc.bash("npx -y pr-rla-mcp@0.1.0 --help")),
  allowed("cat verdicts.jsonl", cc.bash("cat audit/2026-q3/verdicts.jsonl")),
  allowed("jq on draws.json", cc.bash("jq . audit/2026-q3/draws.json")),
  allowed("copying a record out to /tmp", cc.bash("cp audit/2026-q3/verdicts.jsonl /tmp/verdicts-backup.jsonl")),
  allowed("git status, diff and log", cc.bash("git status && git diff audit/2026-q3/verdicts.jsonl && git log -p -- audit/")),
  allowed("git add verdicts.jsonl (staging only; committing it is blocked)", cc.bash("git add audit/2026-q3/verdicts.jsonl", inDirty)),
  allowed("git commit of an unrelated file", cc.bash('git commit -m "notes" -- notes.md', inNotes)),
  allowed("git push", cc.bash("git push origin main")),
  allowed("git push --force outside an audit repo", cc.bash("git push --force origin main", inOther)),
  allowed("git checkout -b", cc.bash("git checkout -b review-notes")),
  allowed("gh issue edit with another label", cc.bash("gh issue edit 12 --add-label bug")),
  allowed("gh issue view", cc.bash("gh issue view 12 --json labels")),
  allowed("gh api GET of the labels", cc.bash("gh api repos/o/audit/issues/12/labels")),
  allowed("gh api GET of the events", cc.bash("gh api repos/o/audit/issues/12/events --paginate")),
  allowed("gh api graphql, a query", cc.bash(`gh api graphql -f query='query { repository(owner: "o", name: "r") { labels(first: 5) { nodes { name } } } }'`)),
  allowed("curl GET of the labels", cc.bash("curl -s https://api.github.com/repos/o/audit/issues/12/labels")),
  allowed("curl POST elsewhere", cc.bash(`curl -X POST https://example.com/api/build -d '{"ok":true}'`)),
  allowed("ssh-keygen -Y verify in pr-rla's namespace", cc.bash("ssh-keygen -Y verify -f allowed_signers -I alice -n pr-rla-verdict@v1 -s v.sig < v.txt")),
  allowed("ssh-keygen -Y sign in another namespace", cc.bash("ssh-keygen -Y sign -n git -f ~/.ssh/id_ed25519 commit.txt")),
  allowed("grep for the record command", cc.bash('grep -rn "pr-rla record" docs/')),
  allowed("echo telling the person what to run", cc.bash('echo "When you are ready, run: pr-rla record 5 pass --reviewer you"')),
  allowed("a redirect to /tmp", cc.bash("echo hi > /tmp/scratch.txt")),
  allowed("npm test", cc.bash("npm test")),
  allowed("an npm script running pr-rla status", cc.bash("npm run st")),
  allowed("a script file running pr-rla status", cc.bash("bash scripts/harmless.sh")),
  allowed("node -e reading draws.json", cc.bash(`node -e "console.log(require('fs').readFileSync('audit/2026-q3/draws.json','utf8').length)"`)),
  allowed("rm -rf a cache directory", cc.bash("rm -rf node_modules/.cache")),
  allowed("find -delete of other files", cc.bash("find . -name '*.tmp' -delete")),
  allowed("Write notes.md in the audit repo", cc.tool("Write", (w) => ({ file_path: join(w.audit, "notes.md"), content: "x" }))),
  allowed("Write registration.json outside an audit repo", cc.tool("Write", (w) => ({ file_path: join(w.other, "src", "registration.json"), content: "{}" }), inOther)),
  allowed("Edit review-protocol.md (not an audit record; verify's check 1 catches a change)", cc.tool("Edit", (w) => ({ file_path: join(w.audit, "review-protocol.md"), old_string: "#", new_string: "##" }))),
  allowed("Read verdicts.jsonl", cc.tool("Read", (w) => ({ file_path: rec(w, "verdicts.jsonl") }))),
  allowed("pr-rla's own MCP tool, draw_context", cc.tool("mcp__plugin_pr-rla_pr-rla__draw_context", () => ({ draw: 7 }))),
  allowed("another MCP server's label tool with another label", cc.tool("mcp__github__add_issue_labels", () => ({ owner: "o", repo: "audit", issue_number: 12, labels: ["needs-review"] }))),
  allowed("an MCP comment mentioning the labels", cc.tool("mcp__github__add_issue_comment", () => ({ owner: "o", repo: "audit", issue_number: 12, body: "Draw 7 waits for its pr-rla:pass or pr-rla:fail label from the reviewer." }))),
  allowed("yarn test (a script)", cc.bash("yarn test")),
  allowed("make outside an audit repo", cc.bash("make build", inOther)),
  allowed("tar listing an archive", cc.bash("tar -tf evil.tar")),
  allowed("tar unpacking outside the audit repo", cc.bash("tar -xf safe.tar -C ../web-app")),
  allowed("git config user.email in an audit repo", cc.bash("git config user.email reviewer@example.com")),
  allowed("GIT_PAGER=cat git log", cc.bash("GIT_PAGER=cat git log --oneline")),
  allowed("Codex: Bash pr-rla verify", codex.bash("pr-rla verify --offline")),
  allowed("Codex: apply_patch on a source file", codex.patch("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch\n")),
  allowed("Codex: pr-rla's own MCP tool", codex.tool("mcp__pr-rla__draws", { limit: 10 })),
  allowed("Cursor: beforeShellExecution pr-rla status", cursor.shell("pr-rla status")),
  allowed("Cursor: beforeMCPExecution pr-rla draws", cursor.mcp("pr-rla", "draws", {})),
  allowed("Cursor: beforeReadFile review-protocol.md", cursor.read((w) => join(w.audit, "review-protocol.md"))),
  allowed("Cursor: preToolUse Write notes.md", cursor.tool("Write", (w) => ({ file_path: join(w.audit, "notes.md"), contents: "x" }))),
];

/** Runs guard.mjs as the client would: the payload on stdin, the client flag, the environment. */
function runHook(payload: unknown, client: Client, env: Env, extra: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [GUARD, "--client", client, ...extra], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", fail);
    p.on("close", (code) => done({ code, stdout, stderr }));
    p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

beforeAll(async () => {
  guard = (await import(pathToFileURL(GUARD).href)) as GuardModule;
  w = makeWorld();
});

describe("guard.mjs: the case list", () => {
  it("has at least 10 blocked and 10 allowed cases, each named once, for every client", () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const count = (client: Client, block: boolean) => cases.filter((c) => c.make(w).client === client && Boolean(c.block) === block).length;
    expect(count("claude-code", true)).toBeGreaterThanOrEqual(10);
    expect(count("claude-code", false)).toBeGreaterThanOrEqual(10);
    expect(count("codex", true) + count("cursor", true)).toBeGreaterThanOrEqual(10);
    expect(count("codex", false) + count("cursor", false)).toBeGreaterThanOrEqual(5);
  });
});

describe("guard.mjs: each case, decided in process", () => {
  for (const c of cases) {
    it(`${c.block ? "blocks" : "allows"}: ${c.name}`, () => {
      const m = c.make(w);
      const r = guard.evaluate(m.payload, { client: m.client, env: m.env ?? w.env });
      if (c.block) {
        expect(r.decision, `no reason given for ${c.name}`).toBe("block");
        expect(r.reasons.join("\n")).toMatch(c.block);
      } else expect(r.reasons).toEqual([]);
      // The client guessed from the payload is the one the case is written for.
      expect(guard.detectClient(m.payload)).toBe(m.client);
    });
  }
});

describe.concurrent("guard.mjs: each case, through the hook process", () => {
  for (const c of cases) {
    it(`${c.block ? "exits 2" : "exits 0"}: ${c.name}`, async () => {
      const m = c.make(w);
      const r = await runHook(m.payload, m.client, m.env ?? w.env);
      if (c.block) {
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/^pr-rla guard blocked this: /);
        expect(r.stderr).toMatch(c.block);
        if (m.client === "cursor") expect(JSON.parse(r.stdout)).toMatchObject({ permission: "deny", agent_message: expect.stringMatching(c.block) });
        else expect(r.stdout).toBe("");
      } else {
        expect(r.code, r.stderr).toBe(0);
        expect(r.stderr).toBe("");
        if (m.client === "cursor") expect(JSON.parse(r.stdout)).toEqual({ permission: "allow" });
        else expect(r.stdout).toBe("");
      }
    });
  }
});

describe("guard.mjs: the hook protocol", () => {
  it("fails closed: input it cannot read is blocked, in every client's form", async () => {
    for (const client of ["claude-code", "codex", "cursor"] as const) {
      const r = await runHook("{not json", client, w.env);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not a JSON object; the guard blocks what it cannot read/);
      if (client === "cursor") expect(JSON.parse(r.stdout).permission).toBe("deny");
    }
  });

  it("guesses the client from the payload when --client is not given", () => {
    expect(guard.detectClient(template("claude-code-pretooluse.json"))).toBe("claude-code");
    expect(guard.detectClient(template("codex-pretooluse.json"))).toBe("codex");
    expect(guard.detectClient(template("cursor-before-shell-execution.json"))).toBe("cursor");
    expect(guard.detectClient(template("cursor-pretooluse.json"))).toBe("cursor");
    expect(guard.detectClient(null)).toBe("claude-code");
  });

  it("--record saves the payload as received and does not change the decision", async () => {
    const dir = join(w.base, "recorded-payloads");
    const m = cc.bash("pr-rla record 5 pass")(w);
    const r = await runHook(m.payload, "claude-code", w.env, ["--record", dir]);
    expect(r.code).toBe(2);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude-code-PreToolUse-Bash-.*\.json$/);
    expect(JSON.parse(readFileSync(join(dir, files[0]!), "utf8"))).toEqual(m.payload);
  });

  it("--check-shell prints the decision for a command (for a person checking the guard by hand)", () => {
    const run = (cmd: string) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [GUARD, "--check-shell", cmd, "--cwd", w.audit], { encoding: "utf8", env: w.env as NodeJS.ProcessEnv }) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };
    expect(run("pr-rla status")).toEqual({ code: 0, out: "allowed\n" });
    const b = run("pr-rla record 1 pass");
    expect(b.code).toBe(2);
    expect(b.out).toMatch(/^blocked:\n {2}- pr-rla record writes a verdict/);
  });

  it("refuses an unknown --client and an unknown argument", async () => {
    const r1 = spawn(process.execPath, [GUARD, "--client", "vscode"]);
    const code1 = await new Promise((d) => r1.on("close", d));
    expect(code1).toBe(2);
    const r2 = spawn(process.execPath, [GUARD, "--nope"]);
    const code2 = await new Promise((d) => r2.on("close", d));
    expect(code2).toBe(2);
  });

  it("renders a block in each client's documented form (exit 2; stderr; Cursor's permission JSON)", () => {
    const block = { decision: "block" as const, reasons: ["x"] };
    expect(guard.render({ ...block, client: "claude-code" })).toEqual({ exitCode: 2, stdout: "", stderr: expect.stringMatching(/^pr-rla guard blocked this: x\./) });
    expect(guard.render({ ...block, client: "codex" }).exitCode).toBe(2);
    const cur = guard.render({ ...block, client: "cursor" });
    expect(cur.exitCode).toBe(2);
    expect(JSON.parse(cur.stdout)).toMatchObject({ permission: "deny", user_message: "pr-rla guard blocked this: x." });
    expect(guard.render({ client: "claude-code", decision: "allow", reasons: [] })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("has no dependencies: it imports Node's built-ins only, so it can be copied as one file", () => {
    const src = readFileSync(GUARD, "utf8");
    const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
    expect(src).not.toMatch(/\brequire\(|import\(/);
  });
});
