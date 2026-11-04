#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { checkpointCommand } from "./commands/checkpoint.js";
import { AuditError } from "./api/errors.js";
import { nodeContext, type CommandContext } from "./commands/context.js";
import { drawContextCommand } from "./commands/draw-context.js";
import { freezeCommand } from "./commands/freeze.js";
import { initCommand } from "./commands/init.js";
import { pluginAddCommand, pluginApproveCommand, pluginCheckCommand, pluginLockCommand } from "./commands/plugin.js";
import { closeAllPluginHosts } from "./plugins/host.js";
import { recordCommand } from "./commands/record.js";
import { registerCommand } from "./commands/register.js";
import { sampleCommand } from "./commands/sample.js";
import { simulateCommand } from "./commands/simulate.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";
import { PR_RLA_VERSION } from "./version.js";

export function buildProgram(makeCtx: (g: { dir?: string; config?: string; fromFile?: string; plugins?: string; acceptLockGrants?: boolean }) => CommandContext, setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name("pr-rla")
    .description("Risk-limiting audits for code changes that landed with no recorded human review")
    .version(PR_RLA_VERSION)
    .option("-C, --dir <path>", "audit repo directory (holds .pr-rla.yml)")
    .option("-c, --config <path>", "config file (default <dir>/.pr-rla.yml)")
    .option("--from-file <changes.json>", "use the json-file provider with this export instead of the configured provider")
    .option("--plugins <builtin-only>", "builtin-only: refuse every external provider and ledger (as PR_RLA_PLUGINS=builtin-only does)")
    .option("--accept-lock-grants", "take the credential grants and trust in this repo's pr-rla.lock.json and .pr-rla.yml without your approval, for this run only: only for a repo you control (as PR_RLA_ACCEPT_LOCK_GRANTS=1 does)")
    .showHelpAfterError();

  const collect = (v: string, prev: string[] = []) => [...prev, v];
  /** Runs a command; with `json` (its --json), an error prints as `{ "error": { code, message, host?, next? } }` on stdout (contracts.md §7). */
  const run = (fn: (ctx: CommandContext) => Promise<number>, json = false) => async () => {
    const g = program.opts<{ dir?: string; config?: string; fromFile?: string; plugins?: string; acceptLockGrants?: boolean }>();
    const ctx = makeCtx(g);
    if (g.plugins !== undefined) ctx.plugins = g.plugins;
    if (g.acceptLockGrants) ctx.acceptLockGrants = true;
    try {
      setExit(await fn(ctx));
    } catch (e) {
      // Broker and API errors name the host and the next step (NFR17).
      const { code, host, next } = e as { code?: unknown; host?: unknown; next?: unknown };
      if (json) ctx.out(JSON.stringify({ error: { code: typeof code === "string" ? code : "FAILED", message: (e as Error).message, ...(typeof host === "string" ? { host } : {}), ...(typeof next === "string" && next ? { next } : {}) } }, null, 2));
      else {
        ctx.err(`pr-rla: ${(e as Error).message}`);
        if (typeof next === "string" && next) ctx.err(`  next: ${next}`);
      }
      setExit(e instanceof AuditError ? e.exitCode : 1);
    } finally {
      closeAllPluginHosts();
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
    .option("--estimate", "predict the requests and wall time of a pooled freeze from the first page of each repo; implies --dry-run")
    .option("--resume <runId>", "continue a pooled freeze that stopped (exit 4); refused if its inputs differ")
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
      return run((ctx) => freezeCommand(ctx, this.opts()), !!this.opts().json)();
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
    .command("draw-context <draw>")
    .description("what a reviewer reads for an issued draw: its diff (generated files dropped), description, CI results, protocol checklist and verdict state")
    .option("--max-patch-bytes <n>", "bytes of patches to show in all (default 204800, at most 1048576)")
    .option("--json", "machine-readable output")
    .action(function (this: Command, draw: string) {
      return run((ctx) => drawContextCommand(ctx, draw, this.opts()), !!this.opts().json)();
    });

  program
    .command("record <draw> <verdict>")
    .description("append a pass/fail verdict for a draw to the ledger (git-file: commit it afterwards)")
    .option("--reviewer <id>", "who reviewed")
    .option("--note <text>", "one-line justification")
    .option("--force", "append even if the change already has a verdict (shows as a relabel)")
    .option("--sign <key>", "sign this verdict with your registered SSH key (ssh-keygen -Y sign; a security key asks for a touch)")
    .action(function (this: Command, draw: string, verdict: string) {
      return run((ctx) => recordCommand(ctx, draw, verdict, this.opts()))();
    });

  program
    .command("status")
    .description("longest fully labelled prefix, LLR vs target, and CERTIFIED / n more needed / ESCALATE")
    .option("--json", "machine-readable output")
    .option("--offline", "do not call the provider (for 'N so far' while the window is open)")
    .option("--checkpoint", "also append a ledger checkpoint (as \"pr-rla checkpoint\" does; plain status never writes)")
    .action(function (this: Command) {
      return run((ctx) => statusCommand(ctx, this.opts()), !!this.opts().json)();
    });

  program
    .command("checkpoint")
    .description("hash the ledger's verdict-event history, time-stamp it, and append it to audit/<window>/ledger-checkpoints.jsonl")
    .option("--push", "commit the checkpoint and push it (fetch, rebase, push; at most 3 attempts; never forced)")
    .option("--remote <name>", "with --push: the remote, when the branch has no upstream")
    .option("--branch <name>", "with --push: the remote branch, when the branch has no upstream")
    .option("--tsa-trust <file>", "extra timestamp-authority anchors (repeatable)", collect)
    .action(function (this: Command) {
      return run((ctx) => checkpointCommand(ctx, this.opts()))();
    });

  program
    .command("verify")
    .description("third-party check of the seven audit properties")
    .option("--offline", "skip the population rebuild and any network fetch")
    .option("--log-key <pem>", "a transparency-log public key you trust (PEM file); without it only Sigstore's pinned log keys are trusted")
    .option("--tsa-trust <file>", "timestamp-authority anchors you trust beyond the shipped bundle (repeatable)", collect)
    .option("--beacon-file <path>", "recorded quicknet beacon for round R")
    .option("--json", "machine-readable output")
    .addHelpText("after", "\nExit codes: 0 VERIFIED · 1 FAILED (a check failed) · 6 INCOMPLETE (nothing failed, but part of the population could not be rebuilt, or its completeness could not be established; --json has the verdict)")
    .action(function (this: Command) {
      return run((ctx) => verifyCommand(ctx, this.opts()), !!this.opts().json)();
    });

  const plugin = program.command("plugin").description("lock, re-lock and check external providers and ledgers (pr-rla.lock.json)");
  plugin
    .command("add <use>")
    .description("review an external plugin named in .pr-rla.yml and add it to pr-rla.lock.json (the only way in)")
    .option("--trust <isolated|full>", "isolated (default): out of process with placeholder credentials; full: in process with your environment", "isolated")
    .option("--yes", "trust what is printed without asking")
    .action(function (this: Command, use: string) {
      return run((ctx) => pluginAddCommand(ctx, use, this.opts()))();
    });
  plugin
    .command("lock <use>")
    .description("re-hash an added plugin after you reviewed a change, and update its lock entry")
    .option("--trust <isolated|full>", "change its trust")
    .option("--yes", "trust what is printed without asking")
    .action(function (this: Command, use: string) {
      return run((ctx) => pluginLockCommand(ctx, use, this.opts()))();
    });
  plugin
    .command("approve [use]")
    .description("approve, on this machine, what a plugin someone else locked may send (its credentials and their origins) and its trust; or, with --env and --origin, a credential for built-in providers and ledgers")
    .option("--env <name>", "with --origin: the environment variable built-ins may send")
    .option("--origin <url>", "with --env: the https origin they may send it to, e.g. https://ghe.example.com")
    .option("--yes", "approve what is printed without asking")
    .action(function (this: Command, use: string | undefined) {
      return run((ctx) => pluginApproveCommand(ctx, use, this.opts()))();
    });
  plugin
    .command("check <use>")
    .description("lock status, npm signatures, hosts and credentials, and the conformance kit through the plugin host (correctness, not safety)")
    .option("--fixture <file>", "a recorded fixture to run the kit on (repeatable)", collect)
    .option("--offline", "skip npm audit signatures (it asks the npm registry)")
    .option("--kind <provider|ledger>", "for a plugin not named in .pr-rla.yml", "provider")
    .action(function (this: Command, use: string) {
      return run((ctx) => pluginCheckCommand(ctx, use, this.opts()))();
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
      return run((ctx) => simulateCommand(ctx, this.opts()), !!this.opts().json)();
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
