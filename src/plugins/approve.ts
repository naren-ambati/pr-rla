import type { PluginSpec } from "../registry.js";
import { approveBuiltin, approvePlugin, checkBuiltinPair, grantsOf, grantText, parseHttpsOrigin, readApprovals, type LocalConsent } from "./approvals.js";
import { builtinCredentialUses } from "./builtin-credentials.js";
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
    ...(entry.writePaths.length ? [`  writePaths    ${entry.writePaths.join(", ")} (where a ledger may write, with the credentials above)`] : []),
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

/** Approved on this machine or a built-in default; `--accept-lock-grants` settles nothing for good. */
const settled = (consent: LocalConsent, env: string, origin: string) => {
  const s = consent.builtin(env, origin);
  return s === "approved" || s === "default";
};

/**
 * The approval of what a built-in provider or ledger, with the options the audit gives it, would send
 * beyond the built-in defaults: each variable that is set here, to each origin it would go to. Only
 * https origins can be approved (a token is never sent in clear text).
 */
export function planBuiltinApproval(consent: LocalConsent, kind: "provider" | "ledger", name: string, spec: PluginSpec, env: Readonly<Record<string, string | undefined>>): ApprovalPlan {
  const uses = builtinCredentialUses(kind, name, spec.options);
  const set = uses.filter((u) => !!env[u.env]);
  const pairs = set.flatMap((u) => u.origins.map((origin) => ({ env: u.env, origin })));
  const plain = pairs.filter((p) => !p.origin.startsWith("https://"));
  const open = pairs.filter((p) => p.origin.startsWith("https://") && !settled(consent, p.env, p.origin));
  const lines = [
    `${kind} ${spec.use} (built in) with this audit's options would send:`,
    ...(set.length ? set.map((u) => `  ${u.env} -> ${u.origins.join(", ")}${u.origins.every((o) => settled(consent, u.env, o)) ? " (approved already, or a built-in default)" : ""}`) : [`  nothing: none of ${uses.map((u) => u.env).join(", ") || "its variables"} is set here`]),
    ...plain.map((p) => `  ${p.env} -> ${p.origin} cannot be approved: not https, so it is never sent`),
  ];
  return {
    lines,
    nothing: open.length ? null : set.length ? `nothing to approve for ${spec.use}${plain.length ? " (only https origins can be approved)" : ""}` : `nothing to approve for ${spec.use}; set the variable you use and run this again, or: pr-rla plugin approve --env <ENV> --origin <https-url>`,
    question: `Let built-in providers and ledgers on this machine send ${open.map((p) => `${p.env} to ${p.origin}`).join(", ")}?`,
    record(approvedAt) {
      for (const p of open) approveBuiltin(consent.file, p.env, p.origin, approvedAt);
      return `approved ${open.map((p) => `${p.env} -> ${p.origin}`).join(", ")} for built-in providers and ledgers on this machine (${consent.file})`;
    },
  };
}

/** `plugin approve --env <ENV> --origin <url>`: one credential for built-ins, without an audit repo. */
export function planBuiltinPairApproval(consent: LocalConsent, env: string, origin: string): ApprovalPlan {
  checkBuiltinPair(env, origin);
  const o = parseHttpsOrigin(origin)!;
  const lines = [`built-in providers and ledgers may send ${env} to ${o}`];
  return {
    lines,
    nothing: o && settled(consent, env, o) ? `${env} -> ${o} is approved already, or a built-in default` : null,
    question: `Let built-in providers and ledgers on this machine send ${env} to ${o}?`,
    record(approvedAt) {
      const a = approveBuiltin(consent.file, env, origin, approvedAt);
      return `approved ${a.env} -> ${a.origin} for built-in providers and ledgers on this machine (${consent.file})`;
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
