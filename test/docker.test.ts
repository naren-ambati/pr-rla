import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Docker image (2026-11-14): pr-rla and pr-rla-mcp built from this repository, for running without the npm
 * registry. Building it needs Docker, so this checks what the image is made of; docs/docker.md records the build and
 * the runs that were checked against live audits.
 */
const ROOT = join(import.meta.dirname, "..");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

describe("the Dockerfile", () => {
  it("pins its Node 22 base image by digest, in both stages", () => {
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile.match(/^FROM \$\{NODE_IMAGE\}/gm)).toHaveLength(2);
    expect(dockerfile).not.toMatch(/^FROM (?!\$\{NODE_IMAGE\})/m);
  });

  it("builds from the lockfiles, ships production dependencies only, and runs no install script", () => {
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/);
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(dockerfile).not.toMatch(/npm install(?! -g)/);
  });

  it("has what pr-rla runs at run time: git and ssh-keygen", () => {
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends git openssh-client ca-certificates/);
  });

  it("puts both commands on PATH, runs as the unprivileged node user, and starts pr-rla", () => {
    expect(dockerfile).toMatch(/ln -s \/opt\/pr-rla\/dist\/cli\.js \/usr\/local\/bin\/pr-rla\b/);
    expect(dockerfile).toMatch(/ln -s \/opt\/pr-rla\/packages\/pr-rla-mcp\/dist\/bin\.js \/usr\/local\/bin\/pr-rla-mcp\b/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["pr-rla"\]$/m);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.licenses="Apache-2\.0"/);
  });

  it("the build context is an allow-list: tests, fixtures and node_modules stay out", () => {
    const ignore = readFileSync(join(ROOT, ".dockerignore"), "utf8").split("\n");
    expect(ignore[ignore.findIndex((l) => !l.startsWith("#"))]).toBe("*");
    for (const keep of ["!src/", "!packages/pr-rla-mcp/", "!package-lock.json", "!LICENSE"]) expect(ignore).toContain(keep);
    expect(ignore).toContain("packages/pr-rla-mcp/node_modules/");
    expect(ignore).not.toContain("!test/");
  });

  it("docs/docker.md gives an MCP server entry that is valid JSON, mounts the audit read-only and passes the token by name", () => {
    const doc = readFileSync(join(ROOT, "docs", "docker.md"), "utf8");
    const json = /```json\n([\s\S]*?)\n```/.exec(doc)![1]!;
    const entry = (JSON.parse(json) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers["pr-rla"]!;
    expect(entry.command).toBe("docker");
    expect(entry.args).toEqual(expect.arrayContaining(["-i", "--entrypoint", "pr-rla-mcp", "-e", "GITHUB_TOKEN"]));
    expect(entry.args.find((a) => a.endsWith(":/audit:ro"))).toBeDefined();
    expect(existsSync(join(ROOT, "Dockerfile"))).toBe(true);
  });
});
