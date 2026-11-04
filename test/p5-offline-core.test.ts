import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as read from "pr-rla/api/read";
import { auditList } from "../src/api/read/audit-list.js";
import { status as apiStatus } from "../src/api/read/status.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import type { DrawsFile, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { ephemeralKey, signRecord } from "../src/core/signing.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5 finding 6 (the second review's status-vs-verify finding, synthetic: json-file changes, mock authorities, the
 * recorded beacon). Before, `status`, `audit_list`, the MCP `status` tool and the CI Action recounted the SPRT over
 * draws.json and showed CERTIFIED for an audit `pr-rla verify` FAILs: a swapped draw, a protocol changed since
 * registration, a manifest that does not match its commitment, a beacon that is not round R's. Now status runs verify's
 * own offline checks 1, 2, 3, 4 and 6 (src/core/verify-core.ts): each FAIL is a FAILED withholding, the certificate is
 * withheld and status exits 1.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let audit: Scenario;
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), `${JSON.stringify(v, null, 2)}\n`);

beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  audit = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  const at = (iso: string) => ((audit.clock.now = T(iso)), (tsa.nowMs = T(iso)));
  at("2026-10-20T00:00:00Z");
  expect(await registerCommand(audit.ctx, {})).toBe(0);
  at("2026-10-20T12:00:00Z");
  expect(await freezeCommand(audit.ctx, {})).toBe(0);
  at("2026-10-21T01:00:00Z");
  expect(await sampleCommand(audit.ctx, {})).toBe(0);
  const draws = readJ<DrawsFile>(audit, `${W}/draws.json`);
  for (const d of draws.draws.slice(0, draws.issued)) if (d.firstOccurrence) await recordCommand(audit.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
  audit.git("add", "-A");
  audit.git("commit", "-qm", "sampled, reviewed");
  at("2026-10-21T03:00:00Z");
}, 120_000);
afterAll(async () => tsa.stop());

/** What each surface says about a clone of the audit: the CLI's status (text and --json), the API's status and audit_list, and verify. */
async function surfaces(s: Scenario) {
  s.out.length = 0;
  const text = await statusCommand(s.ctx, {});
  const textLines = s.out.filter((l) => !l.startsWith("ERR "));
  s.out.length = 0;
  const jsonCode = await statusCommand(s.ctx, { json: true });
  const json = JSON.parse(s.out.filter((l) => !l.startsWith("ERR ")).join("\n")) as { certified: boolean; certificate: { state: string; withheld: { verdict: string; reason: string }[] }; offlineFails: string[] };
  const api = await apiStatus(s.ctx);
  const list = await auditList(s.ctx);
  const v = await runVerify(s.ctx, { offline: true });
  return { text, textLines, jsonCode, json, api, list, v };
}
const check = (v: Awaited<ReturnType<typeof surfaces>>["v"], n: number) => v.checks.find((c) => c.n === n)!;

describe("the honest audit: status certifies, and verify finds nothing to fail", () => {
  it("control: exit 0, certified, no offline check fails", async () => {
    const r = await surfaces(cloneScenario(audit));
    expect(r.text).toBe(0);
    expect(r.json).toMatchObject({ certified: true, certificate: { state: "CERTIFIED", withheld: [] }, offlineFails: [] });
    expect(r.list.windows[0]).toMatchObject({ certified: true });
    expect([1, 2, 3, 4, 6].map((n) => check(r.v, n).status)).not.toContain("FAIL");
  });
});

describe("status never shows CERTIFIED where verify FAILs on what is local", () => {
  const cases: { name: string; n: number; tamper: (s: Scenario) => void }[] = [
    {
      name: "a swapped draws.json entry (two drawn changes trade places, their verdicts rewritten to match): check 6",
      n: 6,
      tamper: (s) => {
        const d = readJ<DrawsFile>(s, `${W}/draws.json`);
        const a = d.draws[0]!;
        const b = d.draws.find((x) => x.firstOccurrence && x.changeId !== a.changeId)!;
        const [ida, idb] = [a.changeId, b.changeId];
        const [fa, fb] = [{ ...a }, { ...b }];
        for (const k of ["index", "changeId", "url", "mergeSha"] as const) Object.assign(a, { [k]: fb[k] }), Object.assign(b, { [k]: fa[k] });
        writeJ(s, `${W}/draws.json`, d);
        // The verdict lines follow the swap, so the sequence still counts them: only the recomputation shows it.
        const ledger = join(s.dir, W, "verdicts.jsonl");
        writeFileSync(ledger, readFileSync(ledger, "utf8").replaceAll(`"${ida}"`, "\u0000A").replaceAll(`"${idb}"`, `"${ida}"`).replaceAll("\u0000A", `"${idb}"`));
        s.git("add", "-A");
        s.git("commit", "-qm", "a swapped draw");
      },
    },
    {
      name: "the review protocol changed after registration: check 1",
      n: 1,
      tamper: (s) => writeFileSync(join(s.dir, "review-protocol.md"), "# Protocol\nA change fails if it is ugly.\n"),
    },
    {
      name: "a manifest edited after its commitment was signed (its own hash left as it was): check 2",
      n: 2,
      tamper: (s) => {
        const m = readJ<Record<string, unknown>>(s, `${W}.manifest.json`);
        m.limitations = [...((m.limitations as string[] | undefined) ?? []), "edited after the commitment"];
        writeJ(s, `${W}.manifest.json`, m);
      },
    },
    {
      name: "the registration re-signed under another key (its tokens still cover its digest): check 1",
      n: 1,
      tamper: (s) => {
        const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
        writeJ(s, `${W}/registration.json`, { ...signRecord(reg.record, ephemeralKey()), timestamps: reg.timestamps });
      },
    },
    {
      name: "draws.json carrying a beacon that is not round R's (the randomness changed): check 4",
      n: 4,
      tamper: (s) => {
        const d = readJ<DrawsFile>(s, `${W}/draws.json`);
        d.beacon.randomness = `${d.beacon.randomness.slice(0, 63)}${d.beacon.randomness.endsWith("0") ? "1" : "0"}`;
        writeJ(s, `${W}/draws.json`, d);
      },
    },
  ];
  for (const c of cases) {
    it(`${c.name}: status FAILED (exit 1), certified false in the CLI, the API and audit_list; verify FAILs check ${c.n}`, async () => {
      const s = cloneScenario(audit);
      c.tamper(s);
      const r = await surfaces(s);
      expect(check(r.v, c.n).status).toBe("FAIL");
      expect(r.v.verdict).toBe("FAILED");
      expect(r.text).toBe(1);
      expect(r.jsonCode).toBe(1);
      expect(r.json.certified).toBe(false);
      expect(r.json.certificate.state).not.toBe("CERTIFIED");
      expect(r.json.certificate.withheld.some((w) => w.verdict === "FAILED" && w.reason.startsWith(`verify check ${c.n} (`))).toBe(true);
      expect(r.json.offlineFails.length).toBeGreaterThan(0);
      expect(r.textLines[0]).not.toMatch(/CERTIFIED \(risk/);
      expect(r.textLines.join("\n")).toMatch(new RegExp(`verify check ${c.n} \\(`));
      expect(r.api.phase === "sampled" && r.api.verdictsRead && r.api.certified).toBe(false);
      expect(r.list.windows[0]!.certified).toBe(false);
    });
  }
});

describe("a registration's time evidence the verifier has no anchor for is unproven, not forged", () => {
  it("a context without the owner's anchors: verify's check 1 and 2 are INCOMPLETE (not FAIL), and status withholds with exit 6, as before P5", async () => {
    const s = cloneScenario(audit);
    s.ctx.tsaTrust = [];
    const v = await runVerify(s.ctx, { offline: true });
    expect([check(v, 1).status, check(v, 2).status]).toEqual(["INCOMPLETE", "INCOMPLETE"]);
    expect(check(v, 1).details.join("\n")).toMatch(/token from test-a not checked: rule 6: authority "test-a" is not in the trust bundle/);
    expect(v.verdict).toBe("INCOMPLETE");
    expect(await statusCommand(s.ctx, {})).toBe(6);
  });
  it("a forged token from an authority the verifier does trust still FAILs check 1", async () => {
    const s = cloneScenario(audit);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const other = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/manifest-commitment.json`) as unknown as { timestamps: typeof reg.timestamps };
    // The commitment's tokens cover another digest: presented as the registration's, they are not its tokens.
    writeJ(s, `${W}/registration.json`, { ...reg, timestamps: other.timestamps });
    const v = await runVerify(s.ctx, { offline: true });
    expect(check(v, 1).status).toBe("FAIL");
    expect(await statusCommand(s.ctx, {})).toBe(1);
  });
});

describe("T14: the registration's full digest, and verify --registration", () => {
  const digest = () => readJ<SignedRecord<RegistrationRecordV2>>(audit, `${W}/registration.json`).sha256;
  it("verify prints the full 64-character digest in check 1 (text and --json)", async () => {
    const s = cloneScenario(audit);
    const v = await runVerify(s.ctx, { offline: true });
    expect(check(v, 1).details).toContain(`registration sha256 ${digest()}`);
    s.out.length = 0;
    await verifyCommand(s.ctx, { offline: true });
    expect(s.out.join("\n")).toContain(`registration sha256 ${digest()}`);
  });
  it("--registration with the digest you were handed: check 1 says so; upper case is folded", async () => {
    const s = cloneScenario(audit);
    for (const given of [digest(), digest().toUpperCase()]) {
      const v = await runVerify(s.ctx, { offline: true, registration: given });
      expect(check(v, 1).status).not.toBe("FAIL");
      expect(check(v, 1).details).toContain(`registration sha256 ${digest()} (the one you pinned with --registration)`);
    }
  });
  it("--registration with another digest (a second registration of the same audit): verify FAILs check 1, exit 1; status exits 1 and is not certified", async () => {
    const s = cloneScenario(audit);
    const other = "0".repeat(64);
    const v = await runVerify(s.ctx, { offline: true, registration: other });
    expect(check(v, 1).status).toBe("FAIL");
    expect(check(v, 1).details.join("\n")).toContain(`FAIL the registration is not the one you pinned: its sha256 is ${digest()}, you gave ${other}`);
    expect(v.verdict).toBe("FAILED");
    expect(await verifyCommand(s.ctx, { offline: true, registration: other })).toBe(1);
    s.out.length = 0;
    expect(await statusCommand(s.ctx, { json: true, registration: other })).toBe(1);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ certified: false });
    // The same status without the pin certifies: the pin is what withholds it.
    s.out.length = 0;
    expect(await statusCommand(s.ctx, {})).toBe(0);
  });
  it("a malformed --registration is a usage error (exit 1), in verify and in status", async () => {
    const s = cloneScenario(audit);
    for (const bad of ["abc", "z".repeat(64), `${digest()}00`]) {
      await expect(runVerify(s.ctx, { offline: true, registration: bad })).rejects.toThrow(/--registration takes the registration's SHA-256, 64 hex characters/);
      await expect(statusCommand(s.ctx, { registration: bad })).rejects.toThrow(/--registration takes the registration's SHA-256/);
    }
  });
});
