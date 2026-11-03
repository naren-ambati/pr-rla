import { assertChangeRecord, type AuditWindow, type ChangeRecord, type ListChangesResult, type ScmProvider } from "../sdk/provider.js";
import { sortChanges, type ManifestEntry } from "./records.js";
import { applySelector, reviewsAsOf, type SelectionResult, type Selector } from "./selector.js";
import { inWindow } from "./window.js";

/** Added to every manifest whose selector includes direct pushes, whatever the provider says. */
export const DIRECT_PUSH_LIMITATION =
  "direct_push: `author` is the commit author, which is not necessarily who pushed it (commit author != pusher); mergedBy is null because SCM commit APIs do not expose the pusher.";

export interface Population {
  /** Provider limitations plus core ones, de-duplicated. */
  limitations: string[];
  listed: ListChangesResult;
  selection: SelectionResult;
  /** Sorted by id; reviews trimmed to the cutoff. */
  entries: ManifestEntry[];
  byKind: Record<ChangeRecord["kind"], number>;
}

/**
 * Asks the provider for everything that landed in the window, checks the
 * provider contract (well-formed records, unique ids, no SHA claimed twice,
 * all inside the window), then applies the selector as of `cutoffIso`.
 * Depends only on the ScmProvider interface.
 */
export async function buildPopulation(provider: ScmProvider, args: { repo: string; window: AuditWindow; selector: Selector; cutoffIso: string; signal?: AbortSignal }): Promise<Population> {
  const req = { repo: args.repo, window: { opensAt: args.window.opensAt, closesAt: args.window.closesAt }, kinds: args.selector.kinds, ...(args.signal ? { signal: args.signal } : {}) };
  const listed = await provider.listChanges(req);
  const ids = new Set<string>();
  const shas = new Map<string, string>();
  for (const c of listed.changes) {
    assertChangeRecord(c, `provider ${provider.name}`);
    if (ids.has(c.id)) throw new Error(`provider ${provider.name} returned ${c.id} twice`);
    ids.add(c.id);
    const other = shas.get(c.mergeSha);
    if (other) throw new Error(`provider ${provider.name} counted commit ${c.mergeSha} twice (${other} and ${c.id})`);
    shas.set(c.mergeSha, c.id);
    if (!inWindow(c.mergedAt, args.window)) throw new Error(`provider ${provider.name} returned ${c.id} landed ${c.mergedAt}, outside the window`);
    if (!args.selector.kinds.includes(c.kind)) throw new Error(`provider ${provider.name} returned ${c.id} of kind ${c.kind}, which was not requested`);
    if (c.repo !== args.repo) throw new Error(`provider ${provider.name} returned ${c.id} from repo ${c.repo}, not ${args.repo}`);
  }
  const selection = applySelector(listed.changes, args.selector, args.cutoffIso);
  const entries = sortChanges(selection.selected.map((c) => ({ ...c, reviews: reviewsAsOf(c, args.cutoffIso) })));
  const byKind = { pull_request: 0, direct_push: 0 };
  for (const c of listed.changes) byKind[c.kind]++;
  const limitations = [...new Set([...listed.limitations, ...(args.selector.kinds.includes("direct_push") ? [DIRECT_PUSH_LIMITATION] : [])])];
  return { limitations, listed, selection, entries, byKind };
}
