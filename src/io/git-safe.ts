import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitExecutable } from "./executables.js";

/**
 * The one way pr-rla's read paths run git (U9, after review; shared with U5's equivalent guard).
 * A verifier's git must show what the objects say, write nothing and reach no network:
 *
 * - every inherited `GIT_*` variable is dropped (GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_GRAFT_FILE,
 *   GIT_CONFIG_PARAMETERS, … cannot steer it);
 * - `GIT_NO_LAZY_FETCH=1`: a partial clone's missing object stays missing, never fetched with the
 *   user's credentials outside the broker;
 * - `GIT_OPTIONAL_LOCKS=0`, `-c gc.auto=0`, `-c maintenance.auto=false`: no index refresh, no
 *   automatic gc or maintenance writes under .git;
 * - `GIT_CEILING_DIRECTORIES` at the audit root: git looks for a repository from its cwd up to the
 *   root and never above it (git stops before climbing *into* a ceiling, so the ceiling is the root's parent);
 * - `--no-replace-objects`, `-c core.commitGraph=false`, `-c core.fsmonitor=false`: no replace refs,
 *   no commit-graph parents, no fsmonitor hook;
 * - `--no-textconv` for the commands that would apply a textconv driver (diff, log, show, blame, grep);
 * - git itself by absolute path from PATH (src/io/executables.ts, P4), never looked up through the
 *   audit repository it runs in.
 */

const GLOBAL_ARGS = ["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
const TEXTCONV_COMMANDS = new Set(["diff", "log", "show", "blame", "grep", "whatchanged"]);

export interface GitSafeOptions {
  /** The directory git runs in. */
  cwd: string;
  /** The audit root: git searches for a repository up to it and never above (GIT_CEILING_DIRECTORIES). Default: cwd. */
  root?: string;
  input?: string;
}

/** The environment git runs in: the caller's without any GIT_* variable, plus the guards above. */
export function gitSafeEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.toUpperCase().startsWith("GIT_")) out[k] = v;
  out.GIT_NO_LAZY_FETCH = "1";
  out.GIT_OPTIONAL_LOCKS = "0";
  out.GIT_CEILING_DIRECTORIES = dirname(resolve(root));
  return out;
}

/** The argument list git gets: the global guards, the subcommand, and --no-textconv where it applies. */
export function gitSafeArgs(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  return [...GLOBAL_ARGS, ...(sub ? [sub] : []), ...(sub && TEXTCONV_COMMANDS.has(sub) ? ["--no-textconv"] : []), ...rest];
}

/** Runs git synchronously under the guards; throws as execFileSync does. */
export function gitSafe(args: readonly string[], o: GitSafeOptions): Buffer {
  return execFileSync(gitExecutable(), gitSafeArgs(args), { cwd: o.cwd, env: gitSafeEnv(o.root ?? o.cwd), stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, ...(o.input !== undefined ? { input: o.input } : {}) });
}

export const gitSafeText = (args: readonly string[], o: GitSafeOptions): string => gitSafe(args, o).toString("utf8");

/** Spawns git under the guards (for streaming, e.g. `cat-file --batch`). */
export function gitSafeSpawn(args: readonly string[], o: Omit<GitSafeOptions, "input">): ChildProcessWithoutNullStreams {
  return spawn(gitExecutable(), gitSafeArgs(args), { cwd: o.cwd, env: gitSafeEnv(o.root ?? o.cwd), stdio: ["pipe", "pipe", "pipe"] });
}

/** The command a verifier runs instead of verifying a cut or partial history. */
export const FULL_CLONE = "verify in a full clone: run `git fetch --unshallow` here, or `git clone` without `--depth` or `--filter`";

/**
 * Why this repository's history cannot be read in full without reaching a network, or null: a
 * shallow clone (git says so, or a `shallow` file exists), a grafts file, or a partial clone
 * (`extensions.partialClone`, a promisor remote, or promisor packs), whose missing objects git
 * would otherwise fetch from its remote.
 */
export function historyRefusal(top: string): string | null {
  const o = { cwd: top, root: top };
  const common = resolve(top, gitSafeText(["rev-parse", "--git-common-dir"], o).trim());
  const shallowFile = join(common, "shallow");
  const grafts = join(common, "info", "grafts");
  let shallow = false;
  try {
    shallow = gitSafeText(["rev-parse", "--is-shallow-repository"], o).trim() === "true";
  } catch {
    shallow = false;
  }
  if (shallow || existsSync(shallowFile))
    return `the repository is a shallow clone (${shallowFile}${existsSync(shallowFile) ? "" : " per git"}): its history is cut, so a verdict removed or rewritten before the cut could not be seen; ${FULL_CLONE}`;
  if (existsSync(grafts)) return `the repository has a grafts file (${grafts}), which makes git present other commit parents than the objects hold; remove it, or ${FULL_CLONE}`;
  const config = (key: string): string[] => {
    try {
      return gitSafeText(["config", "--get-regexp", key], o).split("\n").filter(Boolean);
    } catch {
      return []; // exit 1: not set
    }
  };
  const promisor = [...config("^extensions\\.partialclone$"), ...config("^remote\\..*\\.promisor$").filter((l) => /\s(?:true|yes|on|1)$/i.test(l))];
  const packDir = join(common, "objects", "pack");
  const promisorPacks = existsSync(packDir) ? readdirSync(packDir).filter((f) => f.endsWith(".promisor")) : [];
  if (promisor.length || promisorPacks.length)
    return `the repository is a partial clone (${[...promisor, ...promisorPacks.map((p) => join(packDir, p))].join("; ")}): objects it lacks would be fetched from its remote, so its history cannot be read here as it is; ${FULL_CLONE}`;
  return null;
}
