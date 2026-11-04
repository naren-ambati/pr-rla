import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESENCE_LABEL, PRESENCE_LIMIT, provenanceLabel, rulesLine, verdictsSummary } from "../src/core/presence/index.js";
import { provenanceLine } from "../src/core/status.js";

/**
 * FR9.6 and NFR23: no doc or certificate claims hardware-verified presence, and `presence` is
 * printed as `presence (user-presence flag verified; key hardware not attested)`. Software keys
 * and a software-emulated authenticator prove the verifier logic, not that a human touched a
 * hardware key (D7, threat T16).
 *
 * The text check reads every Markdown file in the repository (README, docs/, the design record,
 * BUILD-NOTES, examples, audits) and every source file, sentence by sentence. A sentence that
 * claims hardware-verified presence fails unless it says the opposite (a negation or a condition).
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

/** Claims of hardware-verified presence, or of a human proven present. */
const CLAIMS = [
  /hardware[- ](?:verified|attested|backed|proven)\s+(?:user[- ])?presence/i,
  /presence\s+(?:is\s+|was\s+)?(?:verified|attested|proven|guaranteed)\s+(?:by|with|on|in)\s+(?:the\s+|a\s+)?hardware/i,
  /(?:proves?|guarantees?|attests?|confirms?|establish(?:es)?)\s+(?:that\s+)?(?:a\s+)?(?:human|person|reviewer|someone)\s+(?:physically\s+)?(?:touched|was present)/i,
  /key hardware (?:is |was )?(?:verified|attested|checked)/i,
  /\bhardware\s+presence\b/i,
  /(?:security|hardware) key (?:is |was )?(?:verified|attested|checked) (?:to be |as )?hardware/i,
];
/** A sentence that denies or conditions the claim. */
const LIMITED = /\b(?:no|not|never|cannot|can't|does not|doesn't|without|only if|unless|nor|neither|would need|until)\b/i;

function claimsIn(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;:])\s+|\s+[-*]\s+|\|/)
    .filter((s) => CLAIMS.some((re) => re.test(s)) && !LIMITED.test(s));
}

describe("FR9.6 / NFR23: no claim of hardware-verified presence", () => {
  const docs = [...files(".", /\.md$/, false), ...files("docs", /\.md$/), ...files("examples", /\.md$/), ...files("audits", /\.md$/)];
  const sources = files("src", /\.ts$/);

  it("the check sees the docs, the design record and the sources, and catches a claim", () => {
    expect(docs).toEqual(expect.arrayContaining(["README.md", "BUILD-NOTES.md", join("docs", "security-model.md"), join("docs", "design", "phase-3-4", "functional-design.md")]));
    expect(sources).toContain(join("src", "core", "presence", "provenance.ts"));
    expect(claimsIn("Signed verdicts prove that a human touched a hardware key.")).toHaveLength(1);
    expect(claimsIn("pr-rla offers hardware-verified presence for every verdict.")).toHaveLength(1);
    expect(claimsIn("A presence verdict proves hardware presence.")).toHaveLength(1);
    expect(claimsIn("presence proves hardware presence only if the registered key is hardware-backed")).toEqual([]);
    expect(claimsIn("It does not prove that a human touched a hardware key.")).toEqual([]);
    expect(claimsIn("No doc or certificate claims hardware-verified presence.")).toEqual([]);
  });

  it("no Markdown file and no source file claims it", () => {
    const found = [...docs, ...sources].flatMap((f) => claimsIn(readFileSync(join(ROOT, f), "utf8")).map((sentence) => `${f}: ${sentence}`));
    expect(found).toEqual([]);
    expect(docs.length + sources.length).toBeGreaterThan(100);
  });
});

describe("FR9.6: the certificate wording", () => {
  it("presence is printed with its limit wherever a level is printed", () => {
    expect(PRESENCE_LABEL).toBe("presence (user-presence flag verified; key hardware not attested)");
    expect(provenanceLabel("presence")).toBe(PRESENCE_LABEL);
    expect(provenanceLine([{ level: "account", count: 12 }, { level: "presence", count: 24 }])).toBe("VERDICT PROVENANCE: account (12) · presence (user-presence flag verified; key hardware not attested) (24)");
    expect(rulesLine({ minProvenance: "presence", requireSigned: true })).toBe("registered minimum: presence (user-presence flag verified; key hardware not attested) · signed verdict commits required (require_signed)");
    expect(verdictsSummary({ minProvenance: "presence", reviewers: null })).toBe("verdict provenance presence (user-presence flag verified; key hardware not attested)");
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
