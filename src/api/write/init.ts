import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, CONFIG_TEMPLATE, PROTOCOL_TEMPLATE } from "../../config.js";
import { writeFileAtomic } from "../../io/atomic.js";
import { AuditError } from "../errors.js";
import { requireWritable, type ApiContext } from "../session.js";

export interface InitOptions {
  repo?: string;
  provider?: string;
  force?: boolean;
}

/** `init` (write side): writes .pr-rla.yml, review-protocol.md, audit/ and the .gitignore line for the signing key, each atomically (NFR15). */
export async function initAudit(ctx: ApiContext, opts: InitOptions = {}): Promise<{ config: string; protocol: string; auditDir: string }> {
  requireWritable(ctx, "init");
  const cfg = join(ctx.cwd, CONFIG_FILE);
  if (existsSync(cfg) && !opts.force) throw new AuditError(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  writeFileAtomic(cfg, CONFIG_TEMPLATE(opts.repo ?? "owner/repo", opts.provider ?? "github"));
  const protocol = join(ctx.cwd, "review-protocol.md");
  if (!existsSync(protocol)) writeFileAtomic(protocol, PROTOCOL_TEMPLATE);
  if (!existsSync(join(ctx.cwd, "audit", ".gitkeep"))) writeFileAtomic(join(ctx.cwd, "audit", ".gitkeep"), "");
  const gi = join(ctx.cwd, ".gitignore");
  const ignore = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!ignore.split("\n").includes(".pr-rla/")) writeFileAtomic(gi, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}# pr-rla signing key (never commit)\n.pr-rla/\n`);
  return { config: cfg, protocol, auditDir: join(ctx.cwd, "audit") };
}
