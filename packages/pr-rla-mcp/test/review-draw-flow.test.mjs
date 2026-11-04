// review-draw-flow.test.mjs (U6, FR3.7; functional-design.md §U6): the review-draw skill's five steps, as an
// assistant would take them, through this server over stdio, on the recorded gh-aw audit. No model is involved:
// the test makes the calls the skill tells the assistant to make, and checks what each step needs is there. It
// also checks the skill names only tools this server has, all read-only, and that the guard blocks the record
// command the skill ends with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO, body, copyAudit, startServer, treeHash } from "./helpers.mjs";

const SKILL = join(REPO, "integrations", "claude-code", "skills", "review-draw", "SKILL.md");
const PORTABLE = join(REPO, "integrations", "agents", "skills", "review-draw", "SKILL.md");
const GUARD = join(REPO, "integrations", "claude-code", "hooks", "guard.mjs");
const PREFIX = "mcp__plugin_pr-rla_pr-rla__";

let dir;
let s;
let before0;
let guard;

before(async () => {
  dir = copyAudit();
  before0 = treeHash(dir);
  s = await startServer({ roots: [dir] });
  guard = await import(pathToFileURL(GUARD).href);
});
after(async () => {
  await s?.close();
});

describe("the review-draw skill against pr-rla-mcp", () => {
  it("names only this server's tools, each read-only, under the plugin's scoped names", async () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(SKILL, "utf8"))[1];
    const allowed = /^allowed-tools: (.*)$/m.exec(fm)[1].split(/\s+/).filter((t) => t.startsWith("mcp__"));
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.ok(allowed.length >= 4);
    for (const t of allowed) {
      assert.ok(t.startsWith(PREFIX), t);
      const tool = byName.get(t.slice(PREFIX.length));
      assert.ok(tool, `${t} is not a tool of pr-rla-mcp`);
      assert.equal(tool.annotations?.readOnlyHint, true, t);
      assert.equal(tool.annotations?.destructiveHint, false, t);
    }
    // Every tool the body tells the assistant to call is one of them.
    const body = readFileSync(SKILL, "utf8");
    for (const m of body.matchAll(/[Cc]all `([a-z_]+)`|poll `([a-z_]+)`/g)) assert.ok(allowed.includes(PREFIX + (m[1] ?? m[2])), m[0]);
    assert.equal(readFileSync(PORTABLE, "utf8").split("\n---\n")[1], body.split("\n---\n")[1]);
  });

  it("step 1: draws lists the issued draws and names the blocking draw", async () => {
    const d = body(await s.call("draws", {}));
    assert.equal(d.issued, 36);
    assert.equal(d.verdictsRead, true);
    assert.equal(d.blockingDraw.draw, 1);
    assert.equal(d.draws[0].state, "unlabelled");
  });

  it("step 2: draw_context gives the header, CI results, the checklist and the files, generated files by name only", async () => {
    const c = body(await s.call("draw_context", { draw: 13 }));
    assert.equal(c.changeId, "github:github/gh-aw#49685");
    assert.equal(c.summary.files, 7);
    assert.equal(c.summary.generatedFiles, 21);
    assert.equal(c.untrusted.generatedFiles.length, 21);
    for (const f of c.untrusted.files) assert.ok(!c.untrusted.generatedFiles.includes(f.path));
    assert.deepEqual(c.summary.checks, { success: 1 });
    assert.equal(c.protocol.ok, true);
    assert.ok(c.protocol.failsIf.length > 0);
    assert.match(c.text, /the change FAILS if any of these holds:/);
  });

  it("step 3: the change's own text is inside the core's fence, apart from pr-rla's words", async () => {
    const c = body(await s.call("draw_context", { draw: 13 }));
    const id = c.untrusted.fence;
    const open = c.text.indexOf(`<<<UNTRUSTED-CHANGE-CONTENT ${id}>>>`);
    const close = c.text.indexOf(`<<<END ${id}>>>`);
    assert.ok(open >= 0 && close > open);
    const title = c.untrusted.title;
    assert.ok(title && c.text.indexOf(title) > open && c.text.indexOf(title) < close);
    assert.ok(c.text.indexOf("record the verdict yourself") > close);
  });

  it("step 4: the context carries the protocol's hash for the answer to 'is this a pass?', and no verdict of pr-rla's", async () => {
    const c = body(await s.call("draw_context", { draw: 1 }));
    assert.match(c.protocol.sha256, /^[0-9a-f]{64}$/);
    assert.equal(c.state.verdict, "unlabelled");
    assert.equal(c.blocksPrefix, true);
  });

  it("step 5: howToRecord is the person's own command, which the guard blocks from the assistant", async () => {
    const c = body(await s.call("draw_context", { draw: 13 }));
    assert.equal(c.howToRecord, 'pr-rla record 13 pass|fail --reviewer <you> --note "<one line>", then commit audit/2026-q3/verdicts.jsonl');
    // The assistant running it, filled in, is blocked; so is appending the line itself.
    const run = (command) => guard.evaluate({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "Bash", tool_input: { command } }, { client: "claude-code", env: { HOME: dir } });
    assert.equal(run('pr-rla record 13 pass --reviewer alice --note "ok"').decision, "block");
    assert.equal(run(`echo '{"draw":13,"verdict":"pass"}' >> audit/2026-q3/verdicts.jsonl`).decision, "block");
    assert.equal(run("pr-rla status --offline").decision, "allow");
  });

  it("the flow wrote nothing: the audit directory is byte-identical and the server attempted no write", () => {
    assert.equal(treeHash(dir), before0);
    assert.deepEqual(s.writes(), []);
  });
});
