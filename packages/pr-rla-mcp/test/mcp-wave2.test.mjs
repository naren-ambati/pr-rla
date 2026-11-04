// The wave-2 integration through the MCP tools themselves (fixture kind: synthetic; nothing recorded).
// bolt/u8-org-pooled-freeze × bolt/u5-audit-api-mcp: a pooled audit frozen with the CLI's functions, then
// read by an in-process pr-rla-mcp: the verify tool returns U8's INCOMPLETE with exit code 6, and
// draw_context serves a pooled draw. The provider is an isolated plugin that lists an org's repos from its
// own code (no network): read-only mode runs it in the plugin host, as the CLI does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createPrRlaMcp } from "../dist/server.js";
import { REPO, body } from "./helpers.mjs";

const dist = (p) => import(pathToFileURL(join(REPO, "dist", p)).href);
const T = (iso) => Date.parse(iso);
const BEACON = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "drand", "quicknet-33245812.json"), "utf8"));
const noNet = async (u) => {
  throw new Error(`no network in this test (${u})`);
};

/** 6 public repos of acme-org; the token cannot be shown to see every private one, so a verifier is INCOMPLETE (U8). */
const PLUGIN = `import { defineProvider } from "pr-rla/provider";
import { createHash } from "node:crypto";
if (process.env.PR_RLA_HOST !== "1") throw new Error("imported outside the plugin host");
const names = Array.from({ length: 6 }, (_, i) => "svc-" + String(i).padStart(2, "0"));
const sha = (s) => createHash("sha1").update(s).digest("hex");
const repoRef = (owner, n, i) => ({ repo: owner + "/" + n, id: String(700 + i), defaultBranch: "main", archived: false, fork: false, visibility: "public" });
export default defineProvider({
  providerApiVersion: 1,
  name: "pooled",
  hosts: () => [],
  populationOptions: [],
  create() {
    return {
      apiVersion: 1,
      name: "pooled",
      async listRepos(rule) { return names.map((n, i) => repoRef(rule.owner, n, i)); },
      async listingVisibility() {
        const pub = { complete: true, reason: "synthetic: every public repository is listed" };
        const no = { complete: false, reason: "synthetic: a fine-grained token, which can be limited to selected repositories" };
        return { identity: "synthetic", visibilities: { public: pub, private: no, internal: no } };
      },
      async describeRepo(ref) {
        const i = names.indexOf(ref.repo.split("/")[1]);
        if (i < 0) throw Object.assign(new Error(ref.repo + ": HTTP 404"), { code: "REPO_UNAVAILABLE", status: 404 });
        return repoRef(ref.repo.split("/")[0], names[i], i);
      },
      async listChanges(req) {
        const idx = Number(req.repo.slice(-2));
        const changes = Array.from({ length: 20 + idx * 4 }, (_, k) => ({
          id: "pooled:" + req.repo + "#" + (k + 1),
          kind: "pull_request",
          repo: req.repo,
          url: "https://example.invalid/" + req.repo + "/pull/" + (k + 1),
          mergeSha: sha(req.repo + k),
          mergedAt: "2026-08-" + String(1 + ((k * 7 + idx) % 27)).padStart(2, "0") + "T10:00:00Z",
          author: { login: "bot[bot]", kind: "bot" },
          mergedBy: { login: "maint", kind: "human" },
          reviews: [],
          changedLines: k + 1,
          labels: [],
        }));
        return { changes, defaultBranch: "main", limitations: [], headSha: sha("head" + req.repo) };
      },
      async describeChange(change) {
        return { changeId: change.id, title: "Change " + change.id, body: "synthetic body of " + change.id, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\\n-a\\n+b\\n" }], gitattributes: null, checks: [], truncated: false };
      },
    };
  },
});
`;

let dir;
let mcp;
let client;
const call = async (name, args = {}) => body(await client.callTool({ name, arguments: args }));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "prrla-mcp-pool-"));
  mkdirSync(join(dir, "plugins", "pooled"), { recursive: true });
  writeFileSync(join(dir, "plugins", "pooled", "package.json"), JSON.stringify({ name: "pooled-provider", version: "0.0.1", type: "module" }));
  writeFileSync(join(dir, "plugins", "pooled", "index.mjs"), PLUGIN);
  writeFileSync(join(dir, "review-protocol.md"), "# Protocol\nA change fails if it introduces a user-visible bug or a security weakness.\n");
  writeFileSync(
    join(dir, ".pr-rla.yml"),
    [
      "provider: { use: ./plugins/pooled/index.mjs, options: {} }",
      "repos: { owner: acme-org, visibility: [public, private] }",
      "window: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }",
      "selector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review }",
      "audit: { p0: 0.10, p1: 0.02, alpha: 0.05 }",
      "timestamping: { authorities: [], min_tokens: 2 }",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".gitignore"), ".pr-rla/\n");
  const git = (...a) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...a], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  // Locked as a person would lock it (the approvals go to the test's temp file: helpers.mjs).
  execFileSync(process.execPath, [join(REPO, "dist", "cli.js"), "plugin", "add", "./plugins/pooled/index.mjs", "--yes"], { cwd: dir, stdio: "ignore" });
  git("add", "-A");
  git("commit", "-qm", "a pooled audit");
  // Registered, frozen and sampled with the CLI's own functions, on a test clock.
  const { nodeContext } = await dist("commands/context.js");
  const { registerCommand } = await dist("commands/register.js");
  const { freezeCommand } = await dist("commands/freeze.js");
  const { sampleCommand } = await dist("commands/sample.js");
  let now = T("2026-10-20T00:00:00Z");
  const ctx = nodeContext({ cwd: dir, env: { PR_RLA_APPROVALS_FILE: process.env.PR_RLA_APPROVALS_FILE }, nowMs: () => now, fetch: noNet, out: () => {}, err: () => {}, beacon: async (round) => (round === BEACON.round ? BEACON : Promise.reject(new Error(`no recorded beacon for ${round}`))) });
  assert.equal(await registerCommand(ctx, {}), 0);
  now = T("2026-10-20T12:00:00Z");
  assert.equal(await freezeCommand(ctx, {}), 0);
  now = T("2026-10-21T01:00:00Z");
  assert.equal(await sampleCommand(ctx, {}), 0);
  git("add", "-A");
  git("commit", "-qm", "registration, manifest, draws");
  mcp = createPrRlaMcp({ roots: [dir], nowMs: () => T("2026-10-21T03:00:00Z"), fetch: noNet, log: () => {}, env: { PR_RLA_APPROVALS_FILE: process.env.PR_RLA_APPROVALS_FILE } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.factory().connect(serverSide);
  client = new Client({ name: "wave2-test", version: "0" });
  await client.connect(clientSide);
});
after(async () => {
  await client?.close();
  await mcp?.close();
});

describe("a pooled audit through the MCP tools (bolt/u8-org-pooled-freeze × bolt/u5-audit-api-mcp)", () => {
  it("verify returns INCOMPLETE with exit code 6 (not ok, never VERIFIED), and says what it could not establish", async () => {
    const r = await call("verify", { offline: false });
    assert.equal(r.verdict, "INCOMPLETE");
    assert.equal(r.exitCode, 6);
    assert.equal(r.ok, false);
    const c5 = r.checks.find((c) => c.n === 5);
    assert.equal(c5.status, "INCOMPLETE");
    assert.match(c5.details.join("\n"), /cannot establish that this token sees every private repository under acme-org/);
    assert.ok(!r.checks.some((c) => c.status === "FAIL"), JSON.stringify(r.checks.map((c) => [c.n, c.status])));
    // The CLI's verify exits 6 on the same audit.
    const { nodeContext } = await dist("commands/context.js");
    const { verifyCommand } = await dist("commands/verify.js");
    const out = [];
    const code = await verifyCommand(nodeContext({ cwd: dir, env: { PR_RLA_APPROVALS_FILE: process.env.PR_RLA_APPROVALS_FILE }, nowMs: () => T("2026-10-21T03:00:00Z"), fetch: noNet, out: (l) => out.push(l), err: () => {} }), {});
    assert.equal(code, 6);
    assert.match(out.at(-1), /^INCOMPLETE: check 5 \(population\) could not be completed; nothing failed, but this is not a verification \(exit 6\)$/);
  });

  it("draw_context serves a pooled draw: its repo-qualified change, the provider's description in the fence", async () => {
    const d = await call("draw_context", { draw: 1 });
    assert.match(d.changeId, /^pooled:acme-org\/svc-0\d#\d+$/);
    assert.match(d.untrusted.title, /^Change pooled:acme-org\/svc-0\d#\d+$/);
    assert.equal(d.state.verdict, "unlabelled");
    assert.match(d.text, new RegExp(d.changeId.replace(/[.*+?^${}()|[\]\\/#]/g, "\\$&")));
    const draws = await call("draws", {});
    assert.ok(new Set(draws.draws.map((x) => x.changeId.replace(/#\d+$/, ""))).size > 1, "the draws span the pool's repos");
  });
});
