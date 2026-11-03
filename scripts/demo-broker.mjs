// Bolt 2 (U2a) demo, offline: no request leaves the machine (a fake transport answers).
// Usage (after `npm run build`): node scripts/demo-broker.mjs
//   1. A guarded POST throws ReadOnlyViolation; a GraphQL query passes and a mutation does not.
//   2. Two parallel callers share one per-host budget: GitHub's published anonymous REST limit, 60/h.
import { createAuditContext } from "../dist/api/context.js";

const answer = async () => new Response("{}", { headers: { "content-type": "application/json" } });

// 1. The read-only guard.
const ro = createAuditContext({ mode: "read-only", fetch: answer });
const github = ro.broker.bind("provider:github");
const show = async (label, run) => {
  try {
    const res = await run();
    console.log(`${label}: ${res.status} (sent)`);
  } catch (e) {
    console.log(`${label}: ${e.name} ${e.code}: ${e.message}`);
  }
};
console.log("1. read-only guard (an AuditContext in read-only mode, as the MCP server will use)");
await show("   GET  /repos/github/gh-aw", () => github("https://api.github.com/repos/github/gh-aw"));
await show("   POST /graphql query", () => github("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query: "query { viewer { login } }" }) }));
await show("   POST /graphql mutation", () => github("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query: 'mutation { addLabelsToLabelable(input: {labelableId: "I_1", labelIds: ["L_1"]}) { clientMutationId } }' }) }));
await show("   POST /repos/github/gh-aw/issues", () => github("https://api.github.com/repos/github/gh-aw/issues", { method: "POST", body: "{}" }));

// 2. Two callers, one budget, on a fake clock that advances only when every caller is waiting.
function fakeClock() {
  let now = 0;
  const timers = [];
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    now: () => now,
    sleep: (ms) => new Promise((wake) => timers.push({ at: now + ms, wake })),
    async run(work) {
      let done = false;
      work.then(() => (done = true), () => (done = true));
      for (;;) {
        await settle();
        if (done) return work;
        timers.sort((a, b) => a.at - b.at);
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.wake();
      }
    },
  };
}

async function twoCallers(shared) {
  const clock = fakeClock();
  const starts = [];
  const fetch = async (url) => (starts.push({ who: new URL(String(url)).searchParams.get("caller"), at: clock.now() }), answer());
  const make = () => createAuditContext({ mode: "read-write", fetch, nowMs: clock.now, sleep: clock.sleep });
  const one = make();
  const ctx = { a: one, b: shared ? one : make() };
  const caller = async (who) => {
    for (let i = 0; i < 40; i++) await ctx[who].broker.bind(`provider:${who === "a" ? "github" : "gitea"}`)(`https://api.github.com/repos/acme/widgets/pulls?caller=${who}&n=${i}`);
  };
  await clock.run(Promise.all([caller("a"), caller("b")]));
  return starts;
}

console.log("\n2. two parallel callers, 40 anonymous GETs each to api.github.com (default budget: 60/h, burst 60)");
const shared = await twoCallers(true);
const atZero = shared.filter((s) => s.at === 0);
const later = shared.filter((s) => s.at > 0);
console.log(`   one broker:  ${atZero.length} started at 0 s (a: ${atZero.filter((s) => s.who === "a").length}, b: ${atZero.filter((s) => s.who === "b").length}); the other ${later.length} one a minute, at ${later.slice(0, 3).map((s) => `${s.at / 1000} s`).join(", ")} … ${later.at(-1).at / 1000} s`);
const separate = await twoCallers(false);
console.log(`   a broker each (what sharing prevents): ${separate.filter((s) => s.at === 0).length} started at 0 s, over the published limit`);
