import { isManifestV2, isRegistrationV2, manifestRepos, registrationRepoSet, type AnyManifest, type AnyRegistration, type ManifestEntry, type ManifestRepo, type RepoSet, type SignedRecord } from "./records.js";
import { isChangeId } from "../sdk/provider.js";
import { foreign, ident, joinLines, said, type Line } from "./said.js";
import { splitScheme } from "./repo-set.js";

/**
 * The canonical order of a population (contracts.md §5, "Draws"; P5, "draws that cannot be steered"). Draw `i` is the
 * change at index `index_i` of the population sorted by its **draw key**, never by a spelling the auditee picks:
 *
 *     key = scheme ":" R " " L
 *     R   = "id:" repoId     a rule pool: the SCM's stable id of the change's repository (registered, or listed at freeze)
 *         | path             a repo or a list: the path exactly as the signed registration names it
 *     " "                    one space (U+0020), below every character R may hold, so a repository's changes are adjacent
 *     L   = "#" n            a pull request: its number, decimal, no leading zero
 *         | "@" sha          a direct push: its commit, 40 to 64 lowercase hex characters
 *
 * `scheme` and `L` are the change id's own (the part before the first ":" and the `#n` or `@sha` after the repo); the
 * id's repo part must be byte-equal to the change's `repo`, which must be byte-equal to a manifest repo's `repo`. R holds
 * no whitespace or control character. Keys are compared by UTF-16 code units (JavaScript's `<`), as change ids are. A
 * single repo's order is its change-id order, so its draws are unchanged; a list is ordered by registered path, and
 * check 2 FAILs a manifest that spells a repo another way; for a rule pool, renaming or respelling a repository between
 * freezes moves nothing. Schema v1 audits keep the change-id order they were drawn with (and verify INCOMPLETE: their
 * draws are bound to the manifest).
 */

const LOCAL = /^(?:#[1-9][0-9]*|@[0-9a-f]{40,64})$/;
/** A repo id usable in a key: no whitespace, control character, `#`, `@` or `/`. */
const REPO_ID = /^[^\s\p{Cc}#@/]+$/u;
/** A registered path usable in a key: no whitespace or control character (REPO_PATH already refuses whitespace). */
const PATH_OK = /^[^\s\p{Cc}]+$/u;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A change id split as `<scheme>:<repo><local>` against the change's own `repo`, or null when it does not read so. */
export function splitChangeId(id: string, repo: string): { scheme: string; local: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const scheme = id.slice(0, i);
  const rest = id.slice(i + 1);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scheme) || !rest.startsWith(repo)) return null;
  const local = rest.slice(repo.length);
  return LOCAL.test(local) ? { scheme, local } : null;
}

export interface CanonicalOrder {
  /** The changes in canonical order (empty when `problems` is not). */
  order: ManifestEntry[];
  /** The draw key of each change of `order`, in the same order. */
  keys: string[];
  /** Why no canonical order exists (check 2 and check 6 FAIL them; sample and freeze refuse). */
  problems: Line[];
  /** `registered`: the draw key above (schema v2). `id`: the change id (schema v1, as v1 audits were drawn). */
  basis: "registered" | "id";
}

/**
 * The draw keys of a population under a registered repo set (see the module comment). `repos` are the manifest's
 * repos (a rule pool's carry their ids). Pure; no I/O.
 */
export function canonicalOrder(set: RepoSet, repos: readonly Pick<ManifestRepo, "repo" | "repoId">[], changes: readonly ManifestEntry[]): CanonicalOrder {
  // The names and ids are the manifest's and the registration's (the auditee's files): pieces of a line (src/core/said.ts, S1).
  const problems: Line[] = [];
  const nm = (x: string) => said`"${ident("a repository path the manifest or the registration gives", x)}"`;
  const key = (x: string) => (isChangeId(x) ? x : foreign("a change id or draw key the manifest gives", x));
  const eg = (xs: readonly (string | ReturnType<typeof foreign> | Line)[]) => said`(e.g. ${joinLines(xs.slice(0, 3), ", ")})`;
  // R for each manifest repo, by its exact name.
  const repoKey = new Map<string, string>();
  if (set.kind === "repo") {
    const want = splitScheme(set.repo).path;
    if (!PATH_OK.test(want)) problems.push(said`the registered repo ${nm(want)} holds whitespace or a control character, so it cannot be a draw key`);
    for (const r of repos) if (r.repo === want) repoKey.set(r.repo, want);
    const other = repos.filter((r) => r.repo !== want).map((r) => r.repo);
    if (other.length) problems.push(said`manifest names repo ${joinLines(other.map(nm), ", ")}, not the registered ${nm(want)} byte for byte: a draw key takes the registered path, never another spelling`);
  } else if (set.kind === "list") {
    const registered = new Set(set.repos.map((e) => splitScheme(e).path));
    const unusable = [...registered].filter((p) => !PATH_OK.test(p));
    if (unusable.length) problems.push(said`the registered list holds ${unusable.length} path(s) with whitespace or a control character ${eg(unusable.map(nm))}, which cannot be draw keys`);
    const other = repos.filter((r) => !registered.has(r.repo)).map((r) => r.repo);
    for (const r of repos) if (registered.has(r.repo)) repoKey.set(r.repo, r.repo);
    if (other.length) problems.push(said`manifest names ${other.length} repo(s) that are not spelled byte for byte as the registered list does ${eg(other.map(nm))}: a draw key takes the registered path, never another spelling`);
  } else {
    const bad = repos.filter((r) => typeof r.repoId !== "string" || !REPO_ID.test(r.repoId)).map((r) => r.repo);
    for (const r of repos) if (typeof r.repoId === "string" && REPO_ID.test(r.repoId)) repoKey.set(r.repo, `id:${r.repoId}`);
    if (bad.length) problems.push(said`manifest gives ${bad.length} repo(s) of the rule pool no usable repo id ${eg(bad.map(nm))}: a rule pool's draw keys are its repositories' stable ids`);
    const ids = repos.map((r) => r.repoId);
    if (new Set(ids).size !== ids.length) problems.push("manifest gives two repos of the rule pool the same repo id");
  }
  const names = new Set(repos.map((r) => r.repo));
  const keyed: { c: ManifestEntry; key: string }[] = [];
  const schemes = new Set<string>();
  const unknownRepo: string[] = [];
  const badId: string[] = [];
  const badKind: string[] = [];
  for (const c of changes) {
    const parts = splitChangeId(c.id, c.repo);
    if (!parts) {
      badId.push(c.id);
      continue;
    }
    schemes.add(parts.scheme);
    if ((c.kind === "pull_request") !== parts.local.startsWith("#")) badKind.push(c.id);
    const r = repoKey.get(c.repo);
    if (r === undefined) {
      // A repo the manifest lists but that has no key was reported above; one it does not list is reported here.
      if (!names.has(c.repo)) unknownRepo.push(c.id);
      continue;
    }
    keyed.push({ c, key: `${parts.scheme}:${r} ${parts.local}` });
  }
  if (badId.length) problems.push(said`manifest has ${badId.length} change(s) whose id is not <scheme>:<repo>#<n> or <scheme>:<repo>@<sha> for the change's own repo, byte for byte ${eg(badId.map(key))}`);
  if (badKind.length) problems.push(said`manifest has ${badKind.length} change(s) whose id does not match its kind ${eg(badKind.map(key))}`);
  if (unknownRepo.length) problems.push(said`manifest has ${unknownRepo.length} change(s) from a repo it does not list, byte for byte ${eg(unknownRepo.map(key))}`);
  if (schemes.size > 1) problems.push(said`manifest changes carry ${schemes.size} id schemes (${joinLines([...schemes].sort().map(key), ", ")}): one provider per audit`);
  keyed.sort((a, b) => cmp(a.key, b.key));
  const dup = keyed.filter((k, i) => i > 0 && keyed[i - 1]!.key === k.key).map((k) => k.key);
  if (dup.length) problems.push(said`manifest has ${dup.length} change(s) with the same draw key as another ${eg(dup.map(key))}`);
  if (problems.length) return { order: [], keys: [], problems, basis: "registered" };
  return { order: keyed.map((k) => k.c), keys: keyed.map((k) => k.key), problems, basis: "registered" };
}

/** The canonical order of an audit's manifest: the draw keys for schema v2, the change ids for schema v1. */
export function drawOrder(reg: SignedRecord<AnyRegistration>, m: AnyManifest): CanonicalOrder {
  if (!isRegistrationV2(reg) || !isManifestV2(m)) {
    const order = [...m.changes].sort((a, b) => cmp(a.id, b.id));
    const ids = order.map((c) => c.id);
    const problems = ids.some((id, i) => i > 0 && ids[i - 1] === id) ? ["manifest lists a change twice"] : [];
    return { order: problems.length ? [] : order, keys: problems.length ? [] : ids, problems, basis: "id" };
  }
  return canonicalOrder(registrationRepoSet(reg), manifestRepos(m), m.changes);
}

/** Whether a manifest stores its changes in canonical order (draws.json's `index` points into `changes`). */
export function storedInCanonicalOrder(o: CanonicalOrder, changes: readonly ManifestEntry[]): boolean {
  return o.problems.length === 0 && o.order.length === changes.length && o.order.every((c, i) => c === changes[i]);
}
