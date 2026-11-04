import { randomBytes } from "node:crypto";
import { ToolError, toToolError, type ToolErrorBody } from "./errors.js";

/**
 * Long calls and their jobs (contracts.md §4, NFR20), in memory only: they die with the process.
 *
 * - A long call that is still running at `handoffMs` (25 s) returns `{ jobId }` and keeps running
 *   in this process. Before the hand-off its progress goes to the caller as MCP progress
 *   notifications, and the MCP request's own cancellation stops it; after it, the call is over
 *   (MCP allows progress only while a request is open), so the job keeps its latest progress for
 *   `job_status`.
 * - At most `maxJobs` (4) such calls run at once, in their tool call or as jobs; a fifth is refused
 *   with TOO_MANY_JOBS before it starts. A slot is released when the work ends, however it ends.
 * - Each runs for at most `deadlineMs` (by default pr-rla/api/read's LONG_CALL_DEADLINE_MS, derived
 *   from the broker's per-host budgets): then its signal aborts and it fails with TIMEOUT.
 * - A finished job is kept `ttlMs` (600 s), then dropped. A result over `maxResultBytes` (8 MiB, the
 *   whole `job_status` answer counted) is not kept: the job fails with RESULT_TOO_LARGE. Finished
 *   jobs together keep at most `maxFinished` jobs and `maxFinishedBytes` bytes: the oldest go first.
 * - `close()` aborts every running call and resolves once they have all ended.
 */

export interface Progress {
  done?: number;
  total?: number;
  message: string;
}

export interface JobLimits {
  handoffMs: number;
  maxJobs: number;
  ttlMs: number;
  maxResultBytes: number;
  /** How long a long call may run in all, in its tool call or as a job. */
  deadlineMs: number;
  /** Finished jobs kept at once (the oldest is dropped first). */
  maxFinished: number;
  /** Bytes of finished jobs' answers kept at once (the oldest is dropped first). */
  maxFinishedBytes: number;
}

const MIB = 1024 * 1024;

/**
 * The defaults. `deadlineMs` here is only a fallback: the server passes LONG_CALL_DEADLINE_MS.
 * Finished jobs: as many results, at the 8 MiB limit, as there are slots (4 × 8 MiB = 32 MiB), and
 * at most 32 jobs whatever their size: enough for every call of 600 s of polling at the 4-call limit
 * to be read back, without letting small results pile up without bound.
 */
export const DEFAULT_LIMITS: JobLimits = { handoffMs: 25_000, maxJobs: 4, ttlMs: 600_000, maxResultBytes: 8 * MIB, deadlineMs: 3_600_000, maxFinished: 32, maxFinishedBytes: 32 * MIB };

interface Job {
  id: string;
  tool: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  progress?: Progress;
  result?: unknown;
  error?: ToolErrorBody;
  /** Bytes of this job's job_status answer, once finished. */
  bytes: number;
}

export interface JobHandle {
  jobId: string;
  state: "running";
  tool: string;
  startedAt: string;
  next: string;
}

export type JobStatus =
  | { jobId: string; tool: string; state: "running"; startedAt: string; progress?: Progress }
  | { jobId: string; tool: string; state: "done"; startedAt: string; finishedAt: string; result: unknown }
  | { jobId: string; tool: string; state: "failed"; startedAt: string; finishedAt: string; error: ToolErrorBody }
  | { jobId: string; state: "unknown"; message: string };

const iso = (ms: number) => new Date(ms).toISOString();

/** A result's size: the bytes of its JSON (the wire carries it twice, as structuredContent and as text). */
export const resultBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

export function tooLarge(bytes: number, limit: number, tool: string): ToolError {
  return new ToolError("RESULT_TOO_LARGE", `the ${tool} result is ${bytes.toLocaleString("en-US")} bytes, over the ${limit.toLocaleString("en-US")}-byte limit`, tool === "draw_context" ? "call draw_context again with a smaller maxPatchBytes" : `narrow the call, or run the pr-rla CLI for the full result`);
}

/** Why a call's signal aborted: the deadline, the server closing, or the client cancelling the request. */
class Stopped extends Error {
  constructor(
    message: string,
    readonly code: "TIMEOUT" | "CANCELLED",
  ) {
    super(message);
    this.name = "Stopped";
  }
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private inflight = 0;
  private readonly running = new Map<AbortController, Promise<unknown>>();
  private closed = false;

  constructor(
    readonly limits: JobLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly tools: readonly string[] = [],
  ) {}

  /** Long calls running now (in their tool call or as jobs). */
  get active(): number {
    return this.inflight;
  }

  /** Finished jobs kept now, and the bytes of their answers. */
  get finished(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const j of this.jobs.values())
      if (j.state !== "running") {
        count++;
        bytes += j.bytes;
      }
    return { count, bytes };
  }

  /** Drops finished jobs older than the TTL, then the oldest finished ones over the count and byte bounds. */
  sweep(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== undefined && t - j.finishedAt >= this.limits.ttlMs) this.jobs.delete(id);
    const done = [...this.jobs.values()].filter((j) => j.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let bytes = done.reduce((a, j) => a + j.bytes, 0);
    let count = done.length;
    for (const j of done) {
      if (count <= this.limits.maxFinished && bytes <= this.limits.maxFinishedBytes) break;
      this.jobs.delete(j.id);
      count--;
      bytes -= j.bytes;
    }
  }

  /**
   * Runs a long call: its result if it settles within handoffMs, else a job handle. `requestSignal`
   * (the MCP request's) stops the call while it is still the caller's, before the hand-off.
   */
  async run(
    tool: string,
    work: (h: { progress: (p: Progress) => void; signal: AbortSignal }) => Promise<unknown>,
    whileOpen?: (p: Progress) => void,
    requestSignal?: AbortSignal,
  ): Promise<{ kind: "result"; value: unknown } | { kind: "job"; handle: JobHandle }> {
    this.sweep();
    if (this.closed) throw new ToolError("FAILED", "pr-rla-mcp is shutting down and starts no more calls", "start the server again");
    if (this.inflight >= this.limits.maxJobs)
      throw new ToolError("TOO_MANY_JOBS", `${this.inflight} long calls are already running, the most this server runs at once (${this.limits.maxJobs})`, `poll job_status until one finishes, then call ${tool} again`);
    this.inflight++;
    const startedAt = this.now();
    const ctrl = new AbortController();
    let open = true;
    let job: Job | null = null;
    let latest: Progress | undefined;
    const progress = (p: Progress) => {
      latest = p;
      if (job) job.progress = p;
      else if (open) whileOpen?.(p);
    };
    const minutes = Math.round(this.limits.deadlineMs / 60_000);
    const deadline = setTimeout(() => ctrl.abort(new Stopped(`${tool} stopped at its deadline, ${minutes >= 1 ? `${minutes} min` : `${this.limits.deadlineMs} ms`} after it started`, "TIMEOUT")), this.limits.deadlineMs);
    const onRequestAbort = () => ctrl.abort(new Stopped(`${tool} was cancelled by the client`, "CANCELLED"));
    if (requestSignal?.aborted) onRequestAbort();
    else requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
    const settled = (async () => {
      try {
        return { ok: true as const, value: await work({ progress, signal: ctrl.signal }) };
      } catch (e) {
        // A stop by the deadline or by close() is reported as such, whatever the work threw on its way out.
        return { ok: false as const, error: ctrl.signal.aborted && ctrl.signal.reason instanceof Stopped ? ctrl.signal.reason : e };
      } finally {
        clearTimeout(deadline);
        requestSignal?.removeEventListener("abort", onRequestAbort);
        this.inflight--;
        this.running.delete(ctrl);
      }
    })();
    this.running.set(ctrl, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handoff = new Promise<"handoff">((r) => (timer = setTimeout(() => r("handoff"), this.limits.handoffMs)));
    const first = await Promise.race([settled, handoff]);
    clearTimeout(timer);
    open = false;
    // The request is answered now (a result or a handle): its cancellation no longer reaches the work.
    requestSignal?.removeEventListener("abort", onRequestAbort);
    if (first !== "handoff") {
      if (first.ok) return { kind: "result", value: first.value };
      throw first.error;
    }
    const j: Job = { id: `${tool}:${randomBytes(12).toString("hex")}`, tool, state: "running", startedAt, bytes: 0, ...(latest ? { progress: latest } : {}) };
    job = j;
    this.jobs.set(j.id, j);
    void settled.then((s) => {
      j.finishedAt = this.now();
      if (s.ok) {
        const answer = { jobId: j.id, tool, state: "done", startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt), result: s.value };
        const bytes = resultBytes(answer);
        if (bytes <= this.limits.maxResultBytes) {
          j.state = "done";
          j.result = s.value;
          j.bytes = bytes;
          return this.sweep();
        }
        j.error = toToolError(tooLarge(bytes, this.limits.maxResultBytes, tool));
      } else j.error = toToolError(s.error);
      j.state = "failed";
      j.bytes = resultBytes({ jobId: j.id, tool, state: "failed", startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt), error: j.error });
      this.sweep();
    });
    return { kind: "job", handle: { jobId: j.id, state: "running", tool, startedAt: iso(j.startedAt), next: `still running after ${Math.round(this.limits.handoffMs / 1000)} s; poll job_status with this jobId` } };
  }

  status(jobId: string): JobStatus {
    this.sweep();
    const j = this.jobs.get(jobId);
    if (!j) {
      const tool = this.tools.find((t) => jobId.startsWith(`${t}:`));
      return { jobId, state: "unknown", message: `Unknown job (the server restarted or it expired): run ${tool ?? "the tool"} again` };
    }
    if (j.state === "running") return { jobId, tool: j.tool, state: "running", startedAt: iso(j.startedAt), ...(j.progress ? { progress: j.progress } : {}) };
    if (j.state === "done") return { jobId, tool: j.tool, state: "done", startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt!), result: j.result };
    return { jobId, tool: j.tool, state: "failed", startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt!), error: j.error! };
  }

  /** Stops every running call (the client went away) and starts no more; resolves when they have all ended. */
  close(): Promise<void> {
    this.closed = true;
    for (const c of this.running.keys()) c.abort(new Stopped("pr-rla-mcp is shutting down", "CANCELLED"));
    return Promise.allSettled([...this.running.values()]).then(() => {});
  }
}
