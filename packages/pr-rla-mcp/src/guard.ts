import { callScope } from "./jobs.js";

/**
 * The process-level guard (S1). A promise that rejects with nothing awaiting it ends a Node process by default; one
 * bug in a handler would then stop every other job of the server, and drop the jobs' results. The guard logs such a
 * rejection and keeps the process serving. It never swallows one: the tool call the rejection came from (found by its
 * async context, src/jobs.ts `callScope`) fails with FAILED, its text in `untrusted`; a rejection outside every call
 * is logged only. A synchronous exception that nothing caught is not guarded: it can leave state half-changed, so the
 * process ends as Node decides.
 */
export function installProcessGuard(log: (line: string) => void): () => void {
  const onRejection = (reason: unknown) => {
    const call = callScope.getStore();
    const what = (reason as { name?: unknown } | null)?.name;
    log(`internal error: a promise rejected that nothing awaited (${typeof what === "string" ? what.slice(0, 64) : typeof reason}); ${call ? `the ${call.tool} call it came from fails` : "it came from no tool call"}, and the server keeps serving`);
    call?.fail(reason);
  };
  process.on("unhandledRejection", onRejection);
  return () => void process.off("unhandledRejection", onRejection);
}
