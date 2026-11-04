import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "./helpers/fake-clock.js";

/**
 * The test helper the pooled suites drive their commands with (U8 fix round). The review found it threw "waiting on
 * something other than the clock" whenever real asynchronous I/O (node:fs/promises, a loopback socket) outlasted 50 turns
 * of the event loop with no fake timer pending, which loaded machines hit intermittently. It now gives such work real
 * time, and calls only a wait of `realLimitMs` of real time with no fake timer pending a hang.
 */
describe("fakeClock.run", () => {
  it("drives fake timers, parallel callers waking at their own times", async () => {
    const clock = fakeClock(0);
    const woke: [string, number][] = [];
    const caller = async (name: string, ms: number) => {
      await clock.sleep(ms);
      woke.push([name, clock.now()]);
    };
    await clock.run(Promise.all([caller("a", 3_600_000), caller("b", 60_000)]));
    expect(woke).toEqual([["b", 60_000], ["a", 3_600_000]]);
  });

  it("waits for real I/O with no fake timer pending (it threw here before the fix round)", async () => {
    const clock = fakeClock(0);
    const dir = mkdtempSync(join(tmpdir(), "prrla-clock-"));
    try {
      const work = (async () => {
        await new Promise((r) => setTimeout(r, 40)); // a loopback round trip: real time, no fake timer
        for (let i = 0; i < 20; i++) await writeFile(join(dir, `f${i}`), String(i)); // threadpool completions
        await clock.sleep(1000); // then a fake wait again
        return Number(await readFile(join(dir, "f19"), "utf8"));
      })();
      expect(await clock.run(work)).toBe(19);
      expect(clock.now()).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports a real hang, after the real-time limit", async () => {
    const clock = fakeClock(0, { realLimitMs: 100 });
    const t0 = Date.now();
    await expect(clock.run(new Promise<void>(() => {}))).rejects.toThrow(/fake clock: the work waited 100 ms of real time with no fake timer pending \(a hang\)/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});
