import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESENCE_LABEL, PRESENCE_LIMIT, provenanceLabel, rulesLine, verdictsSummary } from "../src/core/presence/index.js";
import { provenanceLine } from "../src/core/status.js";
import { claimsIn, unlabelledPresence } from "./helpers/wording.js";

/**
 * FR9.6 and NFR23: no doc, script or certificate claims hardware-verified presence, and `presence`
 * is printed as `presence (user-presence flag verified; key hardware not attested)`. Software keys
 * and a software-emulated authenticator prove the verifier logic, not that a human touched a
 * hardware key (D7, threat T16).
 *
 * The text check reads every Markdown file in the repository (README, docs/, the design record,
 * BUILD-NOTES, examples, audits), every source file and every script, sentence by sentence. A
 * sentence that claims hardware-verified presence fails unless a negation stands just before the
 * claim or a condition just after it (finding 9: a "no" elsewhere in the sentence does not excuse it).
 * The outputs themselves, text and --json, are checked in e2e-presence.test.ts.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files under `dir` matching `ext`; `deep: false` reads one level. Never enters node_modules, .git or a symlink (the examples link back to the repo). */
function files(dir: string, ext: RegExp, deep = true): string[] {
  const entries: Dirent[] = readdirSync(join(ROOT, dir), { withFileTypes: true });
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return deep && e.name !== "node_modules" && e.name !== ".git" ? files(path, ext) : [];
    return e.isFile() && ext.test(e.name) ? [path] : [];
  });
}

describe("FR9.6 / NFR23: no claim of hardware-verified presence", () => {
  const docs = [...files(".", /\.md$/, false), ...files("docs", /\.md$/), ...files("examples", /\.md$/), ...files("audits", /\.md$/)];
  const sources = files("src", /\.ts$/);
  const scripts = files("scripts", /\.(?:mjs|js|ts)$/);

  it("the check sees the docs, the design record, the sources and the scripts", () => {
    expect(docs).toEqual(expect.arrayContaining(["README.md", "BUILD-NOTES.md", join("docs", "security-model.md"), join("docs", "design", "phase-3-4", "functional-design.md"), join("docs", "design", "phase-3-4", "draft", "05-functional-design.md")]));
    expect(sources).toContain(join("src", "core", "presence", "provenance.ts"));
    expect(scripts).toEqual(expect.arrayContaining([join("scripts", "demo-presence.mjs"), join("scripts", "make-presence-fixtures.mjs")]));
  });

  it("catches claims, including the ones the first check let through (finding 9)", () => {
    for (const s of [
      "Signed verdicts prove that a human touched a hardware key.",
      "pr-rla offers hardware-verified presence for every verdict.",
      "A presence verdict proves hardware presence.",
      "pr-rla gives hardware-verified presence with no extra setup.",
      "Presence verdicts are hardware-attested.",
      "physical presence was verified",
      "presence means the reviewer touched their hardware security key",
      "This is the only control an assistant holding the reviewer's shell **cannot** forge.",
      "Presence is unforgeable.",
      "Signed verdicts with no extra setup prove that a human touched a hardware key.",
    ])
      expect(claimsIn(s), s).toHaveLength(1);
  });

  it("lets through what denies or conditions the claim itself", () => {
    for (const s of [
      "presence proves hardware presence only if the registered key is hardware-backed",
      "It does not prove that a human touched a hardware key.",
      "No doc or certificate claims hardware-verified presence.",
      "`presence` does not prove a person touched hardware (T16).",
      "A verdict is never hardware-attested presence.",
    ])
      expect(claimsIn(s), s).toEqual([]);
    // A passage marked superseded right after it is the design history, not a claim.
    expect(claimsIn("An assistant **cannot** forge this.\n\n> **Superseded (2026-11-04):** it can.\n")).toEqual([]);
  });

  it("no Markdown file, source file or script claims it", () => {
    const found = [...docs, ...sources, ...scripts].flatMap((f) => claimsIn(readFileSync(join(ROOT, f), "utf8")).map((sentence) => `${f}: ${sentence}`));
    expect(found).toEqual([]);
    expect(docs.length + sources.length + scripts.length).toBeGreaterThan(100);
  });

  it("the draft's false 'cannot forge' line keeps its words and gains a Superseded note pointing to the refined §U9 and the security model", () => {
    const draft = readFileSync(join(ROOT, "docs/design/phase-3-4/draft/05-functional-design.md"), "utf8");
    expect(draft).toContain("This is the only control in the design that an assistant holding the reviewer's shell and tokens **cannot** forge.");
    expect(draft).toMatch(/\n\n> \*\*Superseded \(2026-11-04\):\*\*[^\n]*functional-design\.md[^\n]*security-model\.md/);
  });
});

describe("FR9.6: the certificate wording", () => {
  it("presence is printed with its limit wherever a level is printed", () => {
    expect(PRESENCE_LABEL).toBe("presence (user-presence flag verified; key hardware not attested)");
    expect(provenanceLabel("presence")).toBe(PRESENCE_LABEL);
    expect(provenanceLine([{ level: "account", count: 12 }, { level: "presence", count: 24 }])).toBe("VERDICT PROVENANCE: account (12) · presence (user-presence flag verified; key hardware not attested) (24)");
    expect(rulesLine({ minProvenance: "presence", requireSigned: true })).toBe("registered minimum: presence (user-presence flag verified; key hardware not attested) · signed verdicts required (require_signed)");
    expect(verdictsSummary({ minProvenance: "presence", reviewers: null })).toBe("verdict provenance presence (user-presence flag verified; key hardware not attested)");
    expect(unlabelledPresence(`${provenanceLine([{ level: "presence", count: 1 }])}\n${PRESENCE_LIMIT}`)).toEqual([]);
    expect(unlabelledPresence("verdict on draw #4 is account; the registration requires presence")).toHaveLength(1);
  });

  it("T16 is stated: presence relies on a hardware-backed registered key, which pr-rla does not check", () => {
    expect(PRESENCE_LIMIT).toMatch(/relies on each reviewer having registered a hardware-backed security key, which pr-rla does not check/);
    expect(PRESENCE_LIMIT).toMatch(/a software-emulated authenticator can set the user-presence flag too \(threat T16\)/);
    const security = readFileSync(join(ROOT, "docs", "security-model.md"), "utf8");
    expect(security).toMatch(/T16/);
    expect(security).toContain("key hardware not attested");
    expect(security).toMatch(/does not check that a registered key is hardware-backed/);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("presence (user-presence flag verified; key hardware not attested)");
  });
});
