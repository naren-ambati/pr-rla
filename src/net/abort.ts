/**
 * Cancellation helpers (U5 fix round): a read call's AbortSignal reaches every request, wait and
 * plugin call the call makes, so a job that is stopped (its deadline, the server closing) stops.
 */

/** The reason a signal aborted, as an Error (an AbortError when none was given). */
export function abortReason(signal: AbortSignal): Error {
  const r = signal.reason as unknown;
  return r instanceof Error ? r : Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

/** `p`, or a rejection as soon as `signal` aborts (the work behind `p` is not stopped by this). */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/** A real wait that ends early, and clears its timer, when `signal` aborts. */
export function sleepFor(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => (signal?.removeEventListener("abort", onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(t), reject(abortReason(signal!)));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A sleep that `signal` interrupts; an injected sleep (a fake clock) is raced with the signal. */
export function signalledSleep(sleep: ((ms: number) => Promise<void>) | undefined, signal?: AbortSignal): (ms: number) => Promise<void> {
  if (!signal) return sleep ?? ((ms) => sleepFor(ms));
  return sleep ? (ms) => abortable(sleep(ms), signal) : (ms) => sleepFor(ms, signal);
}

/** A fetch whose every request also carries `signal` (combined with the request's own). */
export function signalledFetch(f: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (!signal) return f;
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return f(input, { ...init, signal: own ? AbortSignal.any([own, signal]) : signal });
  }) as typeof fetch;
}
