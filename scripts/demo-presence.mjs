// The bolt 10 (U9) demo (delivery-plan.md): a software -sk signature with UP set passes at
// presence, and one with UP clear fails. Offline and local: it rebuilds the synthetic sk-dummy
// fixture (test/fixtures/presence/sk-dummy-verdicts.json, made by scripts/make-presence-fixtures.mjs
// with software keys only) in a temporary git repository, reads it with the git-file ledger under the
// fixture's allowed signers, and applies check 7's rules with min_provenance presence and
// require_signed. Where ssh-keygen is installed it also shows what `ssh-keygen -Y verify` says.
//   npm run build && node scripts/demo-presence.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import gitFile from "../dist/ledgers/git-file.js";
import { PRESENCE_LIMIT, provenanceLabel, splitCommitSignature, verdictRuleFailures } from "../dist/core/presence/index.js";
import { provenanceLine } from "../dist/core/status.js";

const fx = JSON.parse(readFileSync(new URL("../test/fixtures/presence/sk-dummy-verdicts.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "prrla-presence-demo-"));
const git = (args, input) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) }).trim();
git(["init", "-q"]);
for (const s of fx.steps) {
  mkdirSync(join(dir, dirname(s.file)), { recursive: true });
  writeFileSync(join(dir, s.file), s.content);
  git(["add", s.file]);
  if (git(["write-tree"]) !== s.tree || git(["hash-object", "-t", "commit", "-w", "--stdin"], s.raw) !== s.commit) throw new Error(`draw #${s.draw}: the commit did not rebuild`);
  git(["update-ref", "HEAD", s.commit]);
}

console.log(`fixture: ${fx.source}, made ${fx.made} with ${fx.tools.sshKeygen} and ${fx.tools.git}; -sk keys in OpenSSH 10.3p1's sk-dummy (a software-emulated authenticator)`);
console.log(`registered: ${fx.allowedSigners.map((l) => `${l.split(" ")[0]} (${l.split(" ")[1]})`).join(", ")}\n`);
const ledger = await gitFile.create({}, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch, reviewers: fx.allowedSigners });
const verdicts = await ledger.readVerdicts();
const rules = { minProvenance: "presence", requireSigned: true };
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;
writeFileSync(join(dir, "allowed_signers"), `${fx.allowedSigners.join("\n")}\n`);
for (const v of verdicts) {
  const step = fx.steps.find((s) => s.draw === v.draw);
  const failures = verdictRuleFailures(v, rules);
  let oracle = "";
  if (hasSshKeygen && step.signer) {
    const { payload, signature } = splitCommitSignature(new TextEncoder().encode(step.raw));
    writeFileSync(join(dir, "sig"), signature);
    const r = spawnSync("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", step.reviewer, "-n", "git", "-s", join(dir, "sig")], { input: payload, encoding: "utf8" });
    oracle = ` · ssh-keygen -Y verify -I ${step.reviewer}: ${r.status === 0 ? "Good" : "refused"}`;
  }
  console.log(`draw #${String(v.draw).padEnd(2)} reviewer ${v.reviewer.padEnd(7)} ${step.expect.why}`);
  console.log(`         → ${provenanceLabel(v.provenance?.level ?? "self-asserted")}${oracle}`);
  console.log(`         → check 7 under min_provenance presence + require_signed: ${failures.length ? `FAIL: ${failures.join("; ")}` : "PASS"}`);
}
const integrity = await ledger.verifyIntegrity();
console.log(`\nintegrity: ${integrity.ok ? (integrity.warnings?.length ? "WARN" : "PASS") : "FAIL"}`);
for (const w of integrity.warnings ?? []) console.log(`  WARN ${w}`);
for (const f of integrity.findings) console.log(`  ${f}`);
const counts = ["self-asserted", "account", "presence"].map((level) => ({ level, count: verdicts.filter((v) => (v.provenance?.level ?? "self-asserted") === level).length })).filter((c) => c.count);
console.log(`\n${provenanceLine(counts)}`);
console.log(PRESENCE_LIMIT);
