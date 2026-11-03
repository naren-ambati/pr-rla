/**
 * A fake clock that parallel callers can share: `sleep(ms)` waits until the clock
 * reaches now + ms, and `run(work)` advances the clock to the earliest pending
 * sleep whenever all work is idle. So two callers sleeping at once wake at their
 * own times, as on a real clock, and a test of a 1-hour budget runs in milliseconds.
 */
export function fakeClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers: { at: number; seq: number; wake: () => void }[] = [];
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
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
        await settle();
        if (done) return work;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const t = timers.shift();
        if (!t) throw new Error("fake clock: the work is waiting on something other than the clock");
        now = Math.max(now, t.at);
        t.wake();
      }
    },
  };
}
