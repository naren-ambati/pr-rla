/**
 * `ChangeRecord.landedVia` for the built-in providers (U3, FR7.6): which direct pushes arrived on the
 * default branch through the non-first parent of a merge commit that was itself pushed (a release
 * branch merged by a push, for example), as opposed to being pushed to the default branch directly.
 *
 * Pure, over the history the provider already walked: `parents` maps every fetched commit to its
 * parents (first parent first); commits outside the fetched set end a path.
 *
 * For each direct push M with two or more parents, the commits M brought in are those reachable from
 * its non-first parents and not from its first parent. A direct push brought in by several such merges
 * (one merged into another) is attributed to the outermost: the one no other of them brought in.
 *
 * Limitation, stated in every built-in's limitations: without push history a merge's parents cannot be
 * told apart, so for a `git pull` merge pushed to the default branch ("foxtrot", first parent = local
 * work) the mainline commits behind its second parent are reported as arriving through it.
 */
export function landedViaMerges(parents: ReadonlyMap<string, readonly string[]>, directPushes: Iterable<string>): Map<string, string> {
  const pushes = new Set(directPushes);
  const reach = (from: readonly string[], stop?: ReadonlySet<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...from];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha) || stop?.has(sha) || !parents.has(sha)) continue;
      seen.add(sha);
      stack.push(...parents.get(sha)!);
    }
    return seen;
  };
  const brought = new Map<string, Set<string>>();
  for (const m of [...pushes].sort()) {
    const ps = parents.get(m);
    if (!ps || ps.length < 2) continue;
    brought.set(m, reach(ps.slice(1), reach(ps.slice(0, 1))));
  }
  const out = new Map<string, string>();
  for (const sha of pushes) {
    const via = [...brought].filter(([m, set]) => m !== sha && set.has(sha)).map(([m]) => m);
    if (via.length === 0) continue;
    const outer = via.filter((m) => !via.some((o) => o !== m && brought.get(o)!.has(m)));
    out.set(sha, (outer.length ? outer : via).sort()[0]!);
  }
  return out;
}

/** The limitation each built-in that reports landedVia lists. */
export const LANDED_VIA_LIMITATION =
  "direct_push: landedVia names the pushed merge commit whose non-first parent brought a direct push in (e.g. a release branch merged by a push); without push history the parents of a `git pull` merge pushed to the default branch cannot be told apart, so the mainline commits behind its second parent are reported the same way.";
