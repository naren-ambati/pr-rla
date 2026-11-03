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

test("conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07)", async () => {
  let last = replay();
  const report = await assertProviderConformance(
    (_fixture, harness) => gitea.create(rec.options, { ...harness.context({ fetch: (last = replay()) }), now: () => Date.parse(rec.recordedAt) }),
    [
      {
        name: rec.repo,
        request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] },
        expect: { ids: rec.expected.ids, directPushes: rec.expected.directPushes },
        pagesServed: () => last.served(),
        http: true,
      },
    ],
  );
  assert.equal(report.ok, true);
});
