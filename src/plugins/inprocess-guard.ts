/**
 * What a `trust: full` plugin may import in this process (the plugin and broker fix round, finding
 * 14 and its review). An approval pins the files the plugin's tree hash covers: its own and its
 * declared dependencies'. Node would also resolve an import the plugin never declared, from any
 * enclosing `node_modules` (a single-file plugin's `import "yaml"`, say), and that code could change
 * after the approval without a hashed file changing. A resolve hook refuses, for any module inside a
 * guarded plugin's tree, a target outside the tree, its dependencies and the running pr-rla.
 * `node:` built-ins are allowed. What the plugin reads and runs itself (`readFileSync` and `eval`, a
 * worker, a forked process, `createRequire` from another path) is not covered: the reviewer sees that
 * in the hashed code.
 *
 * This module has no runtime import from pr-rla (only `node:` modules), so a test can load it
 * type-stripped in a plain Node process, where module resolution is Node's own.
 */
import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Guard {
  use: string;
  /** The hashed trees: the plugin's root (or the file itself) and each dependency's. Modules inside them are guarded. */
  trees: string[];
  /** Other paths those modules may resolve to, whole (the running pr-rla's own code). */
  extra: string[];
}

type ResolveHook = (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: unknown) => { url: string }) => { url: string };

const guards: Guard[] = [];
let registered = false;

const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (r.split(/[\\/]/)[0] !== ".." && !isAbsolute(r));
};
/** Inside a hashed tree: not in its top-level node_modules or .git, which the tree hash skips (src/plugins/lock.ts). */
const inTree = (child: string, tree: string) => {
  if (!inside(child, tree)) return false;
  const first = relative(tree, child).split(/[\\/]/)[0];
  return first !== "node_modules" && first !== ".git";
};
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** A refusal in PluginError's shape (code, next, exit code 1), without importing it. */
function refusal(use: string, specifier: string, target: string): Error {
  return Object.assign(new Error(`plugin ${use} imports ${JSON.stringify(specifier)}, which resolves to ${target}, outside the files its tree hash covers (its own and its declared dependencies', never their node_modules, and the running pr-rla's own code); refused, so nothing unhashed runs in this process`), {
    name: "PluginError",
    code: "TREE_ESCAPE",
    exitCode: 1,
    next: "declare the package in the plugin's package.json dependencies and lock it again (pr-rla plugin lock <use>), or run the plugin isolated",
  });
}

/**
 * Guards the in-process imports of one `trust: full` plugin: modules in its hashed `trees` may resolve
 * only to `node:` built-ins, to files in those trees (never their unhashed top-level node_modules or
 * .git) and to paths under `extra`. Call it before importing the plugin. The hook is registered once
 * per process (module.registerHooks, Node 22.15 or later) and serves every guard. It runs on this
 * thread only: a worker the plugin starts, a process it forks, and `createRequire` from a path
 * outside its trees are outside it, as is anything the plugin reads and runs itself.
 */
export function guardInProcessImports(use: string, trees: readonly string[], extra: readonly string[]): void {
  const g: Guard = { use, trees: trees.map(real), extra: extra.map(real) };
  // A plugin loaded again (re-locked in a long-lived process) replaces its guard rather than stacking under the old one.
  const i = guards.findIndex((x) => x.trees[0] === g.trees[0]);
  if (i >= 0) guards.splice(i, 1);
  guards.unshift(g);
  if (registered) return;
  const registerHooks = (nodeModule as { registerHooks?: (hooks: { resolve: ResolveHook }) => unknown }).registerHooks;
  if (typeof registerHooks !== "function") throw Object.assign(new Error(`a trust: full plugin needs Node 22.15 or later (module.registerHooks); this is ${process.version}`), { name: "PluginError", code: "PLUGIN_HOST_FAILED", exitCode: 1 });
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
      const g = parent ? guards.find((x) => x.trees.some((t) => inTree(parent, t))) : undefined;
      if (!g || resolved.url.startsWith("node:")) return resolved;
      if (!resolved.url.startsWith("file:")) throw refusal(g.use, specifier, resolved.url);
      const target = real(fileURLToPath(resolved.url));
      if (!g.trees.some((t) => inTree(target, t)) && !g.extra.some((e) => inside(target, e))) throw refusal(g.use, specifier, target);
      return resolved;
    },
  });
  registered = true;
}
