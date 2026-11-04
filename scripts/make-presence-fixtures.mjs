// Makes the U9 signed-verdict fixture with real OpenSSH tooling and software keys only (D7): one
// SSHSIG per verdict, made by `ssh-keygen -Y sign -n pr-rla-verdict@v1` exactly as a reviewer signs
// by hand (README, "Signed verdicts"), and for the FIDO types through OpenSSH's own test middleware,
// sk-dummy (regress/misc/sk-dummy), loaded through SSH_SK_PROVIDER as OpenSSH's regression tests do.
// sk-dummy is a software-emulated authenticator: it signs with a key it keeps in the key handle and
// sets whatever flags ssh-keygen asks for, so a key made with `-O no-touch-required` signs with the
// user-presence (UP) flag clear. Its counter is a constant.
//
// The signed bytes and the verdict lines are written by the shell's printf with the README's own
// format strings, not by pr-rla: the tests then check that pr-rla reads what the documented manual
// path produces.
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
// Everything happens in a temporary directory, deleted at the end: the keys and the allowed-signers
// file. No key is written to ~/.ssh and nothing is sent anywhere. The fixture keeps public keys only. It is
// synthetic (made here, not read from a public source).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const env = { PATH: process.env.PATH, SSH_SK_PROVIDER: resolve(SK), HOME: work };
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
// The namespaces option admits only verdict signatures: through this file the same key vouches for no git commit.
const registered = KEYS.filter((k) => k.name !== "mallory").map((k) => `${k.name} namespaces="pr-rla-verdict@v1" ${pub[k.name]}`);
writeFileSync(join(work, "allowed_signers"), `${registered.join("\n")}\n`);

const REGISTRATION = createHash("sha256").update("pr-rla synthetic registration for the U9 fixture").digest("hex");
const OTHER_REGISTRATION = createHash("sha256").update("another audit's registration").digest("hex");
const PROTOCOL = "ab".repeat(32);
// draw n names `reviewer`, is signed with `signer`'s key (null: unsigned), for `registration`, in namespace `ns`.
const STEPS = [
  { draw: 1, reviewer: "alice", signer: "alice", expect: { level: "account", why: "a software ed25519 key" } },
  { draw: 2, reviewer: "bob", signer: "bob", expect: { level: "presence", why: "an ed25519-sk key, UP set" } },
  { draw: 3, reviewer: "carol", signer: "carol", expect: { level: "presence", why: "an ecdsa-sk key, UP set" } },
  { draw: 4, reviewer: "dave", signer: "dave", expect: { level: "account", why: "an ed25519-sk key made with no-touch-required: UP clear" } },
  { draw: 5, reviewer: "erin", signer: "erin", expect: { level: "account", why: "an ecdsa-sk key made with no-touch-required: UP clear" } },
  { draw: 6, reviewer: "mallory", signer: "mallory", expect: { level: "self-asserted", why: "signed by a key nobody registered" } },
  { draw: 7, reviewer: "alice", signer: null, expect: { level: "self-asserted", why: "an unsigned verdict" } },
  { draw: 8, reviewer: "alice", signer: "bob", expect: { level: "self-asserted", why: "names alice but bob signed it" } },
  { draw: 9, reviewer: "frank", signer: "frank", expect: { level: "account", why: "a software ecdsa-sha2-nistp256 key" } },
  { draw: 10, reviewer: "grace", signer: "grace", expect: { level: "account", why: "a software RSA 3072 key (rsa-sha2-512)" } },
  { draw: 11, reviewer: "heidi", signer: "heidi", expect: { level: "account", why: "a software ecdsa-sha2-nistp384 key" } },
  { draw: 12, reviewer: "ivan", signer: "ivan", expect: { level: "account", why: "a software ecdsa-sha2-nistp521 key" } },
  { draw: 13, reviewer: "bob", signer: "bob", registration: OTHER_REGISTRATION, expect: { level: "self-asserted", why: "bob's touch, but for another audit's registration" } },
  { draw: 14, reviewer: "bob", signer: "bob", ns: "git", expect: { level: "self-asserted", why: "bob's touch, but in namespace git (a commit signature), not pr-rla-verdict@v1" } },
];

// The README's manual recipe, verbatim: the bytes, then the line.
const PAYLOAD_FORMAT = "pr-rla-verdict/v1\\nregistrationSha256 %s\\nprotocolSha256 %s\\ndraw %s\\nchangeId %s\\nverdict %s\\nreviewer %s\\nrecordedAt %s\\n";
const LINE_FORMAT = '{"changeId":"%s","draw":%s,"protocolSha256":"%s","recordedAt":"%s","registrationSha256":"%s","reviewer":"%s","schema":"pr-rla/verdict/v1","sshsig":"%s","verdict":"%s"}\\n';
const UNSIGNED_FORMAT = '{"changeId":"%s","draw":%s,"protocolSha256":"%s","recordedAt":"%s","reviewer":"%s","schema":"pr-rla/verdict/v1","verdict":"%s"}\\n';

const steps = [];
STEPS.forEach((s, i) => {
  const at = `2026-10-21T0${Math.floor(i / 6) + 3}:${String((i % 6) * 10).padStart(2, "0")}:00Z`;
  const change = `json:acme/widgets#${100 + s.draw}`;
  const reg = s.registration ?? REGISTRATION;
  const file = join(work, `verdict-${s.draw}.txt`);
  sh("sh", ["-c", `printf "$0" "$@" > "${file}"`, PAYLOAD_FORMAT, reg, PROTOCOL, String(s.draw), change, "pass", s.reviewer, at]);
  const payload = readFileSync(file, "utf8");
  let line;
  let oracle = null;
  if (s.signer) {
    // The reviewer's own command; sk-dummy stands in for the authenticator (software, D7).
    sh("ssh-keygen", ["-Y", "sign", "-n", s.ns ?? "pr-rla-verdict@v1", "-f", join(work, s.signer), file]);
    const sig = sh("sh", ["-c", `sed '1d;$d' "${file}.sig" | tr -d '\\n'`]);
    line = sh("sh", ["-c", `printf "$0" "$@"`, LINE_FORMAT, change, String(s.draw), PROTOCOL, at, reg, s.reviewer, sig, "pass"]);
    // The oracle at recording time: ssh-keygen -Y verify against the registered allowed signers, as the
    // reviewer named, and -vv -Y check-novalidate for the security-key flags and counter.
    const v = spawnSync("ssh-keygen", ["-Y", "verify", "-f", join(work, "allowed_signers"), "-I", s.reviewer, "-n", "pr-rla-verdict@v1", "-s", `${file}.sig`], { input: readFileSync(file), env, encoding: "utf8" });
    const nv = spawnSync("ssh-keygen", ["-vv", "-Y", "check-novalidate", "-n", s.ns ?? "pr-rla-verdict@v1", "-s", `${file}.sig`], { input: readFileSync(file), env, encoding: "utf8" });
    if (nv.status !== 0) throw new Error(`ssh-keygen check-novalidate refused draw ${s.draw}: ${nv.stdout}${nv.stderr}`);
    const m = /signature details: counter = (\d+), flags = 0x([0-9a-f]{2})/.exec(nv.stderr);
    oracle = {
      verify: { exit: v.status, output: `${v.stdout}${v.stderr}`.trim().split("\n").filter((l) => /signature|principal/i.test(l)).join("\n") },
      details: m ? { counter: Number(m[1]), flags: Number.parseInt(m[2], 16) } : null,
    };
  } else line = sh("sh", ["-c", `printf "$0" "$@"`, UNSIGNED_FORMAT, change, String(s.draw), PROTOCOL, at, s.reviewer, "pass"]);
  steps.push({ draw: s.draw, reviewer: s.reviewer, signer: s.signer, ...(s.ns ? { namespace: s.ns } : {}), ...(s.registration ? { registrationSha256: s.registration } : {}), expect: s.expect, payload, line, oracle });
});

const version = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return `${r.stdout}${r.stderr}`.trim().split("\n")[0];
};
const fixture = {
  source: "synthetic",
  made: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  note: "One SSHSIG per verdict (namespace pr-rla-verdict@v1), made by ssh-keygen -Y sign with software keys over bytes written by printf with the README's manual recipe; the -sk keys live in OpenSSH's sk-dummy test middleware (a software-emulated authenticator), never a hardware key (D7). Public keys only. Made by scripts/make-presence-fixtures.mjs.",
  tools: {
    sshKeygen: version("ssh", ["-V"]),
    skDummy: "OpenSSH 10.3p1 regress/misc/sk-dummy, built from https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.3p1.tar.gz (sha256 56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4) against Homebrew openssl@3",
    platform: `${process.platform} ${process.arch}`,
  },
  namespace: "pr-rla-verdict@v1",
  registrationSha256: REGISTRATION,
  protocolSha256: PROTOCOL,
  allowedSigners: registered,
  unlisted: { mallory: pub.mallory },
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
// The private keys go with the temporary directory; only public keys are kept.
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}: ${steps.length} verdicts (the temporary keys are deleted)`);
for (const s of steps)
  console.log(`  draw #${String(s.draw).padEnd(2)} ${(s.signer ?? "(unsigned)").padEnd(10)} -> ${s.oracle ? `ssh-keygen -Y verify -I ${s.reviewer}: exit ${s.oracle.verify.exit}${s.oracle.details ? ` · flags 0x${s.oracle.details.flags.toString(16).padStart(2, "0")} counter ${s.oracle.details.counter}` : ""} · ${s.oracle.verify.output.split("\n")[0] ?? ""}` : "no signature"}`);
