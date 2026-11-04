import { RETRIES_EXHAUSTED, TIMED_OUT } from "../sdk/http.js";
import { isRepoUnavailable, REPO_UNAVAILABLE, type RepoRef, type ScmProvider } from "../sdk/provider.js";

/**
 * How the core reads a provider's failures (U8): transient (wait it out), a repository that is gone (decided only by
 * one repo-level probe), or anything else. Shared by the pooled freeze (src/api) and verify (check 5).
 */

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/**
 * Whether a failure is the kind that waiting out fixes: the broker (or a provider that retries itself) gave up on rate
 * limits, timeouts or 5xx, or the connection dropped. Works across the plugin host, where only `code`, `status` and
 * `rateLimited` survive. A rate-limited error is transient whatever status it carries (GitHub's secondary limit is a 403).
 */
export function isTransientFailure(e: unknown): boolean {
  // The broker's BrokerRetriesExhausted and BrokerTimeout carry these codes (src/net/contract.ts); the core reads the code.
  const x = e as { code?: unknown; status?: unknown; rateLimited?: unknown; cause?: { code?: unknown } } | null;
  if (!x || typeof x !== "object") return false;
  if (x.code === RETRIES_EXHAUSTED || x.code === TIMED_OUT || x.rateLimited === true) return true;
  // A provider that gave up itself (status 0, e.g. GitHubHttpError GAVE_UP), or reports a server-side status.
  if (x.status === 0 || x.status === 429 || (typeof x.status === "number" && x.status >= 500 && x.status < 600)) return true;
  const code = typeof x.code === "string" ? x.code : typeof x.cause?.code === "string" ? x.cause.code : null;
  return code !== null && NETWORK_CODES.has(code);
}

/** A listing error that may mean the repository is gone (a 404 or 403 that is not transient): only a probe can say. */
export function looksUnavailable(e: unknown): boolean {
  return !isTransientFailure(e) && isRepoUnavailable(e);
}

export type ProbeResult =
  | { kind: "exists"; ref: RepoRef }
  /** The repo-level probe answered 404, or the provider's documented hidden 403 (a RepoUnavailableError). */
  | { kind: "gone"; status: 403 | 404; detail: string }
  /** The probe answered 403 without the provider calling it a hidden repository: the caller has no access. */
  | { kind: "no-access"; status: number; detail: string }
  | { kind: "transient"; detail: string; error: unknown }
  /** The provider cannot probe a repository (no describeRepo). */
  | { kind: "unsupported" }
  | { kind: "error"; detail: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One repo-level metadata probe (`describeRepo`), classified. By id where one is known, so a renamed repo is found. */
export async function probeRepo(provider: Pick<ScmProvider, "describeRepo">, ref: { repo: string; id?: string | null }): Promise<ProbeResult> {
  if (typeof provider.describeRepo !== "function") return { kind: "unsupported" };
  try {
    const got = await provider.describeRepo({ repo: ref.repo, ...(ref.id ? { id: ref.id } : {}) });
    if (!got || typeof got !== "object" || typeof got.repo !== "string" || typeof got.id !== "string") return { kind: "error", detail: `describeRepo returned ${JSON.stringify(got)?.slice(0, 120)}, not a repository` };
    return { kind: "exists", ref: got };
  } catch (e) {
    if (isTransientFailure(e)) return { kind: "transient", detail: message(e), error: e };
    const x = e as { code?: unknown; status?: unknown };
    if (x?.code === REPO_UNAVAILABLE) return { kind: "gone", status: x.status === 403 ? 403 : 404, detail: message(e) };
    if (x?.status === 404) return { kind: "gone", status: 404, detail: message(e) };
    if (x?.status === 403) return { kind: "no-access", status: 403, detail: message(e) };
    return { kind: "error", detail: message(e) };
  }
}
