import { probeRepo } from "./failures.js";
import { foreign, ident, said, type Line } from "./said.js";
import type { ManifestRepo, RegisteredRepo } from "./records.js";
import type { RepoRef, ScmProvider } from "../sdk/provider.js";

/**
 * Check 2's online part for a rule pool (P5, "draws that cannot be steered"): the manifest names each repository as the
 * registration names it (by repo id), or as the SCM names it now. A rule pool's draw keys are repo ids (src/core/
 * draw-key.ts), so no name moves a draw; but the names are what a reader of the manifest, the draws and the ledger sees,
 * and a name the auditee picked FAILs. One more name is accepted, and noted: a former name that the SCM still resolves to
 * the same repository (GitHub redirects a renamed repository's old path), so an honest audit whose repository was renamed
 * between registration and freeze, and again after, still verifies. Another spelling of a name it has (case included) is
 * not a former name. Pure apart from the provider's `describeRepo` (only for a repo the manifest does not name as
 * registered or as listed now).
 */
export async function ruleRepoNameFindings(provider: Pick<ScmProvider, "name" | "describeRepo">, a: { registered: readonly RegisteredRepo[]; repos: readonly ManifestRepo[]; owner: readonly RepoRef[] | null }): Promise<{ fails: Line[]; incompletes: Line[]; notes: Line[] }> {
  // Names and ids are the manifest's, the registration's and the SCM's: pieces of a line (src/core/said.ts, S1).
  const fails: Line[] = [];
  const incompletes: Line[] = [];
  const notes: Line[] = [];
  const nm = (x: string) => said`"${ident("a repository path the manifest, the registration or the SCM gives", x)}"`;
  const path = (x: string) => ident("a repository path", x);
  const rid = (x: string) => ident("a repo id the manifest gives", x);
  const lower = (s: string) => s.toLowerCase();
  for (const m of a.repos) {
    if (!m.repoId) continue; // check 2's offline part FAILs a rule repo without an id
    const reg = a.registered.find((r) => r.repoId === m.repoId) ?? null;
    if (reg && reg.repo === m.repo) continue;
    let now = a.owner?.find((r) => r.id === m.repoId)?.repo ?? null;
    if (now === null) {
      const p = await probeRepo(provider, { repo: m.repo, id: m.repoId });
      if (p.kind === "exists" && p.ref.id === m.repoId) now = p.ref.repo;
      else {
        // Gone, unreadable or unsupported: check 5 reports the repository itself; its name cannot be checked.
        incompletes.push(said`repo id ${rid(m.repoId)} is named ${nm(m.repo)} in the manifest, ${reg ? said`${nm(reg.repo)} in the registration` : "and was not registered"}, and its name on ${provider.name} now cannot be read (${p.kind === "exists" ? said`the probe found repo id ${rid(p.ref.id)}` : p.kind === "unsupported" ? "the provider has no describeRepo" : p.detail}): whether the manifest names it as the SCM does is not established`);
        continue;
      }
    }
    if (now === m.repo) continue;
    const anotherSpelling = lower(m.repo) === lower(now) || (reg !== null && lower(m.repo) === lower(reg.repo));
    if (!anotherSpelling) {
      const p = await probeRepo(provider, { repo: m.repo });
      if (p.kind === "exists" && p.ref.id === m.repoId) {
        notes.push(said`${path(m.repo)} (repo id ${rid(m.repoId)}) is a former name: ${provider.name} resolves it to the same repository, named ${path(now)} now${reg ? said` (registered as ${path(reg.repo)})` : ""}`);
        continue;
      }
      if (p.kind === "transient") {
        incompletes.push(said`whether ${nm(m.repo)} is a former name of repo id ${rid(m.repoId)} (named ${path(now)} now) could not be read: ${p.detail}; run verify again`);
        continue;
      }
    }
    fails.push(said`manifest names repo id ${rid(m.repoId)} ${nm(m.repo)}, which is neither its registered name${reg ? said` ${nm(reg.repo)}` : " (it was not registered)"} nor its name on ${provider.name} now ${nm(now)}${anotherSpelling ? " but another spelling of one" : ", nor a former name the SCM resolves to it"}: a manifest names its repositories as the registration or the SCM does, never another way`);
  }
  return { fails, incompletes, notes };
}
