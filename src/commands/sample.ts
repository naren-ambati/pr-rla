import { fmt } from "../api/session.js";
import { sample, type SampleOptions as ApiSampleOptions } from "../api/write/sample.js";
import type { CommandContext } from "./context.js";

export interface SampleOptions {
  through?: number;
  beaconFile?: string;
}

export async function sampleCommand(ctx: CommandContext, opts: SampleOptions): Promise<number> {
  const r = await sample(ctx, opts satisfies ApiSampleOptions);
  if (r.outcome === "below-minimum") {
    ctx.out(r.line);
    return 3;
  }
  if (r.outcome === "seed-not-published") {
    ctx.out(`seed round ${r.seedRound} publishes ${r.seedRoundPublishesAt} (in ${r.hoursToGo.toFixed(1)} h); run "pr-rla sample" then`);
    return 2;
  }
  ctx.out(`round ${r.seedRound} verified (BLS, drand quicknet) · randomness ${r.randomness.slice(0, 16)}… · N ${fmt(r.N)} · issued ${r.issued} of cap ${r.cap}`);
  for (const d of r.draws) ctx.out(`  #${String(d.draw).padStart(3)}  ${d.changeId}  ${d.url}${d.firstOccurrence ? "" : "  (drawn before: reuses its verdict)"}`);
  if (r.publishedToLedger)
    ctx.out(`ledger ${r.ledger}: one issue per drawn change (audit/${r.window}/ledger-index.json); review in draw order under ${r.protocolFile} and apply the verdict label on each issue; commit draws.json and ledger-index.json`);
  else ctx.out(`review in draw order under ${r.protocolFile}; record each with "pr-rla record <draw> pass|fail --reviewer <you>" and commit`);
  return 0;
}
