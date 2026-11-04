import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, CONFIG_TEMPLATE, PROTOCOL_TEMPLATE } from "../../config.js";
import { requireReadWrite } from "../context.js";
import { AuditError } from "../errors.js";
import { auditContextFor, type ApiContext } from "../session.js";

export interface InitOptions {
  repo?: string;
  provider?: string;
  force?: boolean;
}

/** `init` (write side): writes .pr-rla.yml, review-protocol.md, audit/ and the .gitignore line for the signing key. */
export async function initAudit(ctx: ApiContext, opts: InitOptions = {}): Promise<{ config: string; protocol: string; auditDir: string }> {
  requireReadWrite(auditContextFor(ctx), "init");
  const cfg = join(ctx.cwd, CONFIG_FILE);
  if (existsSync(cfg) && !opts.force) throw new AuditError(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  writeFileSync(cfg, CONFIG_TEMPLATE(opts.repo ?? "owner/repo", opts.provider ?? "github"));
  const protocol = join(ctx.cwd, "review-protocol.md");
  if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_TEMPLATE);
  mkdirSync(join(ctx.cwd, "audit"), { recursive: true });
  if (!existsSync(join(ctx.cwd, "audit", ".gitkeep"))) writeFileSync(join(ctx.cwd, "audit", ".gitkeep"), "");
  const gi = join(ctx.cwd, ".gitignore");
  const ignore = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!ignore.split("\n").includes(".pr-rla/")) appendFileSync(gi, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}# pr-rla signing key (never commit)\n.pr-rla/\n`);
  return { config: cfg, protocol, auditDir: join(ctx.cwd, "audit") };
}
