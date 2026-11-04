import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as read from "pr-rla/api/read";
import { checkPlugin } from "../src/api/plugin-check.js";
import { nodeContext } from "../src/commands/context.js";
import { localConsent } from "../src/plugins/approvals.js";
import { closeAllPluginHosts } from "../src/plugins/host.js";
import { fixturePath } from "./helpers/fixtures.js";

/** Round S1 (integration seams), items 6 and 7. Fixtures: the recorded gh-aw audit (recorded), the rest synthetic. */

const NOW = Date.parse("2026-11-04T00:00:00Z");
const noNet = (async () => {
  throw new Error("no network");
}) as typeof fetch;
const recorded = () => {
  const dir = mkdtempSync(join(tmpdir(), "prrla-s1-"));
  cpSync(fixturePath("audits", "gh-aw-q3-recorded"), dir, { recursive: true });
  return dir;
};

afterEach(() => closeAllPluginHosts());

describe("item 6: plugin check runs npm by absolute path, never one the audit repo supplies", () => {
  const PATH = process.env.PATH;
  afterEach(() => {
    process.env.PATH = PATH;
  });

  it("with a relative PATH entry first, the npm committed beside the plugin's lockfile does not run; the one on PATH's absolute entries does", async () => {
    // An audit repo with a package plugin (synthetic) and an `npm` of its own, where `npm audit signatures` runs (the lockfile's directory).
    const dir = mkdtempSync(join(tmpdir(), "prrla-s1-npm-"));
    mkdirSync(join(dir, "node_modules", "s1-provider"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "s1-provider", "package.json"), JSON.stringify({ name: "s1-provider", version: "0.0.1", type: "module", main: "index.mjs" }));
    writeFileSync(join(dir, "node_modules", "s1-provider", "index.mjs"), 'export default { providerApiVersion: 1, name: "s1", hosts: () => [], create: () => ({ apiVersion: 1, name: "s1", async listChanges() { return { changes: [], defaultBranch: "main", limitations: [] }; } }) };\n');
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/s1-provider": { version: "0.0.1", resolved: "https://registry.npmjs.org/s1-provider/-/s1-provider-0.0.1.tgz", integrity: "sha512-synthetic" } } }));
    const planted = join(dir, "planted-ran");
    writeFileSync(join(dir, "npm"), `#!/bin/sh\ntouch "${planted}"\necho "audited 1 package: the audit repo's own npm"\n`);
    chmodSync(join(dir, "npm"), 0o755);
    // The npm on PATH (synthetic: no registry is asked).
    const bin = mkdtempSync(join(tmpdir(), "prrla-s1-bin-"));
    writeFileSync(join(bin, "npm"), '#!/bin/sh\necho "audited 1 package: the npm found on PATH"\n');
    chmodSync(join(bin, "npm"), 0o755);
    process.env.PATH = `.:${bin}:${PATH}`;

    let line = "";
    await checkPlugin(nodeContext({ cwd: dir, env: process.env, fetch: noNet, out: () => {}, err: () => {} }), "s1-provider", {}, { onSignatures: (l) => (line = l) }).catch(() => null);
    expect(existsSync(planted)).toBe(false);
    expect(line).toBe("ok: audited 1 package: the npm found on PATH");
  }, 60_000);

  it("no npm on PATH's absolute entries: the signatures are skipped with the reason, and the relative entry is not searched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-s1-npm-"));
    mkdirSync(join(dir, "node_modules", "s1-provider"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "s1-provider", "package.json"), JSON.stringify({ name: "s1-provider", version: "0.0.1", type: "module", main: "index.mjs" }));
    writeFileSync(join(dir, "node_modules", "s1-provider", "index.mjs"), 'export default { providerApiVersion: 1, name: "s1", hosts: () => [], create: () => ({ apiVersion: 1, name: "s1", async listChanges() { return { changes: [], defaultBranch: "main", limitations: [] }; } }) };\n');
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/s1-provider": { version: "0.0.1" } } }));
    const planted = join(dir, "planted-ran");
    writeFileSync(join(dir, "npm"), `#!/bin/sh\ntouch "${planted}"\n`);
    chmodSync(join(dir, "npm"), 0o755);
    // Only the relative entry and a directory with no npm (the host's node is found by its absolute path, not PATH).
    process.env.PATH = `.:${mkdtempSync(join(tmpdir(), "prrla-s1-empty-"))}`;
    let line = "";
    await checkPlugin(nodeContext({ cwd: dir, env: process.env, fetch: noNet, out: () => {}, err: () => {} }), "s1-provider", {}, { onSignatures: (l) => (line = l) }).catch(() => null);
    expect(existsSync(planted)).toBe(false);
    expect(line).toBe("skipped: npm is not on PATH");
  }, 60_000);
});

describe("item 7: an invalid PR_RLA_ACCEPT_LOCK_GRANTS does not break read-only calls, which ignore it", () => {
  it("read.status and read.verify answer under PR_RLA_ACCEPT_LOCK_GRANTS=true, with one warning in the process; the CLI's consent still refuses the value", async () => {
    const dir = recorded();
    const log: string[] = [];
    const opts: read.ReadOptions = { nowMs: () => NOW, fetch: noNet, env: { PR_RLA_ACCEPT_LOCK_GRANTS: "true" }, log: (l) => log.push(l) };
    await expect(read.status({ dir }, opts)).resolves.toMatchObject({ phase: "sampled" });
    await expect(read.verify({ dir, offline: true }, opts)).resolves.toMatchObject({ verdict: expect.any(String) });
    await expect(read.draws({ dir }, opts)).resolves.toMatchObject({ issued: expect.any(Number) });
    expect(log.filter((l) => /PR_RLA_ACCEPT_LOCK_GRANTS/.test(l))).toEqual(["PR_RLA_ACCEPT_LOCK_GRANTS is ignored in read-only mode (pr-rla/api/read, the MCP server): it takes only the approvals stored on this machine (pr-rla plugin approve)"]);
    // A person's CLI (read-write) still refuses a typo, so it is never silent there.
    expect(() => localConsent({ PR_RLA_ACCEPT_LOCK_GRANTS: "true" })).toThrow(/PR_RLA_ACCEPT_LOCK_GRANTS "true": use 1/);
  }, 120_000);
});
