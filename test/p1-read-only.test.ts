import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as read from "pr-rla/api/read";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { closeAllPluginHosts } from "../src/plugins/host.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { lockPlugin } from "./helpers/plugin-lock.js";

/**
 * P1, read-only contexts (master-plugins-review #7): the CLI's verify, status and freeze --dry-run run on a
 * read-only AuditContext and broker, as pr-rla/api/read does for the MCP server, for the same person (their
 * approvals and grants). A ledger that tries to write while verify or status reads it is refused by the broker
 * before anything is sent; `record`, a write, still reaches the tracker under the ledger's writePaths.
 * Synthetic: an isolated plugin and a fake tracker at tracker.example.
 */
afterAll(() => closeAllPluginHosts());

const W = "audit/2026-q3";

/** An isolated ledger that sends a POST under its own writePaths whenever it is read (what the review's finding allows). */
const POSTER = `export default {
  ledgerApiVersion: 1, name: "poster", provenance: "self-asserted",
  hosts: () => ["tracker.example"],
  writePaths: () => ["tracker.example/api/"],
  create: (_o, ctx) => ({
    apiVersion: 1, name: "poster",
    readVerdicts: async () => {
      await ctx.fetch("https://tracker.example/api/verdicts", { method: "POST", headers: { "content-type": "application/json" }, body: "{\\"read\\":true}", destination: "scm", idempotent: false });
      return [];
    },
    appendVerdict: async (e) => {
      await ctx.fetch("https://tracker.example/api/verdicts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draw: e.draw }), destination: "scm", idempotent: false });
    },
  }),
};
`;

/** An isolated provider that tries a POST to its declared host while listing, and reports what the broker said. */
const PROBE = `export default {
  providerApiVersion: 1, name: "probe",
  hosts: () => ["probe.example"],
  create(options, ctx) {
    return {
      apiVersion: 1, name: "probe",
      async listChanges(req) {
        let said = "sent";
        try { await ctx.fetch("https://probe.example/api/write", { method: "POST", body: "x", destination: "scm", idempotent: false }); } catch (e) { said = String(e && e.message); }
        const o = Date.parse(req.window.opensAt), c = Date.parse(req.window.closesAt);
        return { changes: (options.changes ?? []).filter((x) => req.kinds.includes(x.kind) && Date.parse(x.mergedAt) >= o && Date.parse(x.mergedAt) < c), defaultBranch: "main", limitations: ["broker said: " + said] };
      },
    };
  },
};
`;

function trackerAudit(): Scenario & { posts: string[] } {
  const posts: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://tracker.example/")) return globalThis.fetch(input, init);
    if ((init?.method ?? "GET").toUpperCase() !== "GET") posts.push(`${init?.method} ${url} ${String(init?.body ?? "")}`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const s = setupAuditRepo({ changes: makeChanges(200), fetch: fake });
  mkdirSync(join(s.dir, "plugins", "poster"), { recursive: true });
  writeFileSync(join(s.dir, "plugins", "poster", "package.json"), JSON.stringify({ name: "poster-ledger", version: "0.0.1", type: "module" }));
  writeFileSync(join(s.dir, "plugins", "poster", "index.mjs"), POSTER);
  writeFileSync(join(s.dir, ".pr-rla.yml"), `${readFileSync(join(s.dir, ".pr-rla.yml"), "utf8")}ledger: { use: ./plugins/poster/index.mjs }\n`);
  return Object.assign(s, { posts });
}

async function cli(s: Scenario, args: string[], extra: Partial<CommandContext> = {}): Promise<{ code: number; out: string[] }> {
  let code = -1;
  const from = s.out.length;
  await buildProgram(() => ({ ...s.ctx, ...extra }), (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
  return { code, out: s.out.slice(from) };
}

describe("verify and status never let a ledger write (master-plugins-review #7)", () => {
  it("record (a write) reaches the tracker under the ledger's writePaths; verify and status, reading the same ledger, send nothing", async () => {
    const s = trackerAudit();
    await lockPlugin(s.dir, "./plugins/poster/index.mjs", { kind: "ledger", approve: true });
    expect((await cli(s, ["register"])).code).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect((await cli(s, ["freeze"])).code).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    expect((await cli(s, ["sample", "--through", "1"])).code).toBe(0);
    s.posts.length = 0;
    // The control: a write command runs read-write, so the ledger's POST under its writePaths is sent.
    const rec = await cli(s, ["record", "1", "pass", "--reviewer", "alice"]);
    expect(rec.code).toBe(0);
    expect(s.posts).toEqual(['POST https://tracker.example/api/verdicts {"read":true}', 'POST https://tracker.example/api/verdicts {"draw":1}']);
    s.posts.length = 0;
    // verify: before P1 the CLI opened a read-write broker, and this POST reached tracker.example.
    const v = await cli(s, ["verify"]);
    expect(s.posts).toEqual([]);
    expect(v.out.join("\n")).toMatch(/ledger poster: readVerdicts failed: .*read-only: POST tracker\.example\/api\/verdicts refused/);
    expect(v.code).toBe(1);
    // status: the same, and it says why.
    const st = await cli(s, ["status"]);
    expect(s.posts).toEqual([]);
    expect(st.code).toBe(1);
    expect(st.out.join("\n")).toMatch(/read-only: POST tracker\.example\/api\/verdicts refused/);
    // `status --checkpoint`'s status part is read-only too (the checkpoint, a write, is its own command).
    expect(s.posts).toEqual([]);
  });

  it("the read API is unchanged: an assistant's context, with the same refusal", async () => {
    const s = trackerAudit();
    await lockPlugin(s.dir, "./plugins/poster/index.mjs", { kind: "ledger", approve: true });
    expect((await cli(s, ["register"])).code).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect((await cli(s, ["freeze"])).code).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    expect((await cli(s, ["sample", "--through", "1"])).code).toBe(0);
    s.posts.length = 0;
    const r = await read.verify({ dir: s.dir, offline: false }, { fetch: s.fetch, nowMs: () => s.clock.now });
    expect(s.posts).toEqual([]);
    expect(r.checks.find((c) => c.n === 7)!.status).toBe("FAIL");
    // An assistant reads the result: check 7 says pr-rla's words, and what came back through the plugin is in untrusted.errors.
    expect(r.checks.find((c) => c.n === 7)!.details.join("\n")).toMatch(/readVerdicts failed: .*what it said is in untrusted\.errors\[0\]/);
    expect(r.untrusted?.errors).toEqual([expect.stringMatching(/read-only: POST tracker\.example\/api\/verdicts refused/)]);
  });
});

describe("freeze --dry-run runs read-only", () => {
  it("a provider's POST in a dry run is refused by the read-only broker, not only by the provider rule of a read-write one", async () => {
    const changes = makeChanges(6);
    const s = setupAuditRepo({ changes, provider: `{ use: ./plugins/probe/index.mjs, options: ${JSON.stringify({ changes })} }` });
    mkdirSync(join(s.dir, "plugins", "probe"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "probe", "package.json"), JSON.stringify({ name: "probe-provider", version: "0.0.1", type: "module" }));
    writeFileSync(join(s.dir, "plugins", "probe", "index.mjs"), PROBE);
    await lockPlugin(s.dir, "./plugins/probe/index.mjs", { options: { changes }, approve: true });
    s.clock.now = T("2026-10-20T12:00:00Z");
    const d = await cli(s, ["freeze", "--dry-run"]);
    expect(d.code).toBe(0);
    // A read-write broker would add "provider requests are always read-only" (src/net/broker.ts); the read-only one refuses every non-read.
    const said = d.out.find((l) => l.includes("broker said:"))!;
    expect(said).toMatch(/broker said: read-only: POST probe\.example\/api\/write refused \(/);
    expect(said).not.toMatch(/provider requests are always read-only/);
  });
});
