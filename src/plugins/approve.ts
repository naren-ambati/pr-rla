import { approvePlugin, grantsOf, grantText, readApprovals, type LocalConsent } from "./approvals.js";
import { verifyLocked, type LockEntry, type PluginTrust } from "./lock.js";

/**
 * `pr-rla plugin approve` (the plugin and broker fix round, finding 1): what a plugin someone else
 * locked may do on this machine, shown in full, then recorded in the approvals file once the person
 * running it confirms. Nothing in the audit repo changes.
 */

export interface ApprovalPlan {
  /** What will be granted, for the person to read before confirming. */
  lines: string[];
  /** Nothing to approve (already approved, or an isolated plugin that asks for no credential). */
  nothing: string | null;
  question: string;
  /** Records the approval; returns the line to print. */
  record(approvedAt: string): string;
}

export function trustLine(trust: PluginTrust): string {
  return trust === "full" ? "full: IN THIS PROCESS, with your environment and files" : "isolated: out of process; it sees placeholders, never your secrets";
}

export function entryApprovalLines(use: string, entry: LockEntry): string[] {
  const grants = grantsOf(entry.credentials);
  return [
    `plugin ${use}: ${entry.name}${entry.version ? `@${entry.version}` : ""} (${entry.source}${entry.resolved ? ` ${entry.resolved}` : ""}), treeSha256 ${entry.treeSha256}`,
    `  trust         ${trustLine(entry.trust)}`,
    `  credentials   ${grants.length ? grants.map(grantText).join("; ") : "none"}`,
    `  hosts         ${entry.hosts.length ? entry.hosts.join(", ") : "none"} (contacted without credentials unless granted above)`,
  ];
}

/** The approval of `use` as the audit's lock pins it now (its files re-hashed first). */
export function planPluginApproval(consent: LocalConsent, auditDir: string, use: string): ApprovalPlan {
  const { entry } = verifyLocked(use, auditDir);
  const lines = entryApprovalLines(use, entry);
  const approved = consent.plugin(use, entry) === "approved";
  const asks = entry.trust === "full" || entry.credentials.length > 0;
  return {
    lines,
    nothing: approved ? `${use} is already approved on this machine, as locked (${consent.file})` : !asks ? `${use} runs isolated and asks for no credential: it needs no approval` : null,
    question: `Approve ${use} on this machine, granting what is shown?`,
    record(approvedAt) {
      approvePlugin(consent.file, use, entry, approvedAt);
      return `approved ${use} on this machine (${consent.file}); a change to its files, trust or grants needs a new approval`;
    },
  };
}

/** Records your approval of what you just locked (`plugin add`, `plugin lock`): locking it is consenting to it. */
export function recordLockApproval(consent: LocalConsent, use: string, entry: LockEntry, approvedAt: string): string {
  approvePlugin(consent.file, use, entry, approvedAt);
  return `approved on this machine too (${consent.file}); anyone else who runs this audit approves it on theirs (pr-rla plugin approve ${use})`;
}

/** Every approval in the file, for tests and diagnostics. */
export const approvalsIn = (consent: LocalConsent) => readApprovals(consent.file).approvals;
