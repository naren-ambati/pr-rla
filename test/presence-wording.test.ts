import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESENCE_LABEL, PRESENCE_LIMIT, provenanceLabel, rulesLine, verdictsSummary } from "../src/core/presence/index.js";
import { provenanceLine } from "../src/core/status.js";
import { carriesLimit, claimsIn, claimsInText, markdownSentences, mentionsPresence, sourceProse, sourceSentences, uncoveredSentences, unlabelledPresence, vettedKey, vettedSet, type VettedList } from "./helpers/wording.js";

/**
 * FR9.6 and NFR23: no doc, script or certificate claims hardware-verified presence, and `presence`
 * is printed as `presence (user-presence flag verified; key hardware not attested)`. Software keys
 * and a software-emulated authenticator prove the verifier logic, not that a human touched a
 * hardware key (D7, threat T16).
 *
 * The text check reads every Markdown file in the repository (README, docs/, the design record,
 * BUILD-NOTES, examples, audits), and the prose of every source file and script (comments and
 * messages), sentence by sentence. Since P4 it is an allow-list (second-pass review finding 7: the
 * deny-list missed 9 of 12 direct claims): every sentence that mentions presence, the UP flag, a touch
 * of a key, hardware, a security key or a YubiKey must carry the limit wording (`LIMIT_WORDING`) or be
 * on the vetted list, test/fixtures/wording/vetted.json, which a person extends on purpose. The
 * deny-list still runs beside it: a sentence that claims hardware-verified presence fails unless a
 * negation stands just before the claim or a condition just after it, whatever else it carries.
 * The outputs themselves, text and --json, are checked the same way in e2e-presence.test.ts.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VETTED = JSON.parse(readFileSync(join(ROOT, "test/fixtures/wording/vetted.json"), "utf8")) as VettedList;
const vetted = vettedSet(VETTED);

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
    const found = [...docs, ...sources, ...scripts].flatMap((f) => claimsInText(readFileSync(join(ROOT, f), "utf8")).map((sentence) => `${f}: ${sentence}`));
    expect(found).toEqual([]);
    expect(docs.length + sources.length + scripts.length).toBeGreaterThan(100);
  });

  it("P4 (finding 7): the allow-list catches every one of the reviewer's direct claims the deny-list missed", () => {
    const probes = [
      "pr-rla verifies that the reviewer physically touched a hardware key.",
      "The UP flag proves the reviewer touched their YubiKey.",
      "With presence, pr-rla knows a human was at the keyboard.",
      "pr-rla checks that the key is hardware-backed.",
      "A presence verdict is proof of physical presence.",
      "Presence verdicts are made on a hardware key.",
      "Presence is guaranteed by hardware.",
      "presence: a human touched the security key for this verdict",
      "No setup needed: presence proves a person touched the key.",
      "A touch request from a key that only signs verdicts is unambiguous.",
      "An assistant cannot forge a presence verdict.",
      "An assistant can't forge presence without the touch.",
    ];
    for (const p of probes) expect(uncoveredSentences(markdownSentences(p), vetted), p).toHaveLength(markdownSentences(p).length);
    // The deny-list alone lets most of them through (the reviewer counted 9 of 12 at 5fe1072), which is why it is no longer the only check.
    expect(probes.filter((p) => claimsIn(p).length === 0).length).toBeGreaterThanOrEqual(8);
  });

  it("the limit wording lets a sentence through, but not one that also makes a claim; unrelated uses of the words are not mentions", () => {
    for (const s of [
      `Certificates print it as ${PRESENCE_LABEL}.`,
      "presence relies on a hardware-backed key, which pr-rla does not check (T16).",
      "A software-emulated authenticator sets the user-presence flag as easily as a hardware key does.",
      "The presence path is tested with software keys only.",
    ]) {
      expect(mentionsPresence(s), s).toBe(true);
      expect(carriesLimit(s), s).toBe(true);
      expect(uncoveredSentences([s], new Set()), s).toEqual([]);
    }
    // A claim made around the label carries the limit wording, so the deny-list is what catches it.
    expect(claimsIn(`A ${PRESENCE_LABEL} verdict proves that a human touched the key.`)).toEqual([]);
    expect(claimsInText(`A ${PRESENCE_LABEL} verdict proves that a human touched the key.`)).toHaveLength(1);
    for (const s of ["Not touched: package.json and src/cli.ts.", "The walk never touches the network.", "U8 should know: nothing up front."]) expect(mentionsPresence(s), s).toBe(false);
  });

  it("source prose is comments and messages, not code: identifiers, the enum value and regular expressions are not sentences", () => {
    const src = [
      "// A line comment about presence,",
      "// continued on the next line.",
      "/** A doc comment. */",
      'const level = "presence";',
      'const msg = `the registration requires ${label} for draw #${n}`;',
      `const re = /presence 'quoted" in a regex/g;`,
      'if (a / b > 1) say("a message with a space");',
    ].join("\n");
    expect(sourceProse(src)).toEqual(["A line comment about presence,\ncontinued on the next line.", "A doc comment. ", "the registration requires <x> for draw #<x>", "a message with a space"]);
    expect(sourceSentences('const x = "One sentence. Another one.";')).toEqual(["One sentence.", "Another one."]);
  });

  it("every sentence in the docs, the sources and the scripts that mentions presence, UP, a touch, hardware, a security key or a YubiKey carries the limit wording or is vetted", () => {
    const found = [
      ...docs.flatMap((f) => uncoveredSentences(markdownSentences(readFileSync(join(ROOT, f), "utf8")), vetted).map((x) => `${f}: ${x}`)),
      ...[...sources, ...scripts].flatMap((f) => uncoveredSentences(sourceSentences(readFileSync(join(ROOT, f), "utf8")), vetted).map((x) => `${f}: ${x}`)),
    ];
    // To vet a sentence that states no claim, add it under a reason in test/fixtures/wording/vetted.json; otherwise give it the limit wording.
    expect(found).toEqual([]);
  });

  it("the vetted list holds only sentences that mention the subject, carry no limit wording and make no claim the deny-list sees", () => {
    const all = Object.values(VETTED.reasons).flat();
    expect(all.length).toBeGreaterThan(50);
    for (const s of all) {
      expect(mentionsPresence(s), s).toBe(true);
      expect(carriesLimit(s), s).toBe(false);
    }
    expect(claimsInText(all.join("\n\n"))).toEqual([]);
    expect(new Set(all.map(vettedKey)).size).toBe(all.length);
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
