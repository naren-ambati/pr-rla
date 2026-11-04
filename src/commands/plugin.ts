import { checkPlugin, type PluginCheckOptions, type PluginCheckHooks } from "../api/plugin-check.js";
import { commitPluginLock, preparePluginAdd, preparePluginApprove, preparePluginLock, type PluginLockPlan } from "../api/write/plugin.js";
import { isoNow } from "../api/session.js";
import { CORRECTNESS_NOT_SAFETY } from "../plugins/check.js";
import { NETWORK_DENIED_FROM_NODE } from "../plugins/host.js";
import type { LockedCredential, LockEntry, PluginTrust } from "../plugins/lock.js";
import { formatConformanceReport } from "../testing/conformance.js";
import { formatLedgerConformanceReport } from "../testing/ledger-conformance.js";
import { CommandError, type CommandContext } from "./context.js";

/**
 * `pr-rla plugin add | lock | approve | check` (functional-design.md §U2b; FR2.2, FR2.3, FR2.7).
 *
 * `add` and `lock` are the only writers of pr-rla.lock.json (src/api/write/plugin.ts). Both print
 * everything they are about to trust and ask first (or take --yes), and record your approval on this
 * machine (src/plugins/approvals.ts). `approve` records an approval for a plugin someone else locked.
 * `check` writes nothing.
 */

export type { PluginCheckOptions } from "../api/plugin-check.js";

export interface PluginAddOptions {
  yes?: boolean;
  /** "isolated" (default) or "full" (in process, with your environment and files). */
  trust?: string;
}

function trustText(trust: PluginTrust, nodeMajor: number): string {
  if (trust === "full") return "full: IN THIS PROCESS, with your environment and files (every command prints PLUGIN TRUST: full)";
  const net = nodeMajor >= NETWORK_DENIED_FROM_NODE ? "no network" : `Node ${nodeMajor} cannot block its network access`;
  return `isolated: out of process, placeholder credentials, read-only access to its own files; ${net}`;
}

/** `GITEA_TOKEN -> gitea.example.com (the host of option base_url)`. */
function credentialText(c: LockedCredential): string {
  const from = c.hostFromOption === undefined ? "" : c.hosts.length ? ` (the host of option ${c.hostFromOption})` : ` (option ${c.hostFromOption} is not an https:// URL)`;
  return `${c.env} -> ${c.hosts.join(", ") || "none"}${from}`;
}

function describeEntry(e: LockEntry, nodeMajor: number): string[] {
  const list = (a: string[]) => (a.length ? a.join(", ") : "none");
  const integrity = e.npmIntegrity ?? (e.source === "path" ? "none (a path plugin: the tree hash and the audit repo's git history pin it)" : "none (npm installed it from a local path: the tree hash pins it)");
  return [
    `  source        ${e.source}`,
    `  version       ${e.version ?? "none"}`,
    `  resolved      ${e.resolved ?? "none"}`,
    `  npmIntegrity  ${integrity}`,
    `  treeSha256    ${e.treeSha256}`,
    `  trust         ${trustText(e.trust, nodeMajor)}`,
    `  hosts         ${list(e.hosts)}`,
    `  writePaths    ${list(e.writePaths)}`,
    `  credentials   ${e.credentials.length ? e.credentials.map(credentialText).join("; ") : "none"}`,
  ];
}

async function confirm(ctx: CommandContext, yes: boolean | undefined, question: string, command: string): Promise<boolean> {
  if (yes) return true;
  if (!ctx.confirm) throw new CommandError(`${command} needs your confirmation: review the lines above, then run it again with --yes`);
  return ctx.confirm(question);
}

export async function pluginAddCommand(ctx: CommandContext, use: string, opts: PluginAddOptions): Promise<number> {
  const plan = await preparePluginAdd(ctx, use, opts.trust !== undefined ? { trust: opts.trust } : {});
  ctx.out(`plugin add ${use}: ${plan.kind} ${plan.entry.name}`);
  for (const l of describeEntry(plan.entry, plan.nodeMajor)) ctx.out(l);
  for (const w of plan.installScriptWarnings) ctx.err(w);
  if (!(await confirm(ctx, opts.yes, `Trust ${use} as shown and add it to ${plan.lockFile}?`, "plugin add"))) {
    ctx.out("not added");
    return 1;
  }
  const approved = commitPluginLock(ctx, plan);
  ctx.out(`added ${use} to ${plan.lockFile}; commit it with the audit`);
  ctx.out(approved);
  return 0;
}

export async function pluginLockCommand(ctx: CommandContext, use: string, opts: PluginAddOptions): Promise<number> {
  const plan: PluginLockPlan = await preparePluginLock(ctx, use, opts.trust !== undefined ? { trust: opts.trust } : {});
  if (!plan.changes.length) {
    ctx.out(`${use}: unchanged since it was locked (treeSha256 ${plan.entry.treeSha256.slice(0, 12)}…)`);
    return 0;
  }
  ctx.out(`plugin lock ${use}: ${plan.kind} ${plan.entry.name} changed since it was locked`);
  for (const k of plan.changes) ctx.out(`  ${k.padEnd(13)} ${JSON.stringify(plan.previous![k])} -> ${JSON.stringify(plan.entry[k])}`);
  ctx.out("now:");
  for (const l of describeEntry(plan.entry, plan.nodeMajor)) ctx.out(l);
  for (const w of plan.installScriptWarnings) ctx.err(w);
  if (!(await confirm(ctx, opts.yes, `Trust the changed ${use} and update ${plan.lockFile}?`, "plugin lock"))) {
    ctx.out("not updated");
    return 1;
  }
  const approved = commitPluginLock(ctx, plan);
  ctx.out(`updated ${use} in ${plan.lockFile}; commit it with the audit`);
  ctx.out(approved);
  return 0;
}

export interface PluginApproveOptions {
  yes?: boolean;
  /** With `origin`: approve this credential for built-in providers and ledgers. */
  env?: string;
  origin?: string;
}

/**
 * `pr-rla plugin approve <use>`: shows what the plugin, as the audit's lock pins it, would be granted
 * on this machine (its trust, each credential and the origins it may go to), asks (or takes --yes),
 * and records the approval in your approvals file. Nothing in the audit repo changes.
 */
export async function pluginApproveCommand(ctx: CommandContext, use: string | undefined, opts: PluginApproveOptions): Promise<number> {
  const plan = preparePluginApprove(ctx, use, { ...(opts.env !== undefined ? { env: opts.env } : {}), ...(opts.origin !== undefined ? { origin: opts.origin } : {}) });
  for (const l of plan.lines) ctx.out(l);
  if (plan.nothing) {
    ctx.out(plan.nothing);
    return 0;
  }
  if (!(await confirm(ctx, opts.yes, plan.question, "plugin approve"))) {
    ctx.out("not approved");
    return 1;
  }
  ctx.out(plan.record(isoNow(ctx)));
  return 0;
}

export async function pluginCheckCommand(ctx: CommandContext, use: string, opts: PluginCheckOptions): Promise<number> {
  // Printed as the check goes, as before U5: a kit that fails still leaves the report so far.
  let inspected: Parameters<NonNullable<PluginCheckHooks["onInspected"]>>[0] | null = null;
  const r = await checkPlugin(ctx, use, opts, {
    onInspected: (x) => {
      inspected = x;
      ctx.out(`plugin check ${use}: ${x.kind} ${x.name}${x.version ? `@${x.version}` : ""} (${x.source})`);
      ctx.out(`  lock            ${x.lock}`);
    },
    onSignatures: (line) => {
      const x = inspected!;
      ctx.out(`  npm signatures  ${line}`);
      ctx.out(`  hosts           ${x.hosts.join(", ") || "none"}${!x.withoutOptions ? "" : x.optionsFrom ? ` (with the options of ${x.optionsFrom}: not named in .pr-rla.yml)` : " (with no options: not named in .pr-rla.yml)"}`);
      ctx.out(`  credentials     ${x.credentials.length ? x.credentials.map(credentialText).join("; ") : "none"}`);
      for (const w of x.installScriptWarnings) ctx.err(w);
    },
    onConformanceStart: (n) => ctx.out(`  conformance     the ${inspected!.kind} kit through the plugin host, on ${n} recorded fixture(s)`),
  });
  if (!r.conformance.run) ctx.out(`  conformance     not run: ${r.conformance.reason}`);
  else {
    for (const l of (r.kind === "ledger" ? formatLedgerConformanceReport(r.conformance.report) : formatConformanceReport(r.conformance.report)).split("\n")) ctx.out(`    ${l}`);
    ctx.out(`  conformance     ${r.ok ? "PASS" : "FAIL"}`);
  }
  ctx.out(CORRECTNESS_NOT_SAFETY);
  return r.ok ? 0 : 1;
}
