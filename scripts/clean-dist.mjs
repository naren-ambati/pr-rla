// Empties dist/ before a build (`npm run build`, and so `prepack`). tsc never deletes the output of a
// source that was deleted or moved, so without this a stale dist/ file ships in the npm tarball: the
// wave-2 integration found dist/commands/freeze-pool.* in one, compiled from a file U5 had removed.
//
// Usage: node scripts/clean-dist.mjs   (from the package root: removes ./dist and nothing else)
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
if (!existsSync(join(root, "package.json"))) throw new Error(`clean-dist: ${root} is not a package root (no package.json)`);
const dist = join(root, "dist");
if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) throw new Error(`clean-dist: ${dist} is a symbolic link; not removing what it points to`);
rmSync(dist, { recursive: true, force: true });
