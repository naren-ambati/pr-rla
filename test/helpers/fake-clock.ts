/**
 * A fake clock that parallel callers can share: `sleep(ms)` waits until the clock
 * reaches now + ms, and `run(work)` advances the clock to the earliest pending
 * sleep whenever all work is idle. So two callers sleeping at once wake at their
 * own times, as on a real clock, and a test of a 1-hour budget runs in milliseconds.
 *
 * Work may also wait on real asynchronous I/O (node:fs/promises, a loopback socket):
 * while no fake timer is pending, `run` keeps yielding real time (1 ms at a time, so
 * I/O callbacks run) until a fake timer appears or the work settles. Only a wait of
 * `realLimitMs` of real time with no fake timer pending counts as a hang, and throws.
 */
export const REAL_WAIT_LIMIT_MS = 5_000;

export function fakeClock(start = 0, opts: { realLimitMs?: number } = {}) {
  let now = start;
  let seq = 0;
  const limit = opts.realLimitMs ?? REAL_WAIT_LIMIT_MS;
  const timers: { at: number; seq: number; wake: () => void }[] = [];
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await new Promise<void>((r) => setImmediate(r));
  };
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((wake) => void timers.push({ at: now + Math.max(0, ms), seq: seq++, wake })),
    /** Drives the clock until `work` settles. */
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false;
      work.then(
        () => (done = true),
        () => (done = true),
      );
      for (;;) {
        await settle(() => done);
        if (done) return work;
        if (timers.length === 0) {
          // Nothing waits on the fake clock, so the work waits on real I/O: give it real time.
          const since = Date.now();
          while (!done && timers.length === 0) {
            if (Date.now() - since > limit) throw new Error(`fake clock: the work waited ${limit} ms of real time with no fake timer pending (a hang)`);
            await new Promise<void>((r) => setTimeout(r, 1));
          }
          continue;
        }
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const t = timers.shift()!;
        now = Math.max(now, t.at);
        t.wake();
      }
    },
  };
}
