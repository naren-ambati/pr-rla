#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { CommandError, nodeContext, type CommandContext } from "./commands/context.js";
import { freezeCommand } from "./commands/freeze.js";
import { initCommand } from "./commands/init.js";
import { recordCommand } from "./commands/record.js";
import { registerCommand } from "./commands/register.js";
import { sampleCommand } from "./commands/sample.js";
import { simulateCommand } from "./commands/simulate.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";
import { PR_RLA_VERSION } from "./version.js";

export function buildProgram(makeCtx: (g: { dir?: string; config?: string; fromFile?: string }) => CommandContext, setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name("pr-rla")
    .description("Risk-limiting audits for code changes that landed with no recorded human review")
    .version(PR_RLA_VERSION)
    .option("-C, --dir <path>", "audit repo directory (holds .pr-rla.yml)")
    .option("-c, --config <path>", "config file (default <dir>/.pr-rla.yml)")
    .option("--from-file <changes.json>", "use the json-file provider with this export instead of the configured provider")
    .showHelpAfterError();

  const collect = (v: string, prev: string[] = []) => [...prev, v];
  const run = (fn: (ctx: CommandContext) => Promise<number>) => async () => {
    const g = program.opts<{ dir?: string; config?: string; fromFile?: string }>();
    const ctx = makeCtx(g);
    try {
      setExit(await fn(ctx));
    } catch (e) {
      ctx.err(`pr-rla: ${(e as Error).message}`);
      setExit(e instanceof CommandError ? e.exitCode : 1);
    }
  };

  program
    .command("init")
    .description("write .pr-rla.yml, review-protocol.md and audit/")
    .option("--repo <owner/name>", "repository to audit")
    .option("--provider <name>", "github | gitlab | bitbucket-cloud | bitbucket-data-center | json-file | ./path.mjs | package", "github")
    .option("--force", "overwrite an existing .pr-rla.yml")
    .action(function (this: Command) {
      return run((ctx) => initCommand(ctx, this.opts()))();
    });

  program
    .command("register")
    .description("sign the selector, window, parameters and protocol hash (before the population is frozen)")
    .option("--dry-run", "print the registration and derived seed round; write nothing")
    .option("--submit", "submit to a Rekor transparency log (requires --rekor-url; entries are public and permanent)")
    .option("--rekor-url <url>", "Rekor log URL (no default on purpose)")
    .option("--rekor-api <v1|v2>", "Rekor API for --submit (v2: unverified against the production log; needs --yes)")
    .option("--yes", "confirm a Rekor v2 submission")
    .option("--key <path>", "ECDSA P-256 signing key (created if missing)")
    .option("--force", "replace an existing registration")
    .option("--tsa-trust <file>", "extra timestamp-authority anchors (repeatable)", collect)
    .action(function (this: Command) {
      return run((ctx) => registerCommand(ctx, this.opts()))();
    });

  program
    .command("freeze")
    .description("list every change that landed in the window, apply the registered selector, write the manifest")
    .option("--dry-run", "print the population (with the config selector if unregistered); write nothing")
    .option("--submit", "submit the manifest commitment to a Rekor log (requires --rekor-url)")
    .option("--rekor-url <url>", "Rekor log URL")
    .option("--rekor-api <v1|v2>", "Rekor API for --submit (v2: unverified against the production log; needs --yes)")
    .option("--yes", "confirm a Rekor v2 submission")
    .option("--key <path>", "signing key")
    .option("--force", "replace an existing manifest (only if it was never shown to anyone)")
    .option("--tsa-trust <file>", "extra timestamp-authority anchors (repeatable)", collect)
    .option("--json", "machine-readable output")
    .option("--out <file>", "with --dry-run: write the full listing and would-be manifest ids to <file>")
    .action(function (this: Command) {
      return run((ctx) => freezeCommand(ctx, this.opts()))();
    });

  program
    .command("sample")
    .description("fetch and BLS-verify seed round R, compute the draws, write audit/<window>/draws.json")
    .option("--through <n>", "issue draws 1..n (default: the zero-failure stopping point)", (v) => Number(v))
    .option("--beacon-file <path>", "use a recorded quicknet beacon (still BLS-verified) instead of fetching")
    .action(function (this: Command) {
      return run((ctx) => sampleCommand(ctx, this.opts()))();
    });

  program
    .command("record <draw> <verdict>")
    .description("append a pass/fail verdict for a draw to the ledger (git-file: commit it afterwards)")
    .option("--reviewer <id>", "who reviewed")
    .option("--note <text>", "one-line justification")
    .option("--force", "append even if the change already has a verdict (shows as a relabel)")
    .action(function (this: Command, draw: string, verdict: string) {
      return run((ctx) => recordCommand(ctx, draw, verdict, this.opts()))();
    });

  program
    .command("status")
    .description("longest fully labelled prefix, LLR vs target, and CERTIFIED / n more needed / ESCALATE")
    .option("--json", "machine-readable output")
    .option("--offline", "do not call the provider (for 'N so far' while the window is open)")
    .action(function (this: Command) {
      return run((ctx) => statusCommand(ctx, this.opts()))();
    });

  program
    .command("verify")
    .description("third-party check of the seven audit properties")
    .option("--offline", "skip the population rebuild and any network fetch")
    .option("--log-key <pem>", "trusted transparency-log public key")
    .option("--tsa-trust <file>", "timestamp-authority anchors you trust beyond the shipped bundle (repeatable)", collect)
    .option("--beacon-file <path>", "recorded quicknet beacon for round R")
    .option("--json", "machine-readable output")
    .action(function (this: Command) {
      return run((ctx) => verifyCommand(ctx, this.opts()))();
    });

  program
    .command("simulate")
    .description("run the scoring code against an oracle population")
    .requiredOption("--population <N>", "population size")
    .requiredOption("--defects <K>", "defective changes in the population")
    .option("--runs <n>", "simulated audits", "20000")
    .option("--seed <n>", "PRNG seed", "1")
    .option("--p0 <x>", "tolerance", "0.1")
    .option("--p1 <x>", "planning alternative (default p0/5)")
    .option("--alpha <x>", "risk limit", "0.05")
    .option("--cap <n>", "draw cap (default 4x zero-failure stop)")
    .option("--json", "machine-readable output")
    .action(function (this: Command) {
      return run((ctx) => simulateCommand(ctx, this.opts()))();
    });

  return program;
}

function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const program = buildProgram(
    (g) =>
      nodeContext({
        cwd: g.dir ? resolve(g.dir) : process.cwd(),
        ...(g.config ? { configPath: resolve(g.config) } : {}),
        ...(g.fromFile ? { fromFile: resolve(g.fromFile) } : {}),
      }),
    (c) => (process.exitCode = c),
  );
  await program.parseAsync(process.argv);
}
