import { BrokerError } from "../../net/contract.js";
import { BROKER_REFUSALS, MAX_UNTRUSTED_BYTES, PLUGIN_REFUSALS, errorLabel, untrustedText } from "../../core/said.js";
import { PluginError } from "../../plugins/errors.js";
import { AuditError, type AuditErrorCode } from "../errors.js";

/** At most this much of a foreign error's text is kept in `untrusted`. */
export const MAX_UNTRUSTED_ERROR_BYTES = MAX_UNTRUSTED_BYTES;

const cut = untrustedText;

/**
 * What a read call throws, always an AuditError whose `message` and `next` are pr-rla's (U5 fix
 * round: M3, review 2 finding 1). pr-rla's own refusals keep their code and words. Anything else
 * (an SCM's HTTP error with its response body, a provider's or a ledger's exception, a plugin's
 * message, whatever code it claims) becomes PROVIDER_ERROR with a fixed sentence, and its text goes
 * to `untrusted`, so a server's echo of a request never reads as pr-rla speaking. Classes decide,
 * never a `code` field: an isolated plugin's error crosses the IPC as a plain Error with any code.
 */
export function readError(e: unknown): unknown {
  if (e instanceof AuditError) return e;
  const err = e as { name?: unknown; message?: unknown; status?: unknown };
  // A stopped call (its signal aborted): the caller knows why, and says so. Only the runtime's own (a DOMException):
  // an error from across the plugin host can name itself AbortError, with any message and code (S1).
  if ((err?.name === "AbortError" || err?.name === "TimeoutError") && e instanceof DOMException) return e;
  if (e instanceof BrokerError) {
    if (e.code === "READ_ONLY_VIOLATION") return new AuditError(e.message, 1, "READ_ONLY_VIOLATION", e.next);
    if (e.code === "BROKER_TIMEOUT") return new AuditError(e.message, 1, "TIMEOUT", e.next);
    if (BROKER_REFUSALS.has(e.code)) return new AuditError(e.message, 1, "FAILED", e.next);
    // Retries exhausted: the SCM's last answer is in the message.
    const a = new AuditError(`${e.host}: the service did not answer usefully (${e.code})`, 1, "PROVIDER_ERROR", e.next);
    a.untrusted = cut(e.message);
    return a;
  }
  if (e instanceof PluginError) {
    if (PLUGIN_REFUSALS.has(e.code)) return new AuditError(e.message, 1, "FAILED", e.next);
    if (e.code === "PLUGIN_HOST_TIMEOUT") return new AuditError("a plugin stopped answering (PLUGIN_HOST_TIMEOUT)", 1, "TIMEOUT", e.next);
    const a = new AuditError(`a plugin failed (${e.code}); what it said is in untrusted`, 1, "PROVIDER_ERROR", e.next);
    a.untrusted = cut(e.message);
    return a;
  }
  const a = new AuditError(`the provider, the ledger or a plugin failed (${errorLabel(e)}); what it said is in untrusted`, 1, "PROVIDER_ERROR" as AuditErrorCode);
  a.untrusted = cut(typeof err?.message === "string" ? err.message : String(e));
  return a;
}
