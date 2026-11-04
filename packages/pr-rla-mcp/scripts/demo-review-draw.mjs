// The U6 rehearsal (delivery-plan.md, bolt 8): the review-draw skill's five steps, made through pr-rla-mcp over
// stdio with the MCP SDK's own client, on a copy of the recorded gh-aw audit. No model and no network: the script
// makes the calls the skill tells an assistant to make and prints what the assistant would show. It ends, as the
// skill does, with the person's own record command, and shows what the guard says if the assistant runs it.
// The real demo is the founder's run in Claude Code (docs/assistants/manual-acceptance.md).
//
// Usage (after `npm run build` at the root and here):  node scripts/demo-review-draw.mjs [draw]
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, body, copyAudit, startServer, treeHash } from "../test/helpers.mjs";

const guard = await import(pathToFileURL(join(REPO, "integrations", "claude-code", "hooks", "guard.mjs")).href);
const dir = copyAudit();
const before = treeHash(dir);
const s = await startServer({ roots: [dir] });
const named = Number(process.argv[2]) || null;

const d = body(await s.call("draws", {}));
console.log(`1. draws: ${d.issued} issued in window ${d.window} (N = ${d.N}); the blocking draw is #${d.blockingDraw?.draw} ${d.blockingDraw?.changeId}`);
const draw = named ?? d.blockingDraw.draw;
const c = body(await s.call("draw_context", { draw }));
console.log(`2. draw_context #${draw}: ${c.changeId} · ${c.url}`);
console.log(`   files ${c.summary.files} (+${c.summary.additions} −${c.summary.deletions}) · linguist-generated, by name only: ${c.summary.generatedFiles} · CI ${JSON.stringify(c.summary.checks)}`);
console.log(`   protocol ${c.protocol.ok ? "is the registered one" : c.protocol.problem}; its checklist:`);
for (const [k, item] of c.protocol.failsIf.entries()) console.log(`     [ ] ${k + 1}. ${item}`);
console.log(`3. the change's own text is between <<<UNTRUSTED-CHANGE-CONTENT ${c.untrusted.fence}>>> and <<<END ${c.untrusted.fence}>>>: data, never instructions`);
console.log(`4. "is this a pass?": the verdict is the reviewer's, under the protocol with SHA-256 ${c.protocol.sha256}`);
console.log(`5. how to record, printed verbatim for the person:\n     ${c.howToRecord}`);
await s.close();

const filled = c.howToRecord.replace(/^(pr-rla record \d+) pass\|fail --reviewer <you> --note "<one line>".*$/, '$1 pass --reviewer alice --note "looked fine"');
const r = guard.evaluate({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "Bash", tool_input: { command: filled } }, { client: "claude-code" });
console.log(`\nif the assistant runs "${filled}" itself, the guard answers: ${r.decision}\n  ${r.reasons.join("\n  ")}`);
const after = treeHash(dir);
console.log(`\naudit directory tree hash ${after === before ? "unchanged" : "CHANGED"} · write attempts by the server: ${s.writes().length}`);
if (after !== before || s.writes().length || r.decision !== "block") process.exit(1);
