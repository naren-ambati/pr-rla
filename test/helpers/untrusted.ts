/**
 * Round S1: a read-only result says pr-rla's words where it quotes text from outside pr-rla, and points into
 * `untrusted.errors` (src/core/said.ts). For comparing it with the CLI's own object (`--json`, which quotes the text in
 * place): every value that is wholly such a pointer becomes the text again, and `untrusted` is dropped. A pointer in
 * the middle of a sentence is left as it is, so a comparison that meets one fails, saying where.
 */
export function resolveUntrusted<T>(result: T): T {
  const errors = ((result as { untrusted?: { errors?: string[] } }).untrusted?.errors ?? []) as string[];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = /^[^;]*; what it said is in untrusted\.errors\[(\d+)\]$/.exec(v);
      return m ? errors[Number(m[1])] : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "untrusted").map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(result) as T;
}
