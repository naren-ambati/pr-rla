import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attestVerdicts, checkVerdictSignature, countedVerdicts, parseAllowedSigners, verdictPayloadText, verdictRuleFailures, type VerdictAttestation } from "../src/core/presence/index.js";
import type { RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { createLedger } from "../src/registry.js";
import type { VerdictEvent } from "../src/sdk/ledger.js";

/**
 * FR9.5 on signatures made by real OpenSSH tooling: one `ssh-keygen -Y sign -n pr-rla-verdict@v1`
 * per verdict (OpenSSH 10.3p1), over bytes written by printf with the README's manual recipe, with
 * software keys, and for the -sk keys OpenSSH's sk-dummy middleware, a software-emulated
 * authenticator (scripts/make-presence-fixtures.mjs; source: synthetic, D7). The lines are read
 * through the git-file ledger and attested against the fixture's registration and allowed signers.
 */

interface Step {
  draw: number;
  reviewer: string;
  signer: string | null;
  namespace?: string;
  registrationSha256?: string;
  expect: { level: "self-asserted" | "account" | "presence"; why: string };
  payload: string;
  line: string;
  oracle: { verify: { exit: number; output: string }; details: { flags: number; counter: number } | null } | null;
}
interface Fixture {
  source: string;
  made: string;
  namespace: string;
  registrationSha256: string;
  protocolSha256: string;
  allowedSigners: string[];
  unlisted: Record<string, string>;
  steps: Step[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json");
const fx = JSON.parse(readFileSync(FILE, "utf8")) as Fixture;
const step = (draw: number) => fx.steps.find((s) => s.draw === draw)!;
const signers = parseAllowedSigners(fx.allowedSigners);
let read: VerdictEvent[];
let a: VerdictAttestation;
const byDraw = (d: number) => a.events.find((v) => v.draw === d)!;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "prrla-presence-fx-"));
  mkdirSync(join(dir, "audit/w"), { recursive: true });
  writeFileSync(join(dir, "audit/w/verdicts.jsonl"), fx.steps.map((s) => s.line).join(""));
  read = await (await createLedger({ use: "git-file", options: {} }, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch })).readVerdicts();
  a = attestVerdicts(read, fx.registrationSha256, signers);
});

describe("the sk-dummy fixture (synthetic: OpenSSH tooling, software keys only)", () => {
  it("is marked synthetic, keeps public keys only, and is signed in the verdict namespace", () => {
    expect(fx.source).toBe("synthetic");
    expect(fx.namespace).toBe("pr-rla-verdict@v1");
    expect(readFileSync(FILE, "utf8")).not.toMatch(/PRIVATE KEY/);
    expect(fx.allowedSigners.every((l) => l.includes('namespaces="pr-rla-verdict@v1"'))).toBe(true);
  });

  it("the bytes the README's printf recipe wrote are exactly the bytes pr-rla verifies", () => {
    for (const s of fx.steps) {
      const v = read.find((x) => x.draw === s.draw)!;
      expect(verdictPayloadText({ registrationSha256: s.registrationSha256 ?? fx.registrationSha256, protocolSha256: v.protocolSha256, draw: v.draw, changeId: v.changeId, verdict: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt }), `draw #${s.draw}`).toBe(s.payload);
    }
  });

  it("every verdict gets the level its own signature gives it", () => {
    expect(a.events.map((v) => [v.draw, v.provenance?.level ?? "self-asserted"])).toEqual(fx.steps.map((s) => [s.draw, s.expect.level]));
  });

  it("FR9.2: pr-rla reads the same flags and counter from each -sk signature as ssh-keygen -vv did when it was made", () => {
    // Every signature made in the verdict namespace (draw #14 was made as a commit signature, which pr-rla refuses before reading it).
    for (const s of fx.steps.filter((x) => x.oracle && !x.namespace)) {
      const c = checkVerdictSignature(read.find((v) => v.draw === s.draw)!, s.registrationSha256 ?? fx.registrationSha256, signers);
      if (s.oracle!.details) expect(c.sk, `draw #${s.draw}`).toMatchObject({ flags: s.oracle!.details.flags, counter: s.oracle!.details.counter });
      else expect(c.sk, `draw #${s.draw}`).toBeUndefined();
      // The key ssh-keygen reported for a good signature is the key pr-rla verified.
      const fp = /key (SHA256:\S+)/.exec(s.oracle!.verify.output)?.[1];
      if (fp) expect(c.key?.fingerprint, `draw #${s.draw}`).toBe(fp);
    }
  });

  it("each software key type gives account: ed25519, ECDSA P-256, P-384, P-521 and RSA 3072", () => {
    for (const d of [1, 9, 10, 11, 12]) expect(byDraw(d).provenance, step(d).expect.why).toMatchObject({ level: "account", source: "verdict-signature", signer: step(d).reviewer });
  });

  it("FR9.5 (1): an -sk signature with UP set passes at presence (ed25519-sk and ecdsa-sk)", () => {
    for (const d of [2, 3]) {
      expect(byDraw(d).provenance).toMatchObject({ level: "presence", source: "verdict-signature", signer: step(d).reviewer, counter: 0x12345678 });
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "presence", requireSigned: true })).toEqual([]);
    }
  });

  it("FR9.5 (2): one with UP clear fails at presence (no-touch-required keys), and is account", () => {
    for (const d of [4, 5]) {
      expect(byDraw(d).provenance).toMatchObject({ level: "account", source: "verdict-signature", signer: step(d).reviewer });
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "presence" })).toEqual([`verdict on draw #${d} (json:acme/widgets#${100 + d}) is account; the registration requires presence (user-presence flag verified; key hardware not attested)`]);
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "account", requireSigned: true })).toEqual([]);
    }
  });

  it("FR9.5 (3): an unlisted signer fails (FR9.3); ssh-keygen refuses it too", () => {
    expect(byDraw(6).provenance).toBeUndefined();
    expect(step(6).oracle!.verify.exit).not.toBe(0);
    expect(verdictRuleFailures(byDraw(6), { minProvenance: "account" })).toHaveLength(1);
    expect(a.warnings).toContainEqual(expect.stringMatching(/^verdict on draw #6 \(json:acme\/widgets#106\) is signed by key SHA256:\S+ \(ssh-ed25519\), which no registered reviewer holds: self-asserted$/));
  });

  it("FR9.5 (4): an unsigned verdict under require_signed fails (FR9.1)", () => {
    expect(byDraw(7).provenance).toBeUndefined();
    expect(verdictRuleFailures(byDraw(7), { minProvenance: "self-asserted", requireSigned: true })).toEqual([
      "verdict on draw #7 (json:acme/widgets#107) carries no valid signature by the registered key of reviewer alice; the registration requires signed verdicts (require_signed)",
    ]);
    expect(a.findings).toContain("1 verdict line(s) carry no signature (draws #7): self-asserted");
  });

  it("a reviewer/principal mismatch is self-asserted and reported; ssh-keygen -I alice refuses bob's signature", () => {
    expect(byDraw(8).provenance).toBeUndefined();
    expect(step(8).oracle!.verify.exit).not.toBe(0);
    expect(a.warnings).toContainEqual(expect.stringMatching(/^verdict on draw #8 \(json:acme\/widgets#108\) names reviewer alice but is signed by bob's key SHA256:\S+: self-asserted$/));
  });

  it("one touch is one verdict of one registration: bob's signature for another audit, or as a commit signature (namespace git), counts for nothing here", () => {
    expect(byDraw(13).provenance).toBeUndefined();
    expect(step(13).oracle!.verify.exit).toBe(0); // a good signature, over the other audit's bytes
    expect(a.warnings).toContainEqual(expect.stringMatching(/^verdict on draw #13 .* is signed for registration [0-9a-f]{12}…, not this audit's [0-9a-f]{12}…: self-asserted$/));
    expect(byDraw(14).provenance).toBeUndefined();
    expect(step(14).oracle!.verify.exit).not.toBe(0);
    expect(a.warnings).toContainEqual(expect.stringMatching(/^verdict on draw #14 .* namespace "git", not "pr-rla-verdict@v1": self-asserted$/));
  });

  it("notes the touch-less signatures; sk-dummy's constant counter is not a decreasing one", () => {
    expect(a.findings.filter((f) => /without the user-presence flag/.test(f))).toEqual([expect.stringMatching(/^verdict on draw #4 .* is signed by dave's sk-ssh-ed25519@openssh.com key SHA256:\S+ without the user-presence flag \(no touch\): account$/), expect.stringMatching(/^verdict on draw #5 .* erin's sk-ecdsa-sha2-nistp256@openssh.com key/)]);
    const counters = fx.steps.flatMap((s) => (s.oracle?.details ? [s.oracle.details.counter] : []));
    expect(new Set(counters)).toEqual(new Set([0x12345678]));
    expect(a.warnings.some((w) => /counter went down/.test(w))).toBe(false);
  });

  it("without registered keys, or with another ledger, the signatures count for nothing", () => {
    const reg = (allowed?: string[]) => ({ record: { schema: "pr-rla/registration/v2", verdicts: { minProvenance: "self-asserted", reviewers: null, ...(allowed ? { allowed_signers: allowed } : {}) } }, sha256: fx.registrationSha256 }) as unknown as SignedRecord<RegistrationRecordV2>;
    expect(countedVerdicts(read, { registration: reg(), verifiesSignatures: true, ledger: "git-file" }).verdicts.every((v) => v.provenance === undefined)).toBe(true);
    expect(countedVerdicts(read, { registration: reg(fx.allowedSigners), verifiesSignatures: false, ceiling: "account", ledger: "tracker" }).verdicts.every((v) => v.provenance === undefined)).toBe(true);
    expect(countedVerdicts(read, { registration: reg(fx.allowedSigners), verifiesSignatures: true, ceiling: "presence", ledger: "git-file" }).verdicts.filter((v) => v.provenance?.level === "presence")).toHaveLength(2);
  });
});
