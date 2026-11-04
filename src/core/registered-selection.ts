import { normalizeLogin } from "../sdk/provider.js";
import { foreign, joinLines, said, type Line } from "./said.js";
import { isRegistrationV2, registeredAccounts, reviewHorizonFor, type AnyManifest, type AnyRegistration, type AuditMode, type SignedRecord } from "./records.js";
import { applySelector, selectorLogins } from "./selector.js";

/**
 * Check 2's account and selection rules (P5, "draws that cannot be steered", finding 2). Offline; pure.
 *
 * - The registration's `accounts` must bind exactly the logins its selector names, each to one account id, sorted. A
 *   prospective v2 registration whose selector names logins without binding them is INCOMPLETE (register refuses to
 *   write one now: an account renamed before the freeze, or a login written onto another account's change, could move a
 *   change in or out); a retrospective one WARNs.
 * - Every change the manifest lists must be one the registered selector selects, applied to the manifest's own records
 *   with the registration's account map: a change whose author the manifest calls by a selected login while its account
 *   id is another FAILs here, offline, as well as in check 5.
 */
export function accountFindings(reg: SignedRecord<AnyRegistration>, mode: AuditMode): { fails: Line[]; incompletes: Line[]; warns: Line[] } {
  const out = { fails: [] as Line[], incompletes: [] as Line[], warns: [] as Line[] };
  // The logins are the registration's (the auditee's signed file): pieces of a line (src/core/said.ts, S1).
  // A login shaped like one (letters, digits, `.`, `_`, `-`, and a `[bot]` suffix, no space) is pr-rla's words; anything else is the registration's text.
  const names = (xs: readonly string[]) => joinLines(xs.map((l) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\[bot\])?$/.test(l) ? l : foreign("a login the registration gives", l))), ", ");
  if (!isRegistrationV2(reg)) return out;
  const logins = selectorLogins(reg.record.selector);
  const accounts = reg.record.accounts;
  if (accounts === undefined) {
    if (!logins.length) return out;
    const what = said`the registration does not bind its selector's logins (${names(logins)}) to account ids (no accounts field: its provider could not resolve them, or it was written before P5), so they match as logins: an account renamed before the freeze, or a login written onto another account's change, could move a change in or out of the stratum`;
    if (mode === "PROSPECTIVE") out.incompletes.push(said`${what}; a prospective audit's population is not established without them`);
    else out.warns.push(said`${what} (a retrospective audit: register warned)`);
    return out;
  }
  if (!Array.isArray(accounts) || accounts.some((a) => !a || typeof a.login !== "string" || typeof a.id !== "string" || a.id === "" || /\s/.test(a.id))) {
    out.fails.push("the registration's accounts are malformed: each is { login, id } with a non-empty id");
    return out;
  }
  const keys = accounts.map((a) => normalizeLogin(a.login));
  if (new Set(keys).size !== keys.length) out.fails.push("the registration's accounts name a login twice");
  if (keys.some((k, i) => i > 0 && keys[i - 1]! >= k)) out.fails.push("the registration's accounts are not sorted by login");
  const want = new Set(logins.map(normalizeLogin));
  const missing = logins.filter((l) => !keys.includes(normalizeLogin(l)));
  const extra = accounts.filter((a) => !want.has(normalizeLogin(a.login))).map((a) => a.login);
  if (missing.length) out.fails.push(said`the registration's accounts do not bind ${missing.length} login(s) its selector names (${names(missing)})`);
  if (extra.length) out.fails.push(said`the registration's accounts bind ${extra.length} login(s) its selector does not name (${names(extra)})`);
  return out;
}

/** The ids of manifest changes the registered selector does not select, applied to the manifest's own records (P5). */
export function unselectedManifestChanges(reg: SignedRecord<AnyRegistration>, m: AnyManifest): string[] {
  const kept = new Set(applySelector(m.changes, reg.record.selector, m.frozenAt, { accounts: registeredAccounts(reg), horizon: reviewHorizonFor(reg) }).selected.map((c) => c.id));
  return m.changes.filter((c) => !kept.has(c.id)).map((c) => c.id);
}
