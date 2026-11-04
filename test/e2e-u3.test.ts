import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import type { ManifestV2 } from "../src/core/records.js";
import type { ChangeRecord } from "../src/sdk/provider.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";

/**
 * U3 end to end on the json-file provider (and a path-loaded plugin), offline: the registered selector
 * fields are applied at freeze and re-applied by verify, renamed accounts stay the same actor, and
 * population options are part of the stratum.
 */
const W = "audit/2026-q3";
const readJ = <T>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as T;
const at = (s: Scenario, iso: string) => void (s.clock.now = T(iso));
const setSelector = (s: Scenario, selector: string) => {
  const path = join(s.dir, ".pr-rla.yml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^selector: .*$/m, `selector: ${selector}`));
};
const rewriteChanges = (s: Scenario, fix: (c: ChangeRecord) => ChangeRecord) => {
  const path = join(s.dir, "changes.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as { changes: ChangeRecord[] };
  writeFileSync(path, JSON.stringify({ ...file, changes: file.changes.map(fix) }, null, 1));
};
/** makeChanges with stable account ids on every actor (claude[bot] is account 77). */
const withIds = (changes: ChangeRecord[]) => {
  const ids: Record<string, string> = { "claude[bot]": "77", "copilot-swe-agent[bot]": "78", maint: "5", "copilot-pull-request-reviewer[bot]": "79" };
  const id = (a: ChangeRecord["author"]) => (ids[a.login] ? { ...a, id: ids[a.login] } : a);
  return changes.map((c) => ({ ...c, author: c.kind === "pull_request" ? id(c.author) : c.author, mergedBy: c.mergedBy ? id(c.mergedBy) : null, reviews: c.reviews.map((r) => ({ ...r, author: id(r.author) })) }));
};

async function registerAndFreeze(s: Scenario): Promise<ManifestV2> {
  at(s, "2026-10-20T00:00:00Z");
  expect(await registerCommand(s.ctx, {})).toBe(0);
  at(s, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(s.ctx, {})).toBe(0);
  return readJ<ManifestV2>(s, `${W}.manifest.json`);
}

describe("FR7.3: a renamed account stays the same actor in verify (Actor.id)", () => {
  const rename = (c: ChangeRecord) => (c.author.login === "claude[bot]" ? { ...c, author: { ...c.author, login: "claude-code[bot]" } } : c);

  it("with ids, a login renamed after freeze still matches the registered authors; check 5 passes and says so", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)) });
    setSelector(s, '{ kinds: [pull_request, direct_push], authors: ["claude[bot]"], unreviewed: no-human-review }');
    const m = await registerAndFreeze(s);
    expect(m.N).toBeGreaterThan(100);
    expect(m.changes.every((c) => c.author.id === "77")).toBe(true);
    rewriteChanges(s, rename);
    const c5 = (await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("PASS");
    expect(c5.summary).toBe(`population ${m.N}/${m.N} match`);
    expect(c5.details).toContain("1 account(s) renamed since freeze, matched by account id: claude[bot] → claude-code[bot]");
  });

  it("without ids (a phase-2 provider), the same rename drops the account's changes: check 5 fails", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    setSelector(s, '{ kinds: [pull_request, direct_push], authors: ["claude[bot]"], unreviewed: no-human-review }');
    const m = await registerAndFreeze(s);
    rewriteChanges(s, rename);
    const c5 = (await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(new RegExp(`^population: ${m.N} changes in the manifest are not in the rebuilt population`));
  });
});

describe("FR7.1: the registered bot list is signed into the registration and re-applied by verify", () => {
  it("bots: [maint] makes every change merged by maint bot-merged; verify rebuilds the same stratum", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)) });
    setSelector(s, '{ kinds: [pull_request, direct_push], authors: any, unreviewed: any, merged_by: bot, bots: ["maint"] }');
    const m = await registerAndFreeze(s);
    expect(m.selector.bots).toEqual(["maint"]);
    expect(m.N).toBe(360); // the 360 PRs (every 10th generated change is a direct push, which merged_by never matches)
    expect(m.changes.every((c) => c.mergedBy?.kind === "bot" && c.mergedBy.login === "maint")).toBe(true);
    // 360 mergers plus the 40 direct pushes' commit author, also maint.
    expect(m.funnel[1]).toEqual({ step: "actors re-labelled as bot by selector", count: 400 });
    const c5 = (await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("PASS");
  });

  it("the same list by account id (id:5) selects the same changes", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)) });
    setSelector(s, '{ kinds: [pull_request, direct_push], authors: any, unreviewed: any, merged_by: bot, bots: ["id:5"] }');
    expect((await registerAndFreeze(s)).N).toBe(360);
  });
});

describe("FR7.6: direct_push_via_merge on a provider that does not report landedVia", () => {
  it("register warns that exclude has no effect, and the certificate names the choice", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    setSelector(s, "{ kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review, direct_push_via_merge: exclude }");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out.join("\n")).toMatch(/warning: provider json-file does not report landedVia; direct_push_via_merge has no effect/);
  });
});

describe("populationOptions: options that change the population are part of the stratum (check 5)", () => {
  // A path-loaded plugin over changes.json whose `scope` option drops direct pushes; it declares scope as a population option.
  const PLUGIN = `import { readFileSync } from "node:fs";
import { join } from "node:path";
export default {
  providerApiVersion: 1,
  name: "scoped",
  populationOptions: ["scope"],
  create: (o, ctx) => ({
    apiVersion: 1,
    name: "scoped",
    listChanges: async (req) => {
      const all = JSON.parse(readFileSync(join(ctx.cwd, "changes.json"), "utf8")).changes;
      const t = (c) => Date.parse(c.mergedAt);
      const changes = all.filter((c) => t(c) >= Date.parse(req.window.opensAt) && t(c) < Date.parse(req.window.closesAt) && req.kinds.includes(c.kind) && (o.scope !== "prs" || c.kind === "pull_request"));
      return { changes, defaultBranch: "main", limitations: [] };
    },
  }),
};
`;
  const setup = () => {
    const s = setupAuditRepo({ changes: makeChanges(400), provider: "{ use: ./scoped.mjs, options: { scope: all, page_size: 10 } }" });
    writeFileSync(join(s.dir, "scoped.mjs"), PLUGIN);
    return s;
  };

  it("a verifier whose population options differ FAILs check 5; other options do not", async () => {
    const s = setup();
    await registerAndFreeze(s);
    const cfg = join(s.dir, ".pr-rla.yml");
    const original = readFileSync(cfg, "utf8");
    writeFileSync(cfg, original.replace("page_size: 10", "page_size: 50"));
    expect((await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!.status).toBe("PASS");
    writeFileSync(cfg, original.replace("scope: all", "scope: prs"));
    const c5 = (await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(/^population: provider options that change the population differ from the registration \(populationOptionsSha256 [0-9a-f]{12}… ≠ registered [0-9a-f]{12}…\); rebuild with the registered options$/);
  });

  it("freeze refuses population options that differ from the registered ones", async () => {
    const s = setup();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("scope: all", "scope: prs"));
    at(s, "2026-10-20T12:00:00Z");
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/the provider options that change the population \(populationOptions\) differ from the registration .*freeze with the registered options/);
  });
});
