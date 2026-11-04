import type { Withholding } from "../core/verdict.js";
import type { AuditContext } from "./context.js";

/**
 * Time round B (the coordinator's decision on the CI round's finding): a read the audit needs that failed with 401,
 * 403 or 404 while the plugin ran without a credential (withheld for want of your approval, or not set) does not show
 * that the record is missing: a private tracker or SCM answers an anonymous read that way. What was read through that
 * plugin is then not established: verify's check 5 (the provider) or check 7 (the ledger), and status's verdicts, are
 * INCOMPLETE (exit 6), with the credential and the command that fixes it.
 *
 * Returns that withholding for one plugin, or null when its reads are not in doubt:
 *  - a credential reached it (a 404 under your own credential is the server's answer, judged by the checks themselves);
 *  - no read of it was refused; or
 *  - the server answered some of its reads (2xx): the tracker or repository is readable without a credential, so a 404
 *    among them is the server's answer about that record (a deleted issue on a public tracker still FAILs), and the
 *    plugin's own probes (the ledger's canReadTracker, U8's repo-level probe) tell the rest apart.
 */
export function accessShortfall(ctx: Pick<AuditContext, "broker" | "credentialStanding">, pluginId: string, label: string): Withholding | null {
  const standing = ctx.credentialStanding.get(pluginId);
  if (!standing || standing.granted || (!standing.withheld.length && !standing.missing.length)) return null;
  const denied = ctx.broker.stats.denied.filter((d) => d.pluginId === pluginId && !d.authenticated);
  if (!denied.length || (ctx.broker.stats.answered.get(pluginId) ?? 0) > 0) return null;
  const statuses = [...new Set(denied.map((d) => d.status))].sort().join("/");
  const first = denied[0]!;
  const credential = [
    ...standing.withheld.map((w) => `${w.env} is withheld (not approved for ${w.origins.join(", ") || "its origin"} on this machine)${w.approve.length ? `; approve it: ${w.approve.join(" and ")}` : ""}`),
    ...(standing.missing.length ? [`${standing.missing.join(", ")} ${standing.missing.length > 1 ? "are" : "is"} not set`] : []),
  ].join("; ");
  return {
    verdict: "INCOMPLETE",
    reason: `${label} read ${denied.length} time(s) without a credential and was answered HTTP ${statuses} (e.g. ${first.method} ${first.host}${first.path}): ${credential}. A private tracker or repository answers an anonymous read that way, so what it read is not established; give it the credential and run again`,
  };
}
