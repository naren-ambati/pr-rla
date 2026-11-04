// The plugin's own test: the pr-rla conformance kit on recorded Codeberg (Forgejo) responses,
// under node:test. Run with `npm install && npm test` in this directory (pr-rla must be built).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertProviderConformance } from "pr-rla/testing";
import gitea from "../index.mjs";

const rec = JSON.parse(readFileSync(new URL("../fixtures/codeberg-forgejo-docs-2026-10-01.json", import.meta.url), "utf8"));

/** Serves recorded exchanges in order of first unused match; an unrecorded request throws (stays offline). */
function replay() {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  let served = 0;
  const f = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const key = typeof init?.body === "string" ? createHash("sha256").update(init.body).digest("hex") : null;
    const hit = queue.find((q) => !q.used && q.e.url === url && q.e.bodySha256 === key);
    if (!hit) throw new Error(`unrecorded request ${url}`);
    hit.used = true;
    served++;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json", ...hit.e.headers } });
  };
  f.served = () => served;
  return f;
}

const id = (n) => `gitea:forgejo/docs#${n}`;
const human = (login) => ({ login, kind: "human" });
const bot = (login) => ({ login: `${login}[bot]`, kind: "bot" });

test("conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07)", async () => {
  let last = replay();
  // The kit FAILs a check no fixture exercises unless skipChecks says why, so the expectations below are the
  // recording's own, checked by hand (pr-rla's test/gitea-example.test.ts declares the same).
  const report = await assertProviderConformance(
    (_fixture, harness) => gitea.create(rec.options, { ...harness.context({ fetch: (last = replay()) }), now: () => Date.parse(rec.recordedAt) }),
    [
      {
        name: rec.repo,
        request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] },
        expect: {
          ids: rec.expected.ids,
          directPushes: rec.expected.directPushes,
          // Forgejo reports 0 additions/deletions on #2219 and #2221; their files list 7+3 and 4+6.
          changedLines: { [id(2219)]: 10, [id(2221)]: 10, [id(2218)]: 73 },
          reviewStates: { [id(2070)]: ["CHANGES_REQUESTED", "APPROVED"] },
          reviewers: { [id(2070)]: [human("limiting-factor"), human("mahlzahn")] },
          actors: { [id(2070)]: { author: human("Colin"), mergedBy: human("Gusted") }, [id(2215)]: { author: bot("forgejo-actions"), mergedBy: human("mahlzahn") } },
          // #2206 landed as a commit with no "(#2206)" in its message: matched by merge_commit_sha.
          mergeShas: { [id(2206)]: rec.exchanges.find((e) => e.url.endsWith("/pulls/2206")).response.merge_commit_sha },
          bots: ["viceice-bot[bot]", "forgejo-actions[bot]"],
          humans: ["mahlzahn", "Gusted", "aahlenst"],
          reviewGranularity: "submission",
        },
        pagesServed: () => last.served(),
        http: true,
      },
    ],
    { skipChecks: { "revoked-approval": "the recorded window has no withdrawn approval" } },
  );
  assert.equal(report.ok, true);
});
