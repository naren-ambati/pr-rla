import { randomBytes } from "node:crypto";
import { ToolError, toToolError, type ToolErrorBody } from "./errors.js";

/**
 * Long calls and their jobs (contracts.md §4, NFR20), in memory only: they die with the process.
 *
 * - A network-capable call that is still running at `handoffMs` (25 s) returns `{ jobId }` and keeps
 *   running in this process. Before the hand-off its progress goes to the caller as MCP progress
 *   notifications; after it, the call is over (MCP allows progress only while a request is open),
 *   so the job keeps its latest progress for `job_status`.
 * - At most `maxJobs` (4) such calls run at once, in their tool call or as jobs; a fifth is refused
 *   with TOO_MANY_JOBS before it starts.
 * - A finished job is kept `ttlMs` (600 s), then dropped; a result over `maxResultBytes` (8 MiB)
 *   is not kept: the job fails with RESULT_TOO_LARGE.
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
}

export const DEFAULT_LIMITS: JobLimits = { handoffMs: 25_000, maxJobs: 4, ttlMs: 600_000, maxResultBytes: 8 * 1024 * 1024 };

interface Job {
  id: string;
  tool: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  progress?: Progress;
  result?: unknown;
  error?: ToolErrorBody;
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

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private inflight = 0;
  private readonly controllers = new Set<AbortController>();

  constructor(
    readonly limits: JobLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly tools: readonly string[] = [],
  ) {}

  /** Long calls running now (in their tool call or as jobs). */
  get running(): number {
    return this.inflight;
  }

  /** Drops finished jobs older than the TTL. */
  sweep(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== undefined && t - j.finishedAt >= this.limits.ttlMs) this.jobs.delete(id);
  }

  /** Runs a long call: its result if it settles within handoffMs, else a job handle. */
  async run(tool: string, work: (h: { progress: (p: Progress) => void; signal: AbortSignal }) => Promise<unknown>, whileOpen?: (p: Progress) => void): Promise<{ kind: "result"; value: unknown } | { kind: "job"; handle: JobHandle }> {
    this.sweep();
    if (this.inflight >= this.limits.maxJobs)
      throw new ToolError("TOO_MANY_JOBS", `${this.inflight} long calls are already running, the most this server runs at once (${this.limits.maxJobs})`, `poll job_status until one finishes, then call ${tool} again`);
    this.inflight++;
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    let open = true;
    let job: Job | null = null;
    let latest: Progress | undefined;
    const progress = (p: Progress) => {
      latest = p;
      if (job) job.progress = p;
      else if (open) whileOpen?.(p);
    };
    const settled = (async () => {
      try {
        return { ok: true as const, value: await work({ progress, signal: ctrl.signal }) };
      } catch (e) {
        return { ok: false as const, error: e };
      } finally {
        this.inflight--;
        this.controllers.delete(ctrl);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handoff = new Promise<"handoff">((r) => (timer = setTimeout(() => r("handoff"), this.limits.handoffMs)));
    const first = await Promise.race([settled, handoff]);
    clearTimeout(timer);
    open = false;
    if (first !== "handoff") {
      if (first.ok) return { kind: "result", value: first.value };
      throw first.error;
    }
    const j: Job = { id: `${tool}:${randomBytes(12).toString("hex")}`, tool, state: "running", startedAt: this.now(), ...(latest ? { progress: latest } : {}) };
    job = j;
    this.jobs.set(j.id, j);
    void settled.then((s) => {
      j.finishedAt = this.now();
      if (!s.ok) {
        j.state = "failed";
        j.error = toToolError(s.error);
        return;
      }
      const bytes = resultBytes(s.value);
      if (bytes > this.limits.maxResultBytes) {
        j.state = "failed";
        j.error = toToolError(tooLarge(bytes, this.limits.maxResultBytes, tool));
      } else {
        j.state = "done";
        j.result = s.value;
      }
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

  /** Stops every running call (the client went away). */
  close(): void {
    for (const c of this.controllers) c.abort(new Error("pr-rla-mcp is shutting down"));
  }
}
