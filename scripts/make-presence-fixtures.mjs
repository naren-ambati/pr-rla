// Makes the U9 signed-verdict fixture with real OpenSSH tooling and software keys only (D7):
// `ssh-keygen` keys, `git commit -S` in the SSH format, and for the FIDO types OpenSSH's own test
// middleware, sk-dummy (regress/misc/sk-dummy), loaded through SSH_SK_PROVIDER as OpenSSH's
// regression tests do. sk-dummy is a software-emulated authenticator: it signs with a key it keeps in
// the key handle and sets whatever flags ssh-keygen asks for, so a key made with
// `-O no-touch-required` signs with the user-presence (UP) flag clear. Its counter is a constant.
//
// Usage:
//   SK_DUMMY=/path/to/sk-dummy.so node scripts/make-presence-fixtures.mjs [out.json]
//   (default test/fixtures/presence/sk-dummy-verdicts.json)
//
// Building sk-dummy (read-only download; nothing is installed):
//   curl -LO https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.3p1.tar.gz
//   tar xzf openssh-10.3p1.tar.gz && cd openssh-10.3p1
//   ./configure --with-ssl-dir="$(brew --prefix openssl@3)" --without-zlib
//   make openbsd-compat/libopenbsd-compat.a regress/misc/sk-dummy/sk-dummy.so
//
// Everything happens in a temporary directory: keys, the repository and the allowed-signers file.
// No key is written to ~/.ssh, git runs with no global or system configuration, and nothing is
// pushed or sent anywhere. The fixture keeps public keys only. It is synthetic (made here, not read
// from a public source). Each step's file content, tree and raw commit object are stored, so a test
// rebuilds the same commits (same SHAs) with plain `git hash-object`, on any git version.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SK = process.env.SK_DUMMY;
if (!SK || !existsSync(SK)) {
  console.error("set SK_DUMMY to OpenSSH's built regress/misc/sk-dummy/sk-dummy.so (see the comment at the top of this script)");
  process.exit(2);
}
const out = resolve(process.argv[2] ?? join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json"));
const work = mkdtempSync(join(tmpdir(), "prrla-presence-"));
const repo = join(work, "repo");
const env = { ...process.env, SSH_SK_PROVIDER: resolve(SK), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: work };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });

// Reviewers and their keys. mallory is never registered (the unlisted signer).
const KEYS = [
  { name: "alice", type: "ed25519", args: [] },
  { name: "bob", type: "ed25519-sk", args: [] },
  { name: "carol", type: "ecdsa-sk", args: [] },
  { name: "dave", type: "ed25519-sk", args: ["-O", "no-touch-required"] },
  { name: "erin", type: "ecdsa-sk", args: ["-O", "no-touch-required"] },
  { name: "frank", type: "ecdsa", args: ["-b", "256"] },
  { name: "grace", type: "rsa", args: ["-b", "3072"] },
  { name: "heidi", type: "ecdsa", args: ["-b", "384"] },
  { name: "ivan", type: "ecdsa", args: ["-b", "521"] },
  { name: "mallory", type: "ed25519", args: [] },
];
const pub = {};
for (const k of KEYS) {
  sh("ssh-keygen", ["-q", "-t", k.type, ...k.args, "-N", "", "-C", k.name, "-f", join(work, k.name)]);
  pub[k.name] = readFileSync(join(work, `${k.name}.pub`), "utf8").trim().split(" ").slice(0, 2).join(" ");
}
const registered = KEYS.filter((k) => k.name !== "mallory").map((k) => `${k.name} ${pub[k.name]}`);
writeFileSync(join(work, "allowed_signers"), `${registered.join("\n")}\n`);

// The verdicts: draw n names `reviewer` and its commit is signed with `signer`'s key (null: unsigned).
const STEPS = [
  { draw: 1, reviewer: "alice", signer: "alice", expect: { level: "account", why: "a software ed25519 key" } },
  { draw: 2, reviewer: "bob", signer: "bob", expect: { level: "presence", why: "an ed25519-sk key, UP set" } },
  { draw: 3, reviewer: "carol", signer: "carol", expect: { level: "presence", why: "an ecdsa-sk key, UP set" } },
  { draw: 4, reviewer: "dave", signer: "dave", expect: { level: "account", why: "an ed25519-sk key made with no-touch-required: UP clear" } },
  { draw: 5, reviewer: "erin", signer: "erin", expect: { level: "account", why: "an ecdsa-sk key made with no-touch-required: UP clear" } },
  { draw: 6, reviewer: "mallory", signer: "mallory", expect: { level: "self-asserted", why: "signed by a key nobody registered" } },
  { draw: 7, reviewer: "alice", signer: null, expect: { level: "self-asserted", why: "an unsigned commit" } },
  { draw: 8, reviewer: "alice", signer: "bob", expect: { level: "self-asserted", why: "names alice but bob signed it" } },
  { draw: 9, reviewer: "frank", signer: "frank", expect: { level: "account", why: "a software ecdsa-sha2-nistp256 key" } },
  { draw: 10, reviewer: "grace", signer: "grace", expect: { level: "account", why: "a software RSA 3072 key (rsa-sha2-512)" } },
  { draw: 11, reviewer: "heidi", signer: "heidi", expect: { level: "account", why: "a software ecdsa-sha2-nistp384 key" } },
  { draw: 12, reviewer: "ivan", signer: "ivan", expect: { level: "account", why: "a software ecdsa-sha2-nistp521 key" } },
];
const PROTOCOL = "ab".repeat(32);
const FILE = "audit/w/verdicts.jsonl";
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));

mkdirSync(join(repo, "audit/w"), { recursive: true });
sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
const steps = [];
STEPS.forEach((s, i) => {
  const at = `2026-10-21T0${Math.floor(i / 6) + 3}:${String((i % 6) * 10).padStart(2, "0")}:00Z`;
  appendFileSync(join(repo, FILE), `${sorted({ changeId: `json:acme/widgets#${100 + s.draw}`, draw: s.draw, protocolSha256: PROTOCOL, recordedAt: at, reviewer: s.reviewer, schema: "pr-rla/verdict/v1", verdict: "pass" })}\n`);
  sh("git", ["add", FILE], { cwd: repo });
  const ident = ["-c", "user.name=pr-rla fixture", "-c", "user.email=user-0f1e2d3c@example.invalid"];
  const sign = s.signer ? ["-c", "gpg.format=ssh", "-c", `user.signingkey=${join(work, s.signer)}`, "commit", "-S"] : ["-c", "commit.gpgsign=false", "commit"];
  sh("git", [...ident, ...sign, "-q", "-m", `verdict: draw #${s.draw}`], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  const commit = sh("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  const raw = sh("git", ["cat-file", "commit", commit], { cwd: repo });
  // The oracle at recording time: git's own verify-commit (it runs ssh-keygen -Y find-principals and -Y verify),
  // and ssh-keygen -vv -Y check-novalidate for the security-key flags and counter.
  const verify = spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${join(work, "allowed_signers")}`, "verify-commit", commit], { cwd: repo, env, encoding: "utf8" });
  let skDetails = null;
  if (s.signer) {
    const lines = raw.split("\n");
    const head = lines.slice(0, lines.indexOf(""));
    const sigLines = [];
    const payload = [];
    let inSig = false;
    for (const l of head) {
      if (l.startsWith("gpgsig ")) (inSig = true), sigLines.push(l.slice(7));
      else if (inSig && l.startsWith(" ")) sigLines.push(l.slice(1));
      else (inSig = false), payload.push(l);
    }
    writeFileSync(join(work, "payload"), `${payload.join("\n")}\n${lines.slice(lines.indexOf("")).join("\n")}`);
    writeFileSync(join(work, "payload.sig"), `${sigLines.join("\n")}\n`);
    const nv = spawnSync("ssh-keygen", ["-vv", "-Y", "check-novalidate", "-n", "git", "-s", join(work, "payload.sig")], { input: readFileSync(join(work, "payload")), env, encoding: "utf8" });
    const m = /signature details: counter = (\d+), flags = 0x([0-9a-f]{2})/.exec(nv.stderr);
    if (nv.status !== 0) throw new Error(`ssh-keygen check-novalidate refused draw ${s.draw}: ${nv.stdout}${nv.stderr}`);
    skDetails = m ? { counter: Number(m[1]), flags: Number.parseInt(m[2], 16) } : null;
  }
  steps.push({
    draw: s.draw,
    reviewer: s.reviewer,
    signer: s.signer,
    expect: s.expect,
    file: FILE,
    content: readFileSync(join(repo, FILE), "utf8"),
    tree: sh("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo }).trim(),
    commit,
    raw,
    oracle: {
      gitVerifyCommit: { exit: verify.status, output: `${verify.stdout}${verify.stderr}`.trim().split("\n").filter((l) => /signature/i.test(l)).join("\n") },
      ...(skDetails ? { sshKeygenSignatureDetails: skDetails } : {}),
    },
  });
});

const version = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return `${r.stdout}${r.stderr}`.trim().split("\n")[0];
};
const fixture = {
  source: "synthetic",
  made: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  note: "Verdict commits signed with `git commit -S` (gpg.format=ssh) by ssh-keygen with software keys; the -sk keys live in OpenSSH's sk-dummy test middleware (a software-emulated authenticator), never a hardware key (D7). Public keys only. Made by scripts/make-presence-fixtures.mjs.",
  tools: {
    git: version("git", ["--version"]),
    sshKeygen: version("ssh", ["-V"]),
    skDummy: "OpenSSH 10.3p1 regress/misc/sk-dummy, built from https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.3p1.tar.gz (sha256 56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4) against Homebrew openssl@3",
  },
  allowedSigners: registered,
  unlisted: { mallory: pub.mallory },
  protocolSha256: PROTOCOL,
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${out}: ${steps.length} commits in ${work}`);
for (const s of steps) console.log(`  draw #${s.draw} ${s.signer ?? "(unsigned)"} -> git verify-commit exit ${s.oracle.gitVerifyCommit.exit}${s.oracle.sshKeygenSignatureDetails ? ` · flags 0x${s.oracle.sshKeygenSignatureDetails.flags.toString(16).padStart(2, "0")} counter ${s.oracle.sshKeygenSignatureDetails.counter}` : ""} · ${s.oracle.gitVerifyCommit.output.split("\n")[0] ?? ""}`);
