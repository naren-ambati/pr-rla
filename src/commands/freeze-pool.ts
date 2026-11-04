import { estimateFreeze, estimateLines } from "../api/freeze-estimate.js";
import { FreezeRepoFailed, FreezeStopped, ResumeRefused, freezeRepos, type PooledFreeze } from "../api/pooled-freeze.js";
import type { PrRlaConfig } from "../config.js";
import { RepoSetError, resolveRepoSet, type ResolvedRepo } from "../core/repo-set.js";
import { isRegistrationV2, type AnyRegistration, type RepoSet, type SignedRecord } from "../core/records.js";
import type { Selector } from "../core/selector.js";
import { EXIT } from "../cli/exit-codes.js";
import { pluginIdentity } from "../registry.js";
import type { AuditWindow, ScmProvider } from "../sdk/provider.js";
import type { ResolvedWindow } from "../core/window.js";
import { PR_RLA_VERSION } from "../version.js";
import { auditContextFor, CommandError, type CommandContext } from "./context.js";

/**
 * The command side of a pooled freeze (U8): `freeze` calls these two functions, and they call src/api. A
 * repo set error, a stopped run and a refused resume become CommandErrors with the exit code and the next step
 * (contracts.md §7: exit 4 means re-running the printed command finishes the job).
 */

/** The resume command a stopped run prints. */
export const resumeCommand = (runId: string) => `pr-rla freeze --resume ${runId}`;

const wall = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

export interface RunArgs {
  provider: ScmProvider;
  repoSet: RepoSet;
  window: ResolvedWindow;
  selector: Selector;
  startedAt: string;
  reg: SignedRecord<AnyRegistration> | null;
  dryRun: boolean;
  force: boolean;
  resume: string | undefined;
}

export async function runFreezeRepos(ctx: CommandContext, config: PrRlaConfig, a: RunArgs): Promise<PooledFreeze> {
  const checkpointed = a.repoSet.kind !== "repo" && !a.dryRun && a.reg !== null && isRegistrationV2(a.reg);
  if (a.resume !== undefined && !checkpointed) throw new CommandError("--resume continues a pooled freeze of a registered repo list or rule; this freeze has nothing to resume");
  const stats = auditContextFor(ctx).broker.stats;
  const requests0 = stats.requests;
  const graphql = () => [...stats.byHost.values()].reduce((n, h) => n + h.graphql, 0);
  const graphql0 = graphql();
  const t0 = ctx.nowMs();
  try {
    const done = await freezeRepos({
      provider: a.provider,
      set: a.repoSet,
      window: a.window,
      selector: a.selector,
      startedAt: a.startedAt,
      concurrency: config.freeze.concurrency,
      log: (l) => ctx.err(l),
      ...(checkpointed
        ? {
            checkpoint: {
              base: config.dir,
              windowName: a.window.name,
              registrationSha256: a.reg!.sha256,
              prRlaVersion: PR_RLA_VERSION,
              provider: await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins),
              ...(a.resume !== undefined ? { resume: a.resume } : {}),
              ...(a.force ? { fresh: true } : {}),
            },
          }
        : {}),
    });
    if (a.repoSet.kind !== "repo") ctx.err(`freeze: ${done.repos.length} repos · ${done.fetched} listed now, ${done.resumed} from checkpoints · ${stats.requests - requests0} requests (${graphql() - graphql0} GraphQL) · ${wall(ctx.nowMs() - t0)}`);
    return done;
  } catch (e) {
    if (e instanceof FreezeStopped) throw new CommandError(`${e.message}. The ${e.done} repos listed are checkpointed${e.runId ? `; no manifest was written. Continue with: ${resumeCommand(e.runId)}` : ""}`, EXIT.STOPPED);
    if (e instanceof FreezeRepoFailed || e instanceof ResumeRefused || e instanceof RepoSetError) throw new CommandError(e.message);
    throw e;
  }
}

export interface EstimateArgs {
  provider: ScmProvider;
  repoSet: RepoSet;
  window: AuditWindow;
  selector: Selector;
  concurrency: number;
  /** Unix seconds seed round R publishes, when a registration names it. */
  publishesAt: number | null;
  json: boolean | undefined;
}

/** `freeze --dry-run --estimate`: resolve the set, probe, print. Reads only; writes no checkpoint. */
export async function estimateCommand(ctx: CommandContext, a: EstimateArgs): Promise<number> {
  const actx = auditContextFor(ctx);
  const before = actx.broker.stats.requests;
  let resolved: ResolvedRepo[];
  try {
    resolved = await resolveRepoSet(a.provider, a.repoSet);
  } catch (e) {
    if (e instanceof RepoSetError) throw new CommandError(e.message);
    throw e;
  }
  if (resolved.length === 0) throw new CommandError("the repo set matches no repository the token can see; widen the rule, or check the token's access");
  const listing = actx.broker.stats.requests - before;
  const est = await estimateFreeze({ ctx: actx, provider: a.provider, resolved, window: a.window, selector: a.selector, listingRequests: listing, concurrency: a.concurrency });
  const msLeft = a.publishesAt === null ? null : a.publishesAt * 1000 - ctx.nowMs();
  if (a.json) ctx.out(JSON.stringify({ estimate: est, msLeftBeforeR: msLeft }, null, 2));
  else for (const l of estimateLines(est, msLeft)) ctx.out(l);
  return 0;
}
