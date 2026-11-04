import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { sampleCommand } from "../src/commands/sample.js";
import { fakeOrg, orgSpec } from "./helpers/fake-org.js";
import { setupPoolAudit } from "./helpers/pool-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5 (the test gaps): an honest PROSPECTIVE pooled audit, end to end, VERIFIED. U8's fake org used to hold only
 * retrospective pools (the registration after the window's days), because it served its whole push log whatever the
 * clock said: a registration dated before the window then saw heads "from the future". The org now answers only with
 * what had happened by the clock it is given (`control.now`), so the registration before the window, the freeze after
 * it and the sample after the seed round read a push log as it stood each time. Synthetic: the fake org, mock
 * authorities, the recorded beacon of round 33245812 (the window's `end` is chosen so that it is the seed round).
 */
let tsa: MockTsaServer;
beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
});
afterAll(async () => tsa.stop());

describe("an honest prospective pooled audit", () => {
  it("registered before the window, frozen after it, sampled after the seed round: VERIFIED, PROSPECTIVE, every check passing", async () => {
    const org = fakeOrg(orgSpec({ eligible: 8, scale: 2 }));
    const s = setupPoolAudit(org, { scmClock: true, start: "2026-06-20T00:00:00Z", window: "{ name: 2026-q3, start: 2026-07-01, end: 2026-10-19 }", tsa: { ids: ["test-a", "test-b"], server: tsa }, timestamping: "{ authorities: [test-a, test-b], min_tokens: 2 }" });
    const ctx = s.ctxFor(((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(url).hostname === "api.github.com" ? org.fetch(input, init) : globalThis.fetch(input, init);
    }) as typeof fetch);
    const at = () => (tsa.nowMs = s.clock.now());
    const to = async (iso: string) => {
      await s.advance(Date.parse(iso) - s.clock.now());
      at();
    };
    at();
    expect(await s.clock.run(registerCommand(ctx, {}))).toBe(0);
    await to("2026-10-20T06:00:00Z"); // the window closed 2026-10-20T00:00:00Z; R publishes 2026-10-21T00:00:00Z
    expect(await s.clock.run(freezeCommand(ctx, {}))).toBe(0);
    await to("2026-10-21T00:10:00Z");
    expect(await s.clock.run(sampleCommand(ctx, {}))).toBe(0);
    const r = await s.clock.run(runVerify(ctx, { offline: false }));
    expect(r.mode).toBe("PROSPECTIVE");
    expect(r.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:WARN"]);
    expect(r.checks[6]!.details.join("\n")).toMatch(/none counted/); // nothing recorded: check 7 has nothing to find fault with
    expect(r.verdict).toBe("VERIFIED");
  }, 300_000);
});
