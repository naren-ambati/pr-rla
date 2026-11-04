import type { TestKey } from "./sshsig-signer.js";

/**
 * The `.pr-rla.yml` lines that register reviewers' SSH keys for signed git-file verdicts (U9):
 * `verdicts.allowed_signers`, the key setting since the fix round. The regression tests in
 * u9-review-regressions.test.ts build their audits through this one function, so the same tests can
 * be run against the branch before the fix by swapping it for that branch's shape (keys in
 * `verdicts.reviewers`), which is how the report shows each one failing before the fix.
 */
export function signedVerdictsYaml(o: { min?: "self-asserted" | "account" | "presence"; requireSigned?: boolean; signers: { principal: string; key: TestKey }[] }): string {
  const lines = o.signers.map((s) => JSON.stringify(s.key.allowedSigner(s.principal)));
  return [
    `ledger: { use: git-file${o.requireSigned ? ", options: { require_signed: true }" : ""} }`,
    `verdicts: { ${o.min ? `min_provenance: ${o.min}, ` : ""}allowed_signers: [${lines.join(", ")}] }`,
    "",
  ].join("\n");
}
