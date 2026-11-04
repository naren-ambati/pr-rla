// Re-derives an audit's draws from its records with node:crypto alone (no pr-rla code), as a second
// implementation of the draw formula for anyone checking an audit by hand (docs/statistics.md).
// `pr-rla verify` check 6 does the same with pr-rla's own code, and checks the beacon's BLS signature,
// which this script does not.
//
// Usage: node scripts/rederive-draws.mjs <audit dir> [draw ...]
//   The window is the audit directory's one audit/<window>/ directory; the default draws are 1, 2 and 3.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [dir = ".", ...wanted] = process.argv.slice(2);
const [window] = readdirSync(join(dir, "audit"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const read = (...p) => JSON.parse(readFileSync(join(dir, "audit", ...p), "utf8"));
const draws = read(window, "draws.json");
const registration = read(window, "registration.json");
const manifest = read(`${window}.manifest.json`);
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const bytes = (hex) => Buffer.from(hex, "hex");

// drand quicknet's randomness is the SHA-256 of the round's BLS signature.
console.log(`round ${draws.beacon.round}: randomness = SHA-256(signature): ${sha256(bytes(draws.beacon.signature)).toString("hex") === draws.beacon.randomness}`);
// Schema v2 binds the draws to the registration's sha256; v1 audits were drawn with the manifest's.
const v2 = registration.record.schema === "pr-rla/registration/v2";
const binding = v2 ? registration.sha256 : draws.manifestSha256;
console.log(`binding: the ${v2 ? "registration" : "manifest"} sha256 ${binding.slice(0, 16)}… · N = ${manifest.changes.length}`);
for (const i of (wanted.length ? wanted : ["1", "2", "3"]).map(Number)) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(BigInt(i));
  const index = Number(BigInt(`0x${sha256(bytes(draws.beacon.randomness), bytes(binding), n).toString("hex")}`) % BigInt(manifest.changes.length));
  const recorded = draws.draws.find((d) => d.draw === i);
  console.log(`draw ${i}: index ${index} = ${manifest.changes[index].id} · draws.json: ${recorded.changeId} · ${recorded.index === index && recorded.changeId === manifest.changes[index].id ? "same" : "DIFFERENT"}`);
}
