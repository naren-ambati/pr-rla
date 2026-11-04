// Builds test/fixtures/audits/gh-aw-q3-recorded/: a retrospective audit of github/gh-aw's Q3 2026
// Copilot stratum (N = 1,589), offline, from recorded data:
//   - the population is the phase-1 read-only dry run (`freeze --dry-run --out`, 2026-11-03T14:27Z to
//     14:49Z, GitHub API, read-only): the 1,589 changes its selector kept;
//   - the seed is the recorded drand quicknet round 33,245,812 (test/fixtures/drand/);
//   - register, freeze and sample run on a fake clock (2026-10-20 and 2026-10-21), with no timestamp
//     authority and no transparency log, so the times are self-asserted (TIMESTAMP NOT TAMPER-PROOF).
// Nothing leaves the machine. The draws' descriptions are added afterwards by
// scripts/record-draw-descriptions.mjs, which reads GitHub (GETs only).
//
// Usage: npm run build && node scripts/build-gh-aw-recorded-audit.mjs <phase-1 population.json> [out-dir] [protocol.md]
//   protocol.md: the review protocol to register (default docs/design/review-protocol.example.md). Rebuilding the
//   committed fixture passes its own review-protocol.md, which is the example as it was when the fixture was first built.
//   The population can be the fixture's own changes.json as { listed: changes, selected: ids, limitations }: it holds
//   exactly the changes the phase-1 dry run selected. (Time round B rebuilt the fixture that way: BUILD-NOTES.)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { verifyQuicknetBeacon, RoundNotYetPublished } from "../dist/beacon/drand.js";
import { freezeCommand } from "../dist/commands/freeze.js";
import { registerCommand } from "../dist/commands/register.js";
import { sampleCommand } from "../dist/commands/sample.js";

const here = dirname(fileURLToPath(import.meta.url));
const [populationFile, outArg, protocolArg] = process.argv.slice(2);
if (!populationFile) throw new Error("usage: build-gh-aw-recorded-audit.mjs <phase-1 population.json> [out-dir] [protocol.md]");
const out = resolve(outArg ?? join(here, "..", "test", "fixtures", "audits", "gh-aw-q3-recorded"));
const pop = JSON.parse(readFileSync(populationFile, "utf8"));
const selected = new Set(pop.selected);
const changes = pop.listed.filter((c) => selected.has(c.id));
if (changes.length !== 1589) throw new Error(`expected the 1,589 changes of the phase-1 stratum, found ${changes.length}`);

const work = mkdtempSync(join(tmpdir(), "prrla-gh-aw-"));
const protocol = readFileSync(protocolArg ? resolve(protocolArg) : join(here, "..", "docs", "design", "review-protocol.example.md"), "utf8");
writeFileSync(join(work, "review-protocol.md"), protocol);
writeFileSync(
  join(work, "changes.json"),
  JSON.stringify({
    schema: "pr-rla/changes/v1",
    repo: "github/gh-aw",
    defaultBranch: "main",
    source: "recorded",
    recorded: `GitHub API, read-only, 2026-11-03T14:27Z to 14:49Z (pr-rla freeze --dry-run --out, phase 1): the ${changes.length} changes of the Q3 2026 Copilot stratum of https://github.com/github/gh-aw`,
    limitations: pop.limitations,
    changes,
  }),
);
writeFileSync(
  join(work, ".pr-rla.yml"),
  [
    "# A retrospective audit of github/gh-aw's Q3 2026 Copilot stratum, built offline from recorded data (see README.md).",
    "provider: { use: json-file, options: { path: changes.json } }",
    "repo: github/gh-aw",
    "window: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }",
    'selector: { kinds: [pull_request, direct_push], authors: ["copilot-swe-agent[bot]"], unreviewed: no-human-review, max_changed_lines: 200, exclude_generated: true }',
    "audit: { p0: 0.10, p1: 0.02, alpha: 0.05 }",
    "ledger: git-file",
    "timestamping: { authorities: [] }",
    "",
  ].join("\n"),
);
writeFileSync(join(work, ".gitignore"), ".pr-rla/\n");

const beaconFile = join(here, "..", "test", "fixtures", "drand", "quicknet-33245812.json");
const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
const lines = [];
const ctx = {
  cwd: work,
  env: {},
  nowMs: () => clock.now,
  sleep: async (ms) => void (clock.now += ms),
  fetch: async (u) => {
    throw new Error(`build-gh-aw-recorded-audit makes no network call (asked for ${u})`);
  },
  out: (l) => lines.push(l),
  err: (l) => lines.push(`ERR ${l}`),
  beacon: async (round) => {
    const b = JSON.parse(readFileSync(join(dirname(beaconFile), `quicknet-${round}.json`), "utf8"));
    const publishes = 1692803367 + 3 * (round - 1);
    if (clock.now / 1000 < publishes) throw new RoundNotYetPublished(round, publishes);
    if (!(await verifyQuicknetBeacon(b, round))) throw new Error("recorded beacon fails BLS verification");
    return b;
  },
};
const step = async (name, fn) => {
  const code = await fn();
  if (code !== 0) throw new Error(`${name} exited ${code}:\n${lines.join("\n")}`);
};
await step("register", () => registerCommand(ctx, {}));
clock.now = Date.parse("2026-10-20T12:00:00Z");
await step("freeze", () => freezeCommand(ctx, {}));
clock.now = Date.parse("2026-10-21T00:00:05Z");
await step("sample", () => sampleCommand(ctx, { beaconFile }));

// Compact the large records: their hashes are over canonical JSON, not the file's formatting.
for (const rel of ["audit/2026-q3.manifest.json"]) {
  const p = join(work, rel);
  writeFileSync(p, `${JSON.stringify(JSON.parse(readFileSync(p, "utf8")))}\n`);
}
rmSync(join(work, ".pr-rla"), { recursive: true, force: true });
writeFileSync(
  join(work, "README.md"),
  [
    "# gh-aw Q3 2026, recorded (a test fixture)",
    "",
    "A retrospective pr-rla audit of the Copilot stratum of https://github.com/github/gh-aw for 2026-07-01..2026-09-30, built offline by `scripts/build-gh-aw-recorded-audit.mjs`. It is a demonstration, not evidence: it was registered after the window closed.",
    "",
    "- **recorded**: the population in `changes.json` (the 1,589 changes the phase-1 read-only dry run of 2026-11-03T14:27Z to 14:49Z selected: Copilot PRs merged into main with no recorded human review and at most 200 changed lines), and the drand quicknet round 33,245,812 the draws come from.",
    "- **recorded**: `changes.json` `descriptions`, the GitHub API's own responses for the issued draws (`scripts/record-draw-descriptions.mjs`, GETs only, 2026-11-04), with e-mail addresses replaced by `user-<hash>@example.invalid`. `recordedDescriptions` says when each was read: the first 36 are the changes the draws named before time round B bound the draws to the registration (kept for the replay in `test/fixtures/github/gh-aw-q3-draws-2026-11-04.json`), the next 36 the changes they name now.",
    "- **rebuilt** in time round B (2026-11-04), when draws became bound to the registration: the same population, protocol and clock, a new signing key named inside the registration, so a new registration, manifest hash, commitment and draws (`node scripts/build-gh-aw-recorded-audit.mjs <population> <out> test/fixtures/audits/gh-aw-q3-recorded/review-protocol.md`, the population being this `changes.json` as `{ listed, selected, limitations }`).",
    "- **synthetic**: the registration, freeze and sample times (a fake clock: registered 2026-10-20T00:00Z, frozen 12:00Z, sampled 2026-10-21T00:00:05Z), the signing key (thrown away), and the review protocol (`docs/design/review-protocol.example.md` as it was when the fixture was built, before the U5 fix round added its base-commit rule for generated files). There are no verdicts: no one reviewed these changes for this fixture.",
    "- No timestamp authority and no transparency log: every time is self-asserted (TIMESTAMP NOT TAMPER-PROOF).",
    "",
  ].join("\n"),
);
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
cpSync(work, out, { recursive: true });
rmSync(work, { recursive: true, force: true });
console.error(lines.filter((l) => /^(registration|manifest|round|N = )/.test(l)).join("\n"));
console.error(`wrote ${out}`);
