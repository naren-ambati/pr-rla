import { probeRepo } from "./failures.js";
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
export async function ruleRepoNameFindings(provider: Pick<ScmProvider, "name" | "describeRepo">, a: { registered: readonly RegisteredRepo[]; repos: readonly ManifestRepo[]; owner: readonly RepoRef[] | null }): Promise<{ fails: string[]; incompletes: string[]; notes: string[] }> {
  const fails: string[] = [];
  const incompletes: string[] = [];
  const notes: string[] = [];
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
        incompletes.push(`repo id ${m.repoId} is named ${JSON.stringify(m.repo)} in the manifest, ${reg ? `${JSON.stringify(reg.repo)} in the registration` : "and was not registered"}, and its name on ${provider.name} now cannot be read (${p.kind === "exists" ? `the probe found repo id ${p.ref.id}` : p.kind === "unsupported" ? "the provider has no describeRepo" : p.detail}): whether the manifest names it as the SCM does is not established`);
        continue;
      }
    }
    if (now === m.repo) continue;
    const anotherSpelling = lower(m.repo) === lower(now) || (reg !== null && lower(m.repo) === lower(reg.repo));
    if (!anotherSpelling) {
      const p = await probeRepo(provider, { repo: m.repo });
      if (p.kind === "exists" && p.ref.id === m.repoId) {
        notes.push(`${m.repo} (repo id ${m.repoId}) is a former name: ${provider.name} resolves it to the same repository, named ${now} now${reg ? ` (registered as ${reg.repo})` : ""}`);
        continue;
      }
      if (p.kind === "transient") {
        incompletes.push(`whether ${JSON.stringify(m.repo)} is a former name of repo id ${m.repoId} (named ${now} now) could not be read: ${p.detail}; run verify again`);
        continue;
      }
    }
    fails.push(`manifest names repo id ${m.repoId} ${JSON.stringify(m.repo)}, which is neither its registered name${reg ? ` ${JSON.stringify(reg.repo)}` : " (it was not registered)"} nor its name on ${provider.name} now ${JSON.stringify(now)}${anotherSpelling ? " but another spelling of one" : ", nor a former name the SCM resolves to it"}: a manifest names its repositories as the registration or the SCM does, never another way`);
  }
  return { fails, incompletes, notes };
}
