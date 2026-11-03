import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, CONFIG_TEMPLATE, PROTOCOL_TEMPLATE } from "../config.js";
import { CommandError, type CommandContext } from "./context.js";

export async function initCommand(ctx: CommandContext, opts: { repo?: string; provider?: string; force?: boolean }): Promise<number> {
  const cfg = join(ctx.cwd, CONFIG_FILE);
  if (existsSync(cfg) && !opts.force) throw new CommandError(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  writeFileSync(cfg, CONFIG_TEMPLATE(opts.repo ?? "owner/repo", opts.provider ?? "github"));
  const protocol = join(ctx.cwd, "review-protocol.md");
  if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_TEMPLATE);
  mkdirSync(join(ctx.cwd, "audit"), { recursive: true });
  if (!existsSync(join(ctx.cwd, "audit", ".gitkeep"))) writeFileSync(join(ctx.cwd, "audit", ".gitkeep"), "");
  const gi = join(ctx.cwd, ".gitignore");
  const ignore = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!ignore.split("\n").includes(".pr-rla/")) appendFileSync(gi, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}# pr-rla signing key (never commit)\n.pr-rla/\n`);
  ctx.out(`wrote ${CONFIG_FILE}, review-protocol.md, audit/`);
  ctx.out("next: edit the selector and window, finalize review-protocol.md, then `pr-rla register --dry-run`");
  return 0;
}
