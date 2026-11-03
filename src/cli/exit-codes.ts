/**
 * The CLI exit-code contract (contracts.md §7). Existing codes never change meaning.
 * 0 success · 1 verify FAIL, refused plugin, clock skew over 10 minutes, usage error ·
 * 2 ESCALATE or R not yet published · 3 population below the registered minimum ·
 * 4 stopped before finishing; re-running the printed command finishes it ·
 * 5 record written without enough timestamps (n of k, including 0 of k).
 */
export const EXIT = {
  OK: 0,
  FAIL: 1,
  ESCALATE: 2,
  BELOW_MINIMUM: 3,
  STOPPED: 4,
  TIMESTAMPS_SHORT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
