import { FREEZE_STORES } from "./freeze-store.js";
import { listPool, type CheckpointOptions as RunCheckpointOptions, type PooledFreeze, type PooledFreezeOptions as RunOptions } from "./pool-list.js";

/**
 * The pooled freeze run with its checkpoint store (functional-design.md §U8). The run itself is
 * src/api/pool-list.ts, which never loads the store; this module, the write side's, is the only one
 * that imports it (src/api/freeze-store.ts), so a preview cannot reach `.pr-rla/cache`.
 */
export { FreezeRepoFailed, FreezeStopped, ResumeRefused, isTransientFailure, type PooledFreeze } from "./pool-list.js";

/** A real freeze's checkpointing: as the run takes it, the store aside (this module supplies it). */
export type CheckpointOptions = Omit<RunCheckpointOptions, "stores">;

export interface PooledFreezeOptions extends Omit<RunOptions, "checkpoint"> {
  /** Present for a real freeze of a list or rule: the run is checkpointed and can resume. Absent: nothing is written. */
  checkpoint?: CheckpointOptions;
}

/** Lists the repos of a set and builds their pooled population, resuming a stopped run when there is one. */
export function freezeRepos(o: PooledFreezeOptions): Promise<PooledFreeze> {
  const { checkpoint, ...rest } = o;
  return listPool({ ...rest, ...(checkpoint ? { checkpoint: { ...checkpoint, stores: FREEZE_STORES } } : {}) });
}

/** A real freeze's checkpointing with the store attached, for a run started elsewhere (src/api/write/freeze.ts). */
export function withCheckpointStore(c: CheckpointOptions): RunCheckpointOptions {
  return { ...c, stores: FREEZE_STORES };
}
