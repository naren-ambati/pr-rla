import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditContext, openLedger, openProvider } from "../src/api/context.js";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { BUILTIN_LEDGERS, BUILTIN_PROVIDERS } from "../src/registry.js";
import { classificationScenario, fakeGitHub } from "./helpers/fake-github.js";
import { setupAuditRepo } from "./helpers/audit-scenario.js";

/**
 * Finding 1 for built-in providers and ledgers (the coordinator's addition to the fix round): a
 * third party's .pr-rla.yml chooses `token_env` and `base_url`, so a verifier's GITHUB_TOKEN, or any
 * secret named in `token_env`, went to whatever host the repo named. A built-in's credential use is
 * now a grant of (env var, origin): the services' own defaults are pre-approved, anything else needs
 * a local approval (or --accept-lock-grants), and is otherwise withheld, so the built-in runs
 * anonymously and one line names the approval command.
 *
 * Only pre-fix APIs are imported at the top, so the reproductions also run (and fail) before the fix.
 */
const approvals = () => import("../src/plugins/approvals.js");

const sc = classificationScenario();
const REQ = { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] as ("pull_request" | "direct_push")[] };
const machine = () => join(mkdtempSync(join(tmpdir(), "prrla-builtin-")), "approvals.json");

interface Seen {
  url: string;
  authorization: string | null;
}

/** A fake GitHub (github.com, or a GHES-shaped host at `restBase`) that records what reached it. */
function github(restBase?: string) {
  const fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, restBase ? { restBase } : {});
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return fake.fetch(input as never, init as never);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function context(env: Record<string, string>, fetch: typeof globalThis.fetch, o: { acceptLockGrants?: boolean; file?: string } = {}) {
  const logs: string[] = [];
  const ctx = createAuditContext({ mode: "read-only", env, fetch, log: (l) => logs.push(l), sleep: async () => {}, approvalsFile: o.file ?? machine(), ...(o.acceptLockGrants ? { acceptLockGrants: true } : {}) });
  return { ctx, logs };
}

const hostsOf = (seen: Seen[]) => [...new Set(seen.map((s) => new URL(s.url).host))];
const auths = (seen: Seen[]) => [...new Set(seen.map((s) => s.authorization))];

describe("built-in providers: the repo's config cannot send your token elsewhere", () => {
  it("the default github path still works with no approval: GITHUB_TOKEN reaches api.github.com only", async () => {
    const gh = github();
    const { ctx, logs } = context({ GITHUB_TOKEN: "ghp_MINE" }, gh.fetch);
    const p = await openProvider(ctx, { use: "github", options: {} }, ".");
    const r = await p.listChanges(REQ);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(hostsOf(gh.seen)).toEqual(["api.github.com"]);
    expect(auths(gh.seen)).toEqual(["Bearer ghp_MINE"]);
    expect(logs).toEqual([]);
  });

  it("a repo config pointing base_url at an attacker host gets no token; the provider runs anonymously and says how to approve", async () => {
    const evil = github("https://attacker.example/api/v3");
    const { ctx, logs } = context({ GITHUB_TOKEN: "ghp_MINE", GH_TOKEN: "gho_MINE", GH_ENTERPRISE_TOKEN: "ghe_MINE" }, evil.fetch);
    const p = await openProvider(ctx, { use: "github", options: { base_url: "https://attacker.example" } }, ".");
    expect((await p.listChanges(REQ)).changes.length).toBeGreaterThan(0);
    // Before the fix: "Bearer ghp_MINE" on every request to attacker.example.
    expect(hostsOf(evil.seen)).toEqual(["attacker.example"]);
    expect(auths(evil.seen)).toEqual([null]);
    expect(logs).toEqual(["provider github: GITHUB_TOKEN -> https://attacker.example; GH_TOKEN -> https://attacker.example; GH_ENTERPRISE_TOKEN -> https://attacker.example are not approved on this machine, so withheld (the provider runs without them); to approve: pr-rla plugin approve github"]);
  });

  it("a repo config with token_env: AWS_SECRET_ACCESS_KEY gets nothing sent; your GITHUB_TOKEN still goes to api.github.com", async () => {
    const alone = github();
    const a = context({ AWS_SECRET_ACCESS_KEY: "AWS_SECRET" }, alone.fetch);
    await (await openProvider(a.ctx, { use: "github", options: { token_env: "AWS_SECRET_ACCESS_KEY" } }, ".")).listChanges(REQ);
    // Before the fix: "Bearer AWS_SECRET" to api.github.com.
    expect(auths(alone.seen)).toEqual([null]);
    expect(a.logs).toEqual(["provider github: AWS_SECRET_ACCESS_KEY -> https://api.github.com is not approved on this machine, so withheld (the provider runs without it); to approve: pr-rla plugin approve github"]);
    const both = github();
    const b = context({ AWS_SECRET_ACCESS_KEY: "AWS_SECRET", GITHUB_TOKEN: "ghp_MINE" }, both.fetch);
    await (await openProvider(b.ctx, { use: "github", options: { token_env: "AWS_SECRET_ACCESS_KEY" } }, ".")).listChanges(REQ);
    expect(auths(both.seen)).toEqual(["Bearer ghp_MINE"]);
  });

  it("a graphql_url elsewhere withholds the token from both endpoints (one grant covers every origin it goes to)", async () => {
    const gh = github();
    const { ctx, logs } = context({ GITHUB_TOKEN: "ghp_MINE" }, gh.fetch);
    await (await openProvider(ctx, { use: "github", options: { graphql_url: "https://collector.example/graphql" } }, ".")).listChanges(REQ).catch(() => {});
    expect(gh.seen.filter((s) => s.authorization !== null)).toEqual([]);
    expect(logs[0]).toMatch(/^provider github: GITHUB_TOKEN -> https:\/\/api\.github\.com, https:\/\/collector\.example is not approved/);
  });

  it("an approved GHES works: the token reaches ghe.example.com", async () => {
    const { approveBuiltin } = await approvals();
    const file = machine();
    approveBuiltin(file, "GH_ENTERPRISE_TOKEN", "https://ghe.example.com", "2026-11-04T00:00:00Z");
    const ghe = github("https://ghe.example.com/api/v3");
    const { ctx, logs } = context({ GH_ENTERPRISE_TOKEN: "ghe_MINE" }, ghe.fetch, { file });
    const r = await (await openProvider(ctx, { use: "github", options: { base_url: "https://ghe.example.com" } }, ".")).listChanges(REQ);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(hostsOf(ghe.seen)).toEqual(["ghe.example.com"]);
    expect(auths(ghe.seen)).toEqual(["Bearer ghe_MINE"]);
    expect(logs).toEqual([]);
  });

  it("an http:// base_url never gets a token, even approved or with --accept-lock-grants", async () => {
    const gh = github("http://ghe.example.com/api/v3");
    const { ctx, logs } = context({ GITHUB_TOKEN: "ghp_MINE" }, gh.fetch, { acceptLockGrants: true });
    await (await openProvider(ctx, { use: "github", options: { base_url: "http://ghe.example.com" } }, ".")).listChanges(REQ).catch(() => {});
    expect(gh.seen.length).toBeGreaterThan(0);
    expect(auths(gh.seen)).toEqual([null]);
    expect(logs).toEqual(["provider github: GITHUB_TOKEN -> http://ghe.example.com (not https) is not approved on this machine, so withheld (the provider runs without it); to approve: pr-rla plugin approve github"]);
    const { approveBuiltin } = await approvals();
    expect(() => approveBuiltin(machine(), "GITHUB_TOKEN", "http://ghe.example.com", "x")).toThrow(/approved only for an https origin/);
  });

  it("--accept-lock-grants takes the config's grant for the run, and says so", async () => {
    const ghe = github("https://ghe.example.com/api/v3");
    const { ctx, logs } = context({ GITHUB_TOKEN: "ghp_MINE" }, ghe.fetch, { acceptLockGrants: true });
    await (await openProvider(ctx, { use: "github", options: { base_url: "https://ghe.example.com" } }, ".")).listChanges(REQ);
    expect(auths(ghe.seen)).toEqual(["Bearer ghp_MINE"]);
    expect(logs).toEqual(["provider github: accepting GITHUB_TOKEN -> https://ghe.example.com from .pr-rla.yml for this run, not approved on this machine; --accept-lock-grants is only for a repo you control"]);
  });

  it("GitLab and Bitbucket Cloud: their own public APIs are defaults; a self-managed host or another api_url needs approval", async () => {
    const recordAll = () => {
      const seen: Seen[] = [];
      const fetch = (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch;
      return { seen, fetch };
    };
    const cases: [string, Record<string, unknown>, Record<string, string>, string | null][] = [
      ["gitlab", {}, { GITLAB_TOKEN: "glpat" }, "Bearer glpat"],
      ["gitlab", { base_url: "https://gitlab.attacker.example" }, { GITLAB_TOKEN: "glpat" }, null],
      ["bitbucket-cloud", {}, { BITBUCKET_TOKEN: "bbtok", BITBUCKET_USERNAME: "me@example.com" }, `Basic ${Buffer.from("me@example.com:bbtok").toString("base64")}`],
      ["bitbucket-cloud", { api_url: "https://bb.attacker.example/2.0" }, { BITBUCKET_TOKEN: "bbtok" }, null],
      ["bitbucket-data-center", { base_url: "https://bitbucket.attacker.example" }, { BITBUCKET_DC_TOKEN: "dctok" }, null],
    ];
    for (const [use, options, env, expected] of cases) {
      const t = recordAll();
      const { ctx } = context(env, t.fetch);
      await (await openProvider(ctx, { use, options }, ".")).listChanges({ repo: "acme/widgets", window: sc.window, kinds: ["pull_request"] }).catch(() => {});
      expect(t.seen.length, `${use} ${JSON.stringify(options)}`).toBeGreaterThan(0);
      expect(auths(t.seen), `${use} ${JSON.stringify(options)}`).toEqual([expected]);
    }
  });
});

describe("built-in ledgers follow the same rule", () => {
  it("github-issues with base_url at an attacker host reads anonymously; gitlab-issues on gitlab.com keeps GITLAB_TOKEN", async () => {
    const seen: Seen[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), "prrla-builtin-ledger-"));
    const logs: string[] = [];
    // Read-write, as `sample` publishes draws: the ledger's first requests look its labels up.
    const ctx = createAuditContext({ mode: "read-write", env: { GITHUB_TOKEN: "ghp_MINE", GITLAB_TOKEN: "glpat" }, fetch, log: (l) => logs.push(l), sleep: async () => {}, approvalsFile: machine() });
    const draws = [{ draw: 1, changeId: "github:corp/app#1", url: "https://github.com/corp/app/pull/1", mergeSha: "a".repeat(40), firstOccurrence: true }];
    const pub = { window: "w", protocolSha256: "ab".repeat(32), registrationSha256: "cd".repeat(32), repo: "corp/app" };
    await (await openLedger(ctx, { use: "github-issues", options: { repo: "corp/audit", base_url: "https://attacker.example" } }, dir, dir)).publishDraws!(draws, pub).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(hostsOf(seen)).toEqual(["attacker.example"]);
    expect(seen.every((s) => s.authorization === null)).toBe(true);
    expect(logs).toEqual(["ledger github-issues: GITHUB_TOKEN -> https://attacker.example is not approved on this machine, so withheld (the ledger runs without it); to approve: pr-rla plugin approve github-issues"]);
    seen.length = 0;
    const dir2 = mkdtempSync(join(tmpdir(), "prrla-builtin-ledger-"));
    await (await openLedger(ctx, { use: "gitlab-issues", options: { project: "acme/audit" } }, dir2, dir2)).publishDraws!(draws, pub).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.authorization === "Bearer glpat")).toBe(true);
  });
});

describe("pr-rla plugin approve for built-ins", () => {
  const cli = async (dir: string, args: string[], env: Record<string, string>, transport?: typeof fetch) => {
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    const ctx: CommandContext = { cwd: dir, env, nowMs: () => Date.parse("2026-11-04T00:00:00Z"), fetch: transport ?? ((async () => new Response("{}")) as unknown as typeof fetch), out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {} };
    await buildProgram(() => ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
    return { code, out, err };
  };

  it("approves what this audit's GHES config would send, after showing it; the next run sends the token", async () => {
    const s = setupAuditRepo({ changes: [], provider: "{ use: github, options: { base_url: https://ghe.example.com } }" });
    const file = machine();
    const env = { GITHUB_TOKEN: "ghp_MINE", PR_RLA_APPROVALS_FILE: file };
    const noTty = await cli(s.dir, ["plugin", "approve", "github"], env);
    expect(noTty.code).toBe(1);
    expect(noTty.out).toEqual(["provider github (built in) with this audit's options would send:", "  GITHUB_TOKEN -> https://ghe.example.com"]);
    expect(noTty.err.join("\n")).toMatch(/needs your confirmation/);
    const yes = await cli(s.dir, ["plugin", "approve", "github", "--yes"], env);
    expect(yes.out.at(-1)).toBe(`approved GITHUB_TOKEN -> https://ghe.example.com for built-in providers and ledgers on this machine (${file})`);
    expect((await cli(s.dir, ["plugin", "approve", "github"], env)).out.at(-1)).toBe("nothing to approve for github");
    const ghe = github("https://ghe.example.com/api/v3");
    const { ctx } = context({ GITHUB_TOKEN: "ghp_MINE" }, ghe.fetch, { file });
    await (await openProvider(ctx, { use: "github", options: { base_url: "https://ghe.example.com" } }, ".")).listChanges(REQ);
    expect(auths(ghe.seen)).toEqual(["Bearer ghp_MINE"]);
  });

  it("--env and --origin approve one credential for built-ins without an audit repo; only an https origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-no-audit-"));
    const file = machine();
    const ok = await cli(dir, ["plugin", "approve", "--env", "GHE_TOKEN", "--origin", "https://ghe.example.com/", "--yes"], { PR_RLA_APPROVALS_FILE: file });
    expect(ok.out).toEqual(["built-in providers and ledgers may send GHE_TOKEN to https://ghe.example.com", `approved GHE_TOKEN -> https://ghe.example.com for built-in providers and ledgers on this machine (${file})`]);
    const http = await cli(dir, ["plugin", "approve", "--env", "GHE_TOKEN", "--origin", "http://ghe.example.com", "--yes"], { PR_RLA_APPROVALS_FILE: machine() });
    expect(http.code).toBe(1);
    expect(http.err.join("\n")).toMatch(/approved only for an https origin/);
    expect((await cli(dir, ["plugin", "approve", "--env", "GHE_TOKEN"], { PR_RLA_APPROVALS_FILE: file })).err.join("\n")).toMatch(/--env and --origin go together/);
    expect((await cli(dir, ["plugin", "approve", "github"], { PR_RLA_APPROVALS_FILE: file })).err.join("\n")).toMatch(/github is built in, and there is no \.pr-rla\.yml in .*: run "pr-rla plugin approve github" in the audit repo/);
    const ghe = github("https://ghe.example.com/api/v3");
    const { ctx } = context({ GHE_TOKEN: "ghe_MINE" }, ghe.fetch, { file });
    await (await openProvider(ctx, { use: "github", options: { base_url: "https://ghe.example.com", token_env: "GHE_TOKEN" } }, ".")).listChanges(REQ);
    expect(auths(ghe.seen)).toEqual(["Bearer ghe_MINE"]);
    expect(existsSync(file)).toBe(true);
  });
});

describe("the credential table matches what each built-in reads (src/plugins/builtin-credentials.ts)", () => {
  it("every environment variable a built-in reads, for each option shape, is one the table lists", async () => {
    const { builtinCredentialUses } = await import("../src/plugins/builtin-credentials.js");
    const shapes: Record<string, Record<string, unknown>[]> = {
      github: [{}, { base_url: "https://ghe.example.com" }, { token_env: "MY_PAT" }, { api_url: "https://ghe.example.com/api/v3", graphql_url: "https://gql.example.com/q", token_env: "X" }],
      gitlab: [{}, { base_url: "https://gitlab.example.com", token_env: "MY_PAT" }],
      "bitbucket-cloud": [{}, { token_env: "T", username_env: "U", api_url: "https://bb.example/2.0" }],
      "bitbucket-data-center": [{ base_url: "https://bitbucket.example.com" }, { base_url: "https://bitbucket.example.com", token_env: "T" }],
      "json-file": [{ path: "changes.json" }],
      "github-issues": [{ repo: "a/b" }, { repo: "a/b", base_url: "https://ghe.example.com", token_env: "T" }],
      "gitlab-issues": [{ project: "a/b" }, { project: "a/b", base_url: "https://gitlab.example.com", token_env: "T" }],
      "git-file": [{}],
    };
    for (const [name, list] of Object.entries(shapes)) {
      const kind = Object.hasOwn(BUILTIN_PROVIDERS, name) ? "provider" : "ledger";
      for (const options of list) {
        const read = new Set<string>();
        const env = new Proxy({} as Record<string, string | undefined>, { get: (_t, k) => (typeof k === "string" && read.add(k), undefined) });
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "prrla-table-")), windowDir: mkdtempSync(join(tmpdir(), "prrla-table-")), env, log: () => {}, fetch: (async () => new Response("{}")) as unknown as typeof fetch };
        const def = (kind === "provider" ? BUILTIN_PROVIDERS : BUILTIN_LEDGERS)[name]!;
        await def.create(options as never, ctx as never);
        const listed = new Set(builtinCredentialUses(kind, name, options).map((u) => u.env));
        expect([...read].filter((k) => !listed.has(k)), `${name} ${JSON.stringify(options)}`).toEqual([]);
      }
    }
    expect(Object.keys(shapes).sort()).toEqual([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(BUILTIN_LEDGERS)].sort());
  });
});
