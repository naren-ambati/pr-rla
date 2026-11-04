// The bolt 10 (U9) demo (delivery-plan.md), as changed after review: a software -sk signature with UP
// set passes at presence, and one with UP clear fails; one signature is one verdict, for one draw of one
// registration; and a cut history is refused. Offline and local: it reads the synthetic sk-dummy
// fixture (test/fixtures/presence/sk-dummy-verdicts.json, one `ssh-keygen -Y sign -n pr-rla-verdict@v1`
// per verdict, made by scripts/make-presence-fixtures.mjs with software keys only) through the git-file
// ledger, attests each verdict's own signature against the fixture's registration and allowed signers,
// and applies check 7's rules with min_provenance presence and require_signed. Where ssh-keygen is
// installed it also shows what `ssh-keygen -Y verify` says.
//   npm run build && node scripts/demo-presence.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gitFile from "../dist/ledgers/git-file.js";
import { PRESENCE_LIMIT, attestVerdicts, parseAllowedSigners, provenanceLabel, verdictRuleFailures } from "../dist/core/presence/index.js";
import { provenanceLine } from "../dist/core/status.js";

const fx = JSON.parse(readFileSync(new URL("../test/fixtures/presence/sk-dummy-verdicts.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "prrla-presence-demo-"));
mkdirSync(join(dir, "audit/w"), { recursive: true });
writeFileSync(join(dir, "audit/w/verdicts.jsonl"), fx.steps.map((s) => s.line).join(""));
writeFileSync(join(dir, "allowed_signers"), `${fx.allowedSigners.join("\n")}\n`);

console.log(`fixture: ${fx.source}, made ${fx.made} with ${fx.tools.sshKeygen}; -sk keys in OpenSSH 10.3p1's sk-dummy (a software-emulated authenticator)`);
console.log(`one SSHSIG per verdict, namespace ${fx.namespace}, over the README's bytes; registration ${fx.registrationSha256.slice(0, 12)}…`);
console.log(`registered: ${fx.allowedSigners.map((l) => `${l.split(" ")[0]} (${l.split(" ").at(-2)})`).join(", ")}\n`);
const ledger = await gitFile.create({}, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch });
const read = await ledger.readVerdicts();
const a = attestVerdicts(read, fx.registrationSha256, parseAllowedSigners(fx.allowedSigners));
const rules = { minProvenance: "presence", requireSigned: true };
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;
for (const v of a.events) {
  const step = fx.steps.find((s) => s.draw === v.draw);
  const failures = verdictRuleFailures(v, rules);
  let oracle = "";
  if (hasSshKeygen && step.signer) {
    const sig = read.find((x) => x.draw === v.draw).sshsig;
    writeFileSync(join(dir, "sig"), `-----BEGIN SSH SIGNATURE-----\n${sig.match(/.{1,70}/g).join("\n")}\n-----END SSH SIGNATURE-----\n`);
    const r = spawnSync("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", step.reviewer, "-n", fx.namespace, "-s", join(dir, "sig")], { input: step.payload, encoding: "utf8" });
    oracle = ` · ssh-keygen -Y verify -I ${step.reviewer}: ${r.status === 0 ? "Good" : "refused"}`;
  }
  console.log(`draw #${String(v.draw).padEnd(2)} reviewer ${v.reviewer.padEnd(7)} ${step.expect.why}`);
  console.log(`         → ${provenanceLabel(v.provenance?.level ?? "self-asserted")}${oracle}`);
  console.log(`         → check 7 under min_provenance presence + require_signed: ${failures.length ? `FAIL: ${failures.join("; ")}` : "PASS"}`);
}
console.log(`\nsignatures: ${a.warnings.length ? "WARN" : "PASS"}`);
for (const w of a.warnings) console.log(`  WARN ${w}`);
for (const f of a.findings) console.log(`  ${f}`);
const counts = ["self-asserted", "account", "presence"].map((level) => ({ level, count: a.events.filter((v) => (v.provenance?.level ?? "self-asserted") === level).length })).filter((c) => c.count);
console.log(`\n${provenanceLine(counts)}`);
console.log(PRESENCE_LIMIT);
