// Empties dist/ before a build (`npm run build`, and so `prepack`). tsc never deletes the output of a
// source that was deleted or moved, so without this a stale dist/ file would ship in the npm tarball
// (pr-rla's own tarball carried one: dist/commands/freeze-pool.*, at the wave-2 integration).
//
// Usage: node scripts/clean-dist.mjs   (from this package's root: removes ./dist and nothing else)
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
if (!existsSync(join(root, "package.json"))) throw new Error(`clean-dist: ${root} is not a package root (no package.json)`);
const dist = join(root, "dist");
if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) throw new Error(`clean-dist: ${dist} is a symbolic link; not removing what it points to`);
rmSync(dist, { recursive: true, force: true });
