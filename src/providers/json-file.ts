import { readTextConfinedAsync } from "../io/confine.js";
import { isAbsolute, resolve } from "node:path";
import {
  PROVIDER_API_VERSION,
  assertChangeRecord,
  defineProvider,
  normalizeLogin,
  type AccountLookup,
  type ChangeDescription,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type ScmProvider,
} from "../sdk/provider.js";

export interface JsonFileProviderOptions {
  /** Path to the export, relative to the audit repo. */
  path: string;
}

/** File format: either a bare array of ChangeRecords or this envelope. */
export interface ChangesFile {
  schema: "pr-rla/changes/v1";
  repo: string;
  defaultBranch?: string;
  limitations?: string[];
  changes: ChangeRecord[];
  /**
   * Optional (U5): what `describeChange` returns per change id, recorded from the SCM, so a
   * draw context can be built with no network (`pr-rla draw-context`, the MCP `draw_context`).
   */
  descriptions?: Record<string, ChangeDescription>;
}

/** JSON.parse of the export, with an error that never quotes the file. */
function parseExport(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
}

/** Thrown by the json-file provider's describeChange when the export recorded no description for the change (pr-rla's own class: draw-context honours only it). */
export class NoRecordedDescription extends Error {
  readonly code = "NO_DESCRIPTION";
  constructor(file: string, id: string) {
    super(`${file} records no description for ${id}`);
    this.name = "NoRecordedDescription";
  }
}

export const JSON_FILE_LIMITATIONS = [
  "json-file: records were exported by a third party; pr-rla validates their shape but cannot re-check them against the SCM.",
];

/**
 * Reads normalized ChangeRecords exported from any SCM. `verify` rebuilds the
 * population from the same file, so for a tamper-evident audit the export
 * itself must be reproducible from the SCM by the verifier.
 */
export class JsonFileProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "json-file";
  constructor(private readonly file: string) {}

  async load(): Promise<{ repo: string | null; defaultBranch: string; limitations: string[]; changes: ChangeRecord[] }> {
    const raw = parseExport(await readTextConfinedAsync(this.file, "the json-file provider's export"), this.file) as unknown;
    const env: Partial<ChangesFile> = Array.isArray(raw) ? { changes: raw as ChangeRecord[] } : (raw as Partial<ChangesFile>);
    if (!Array.isArray(env.changes)) throw new Error(`${this.file}: expected an array of changes or {"schema":"pr-rla/changes/v1","changes":[...]}`);
    if (env.schema !== undefined && env.schema !== "pr-rla/changes/v1") throw new Error(`${this.file}: unsupported schema ${String(env.schema)}`);
    const seen = new Set<string>();
    env.changes.forEach((c, i) => {
      assertChangeRecord(c, `${this.file} changes[${i}]`);
      if (seen.has(c.id)) throw new Error(`${this.file}: duplicate change id ${c.id}`);
      seen.add(c.id);
    });
    return { repo: env.repo ?? null, defaultBranch: env.defaultBranch ?? "main", limitations: env.limitations ?? [], changes: env.changes };
  }

  /** The description the export recorded for the change (U5), or NoRecordedDescription. */
  async describeChange(change: ChangeRecord): Promise<ChangeDescription> {
    const raw = parseExport(await readTextConfinedAsync(this.file, "the json-file provider's export"), this.file) as Partial<ChangesFile> | unknown[];
    const d = Array.isArray(raw) ? undefined : raw.descriptions?.[change.id];
    if (!d) throw new NoRecordedDescription(this.file, change.id);
    return structuredClone(d);
  }

  /**
   * P5: each login's account id as the export records it on its actors (author, merger, reviews): the export stands in
   * for the SCM. A login the export gives no id, or two ids, resolves to none.
   */
  async resolveAccounts(logins: readonly string[]): Promise<AccountLookup[]> {
    const f = await this.load();
    const ids = new Map<string, Set<string>>();
    for (const c of f.changes)
      for (const a of [c.author, ...(c.mergedBy ? [c.mergedBy] : []), ...c.reviews.map((r) => r.author)]) {
        if (a.id === undefined) continue;
        const k = normalizeLogin(a.login);
        ids.set(k, (ids.get(k) ?? new Set()).add(a.id));
      }
    return logins.map((login) => {
      const found = [...(ids.get(normalizeLogin(login)) ?? [])];
      if (found.length === 1) return { login, id: found[0]! };
      return { login, id: null, detail: found.length ? `${this.file} gives ${login} ${found.length} account ids (${found.sort().join(", ")})` : `${this.file} records no account id for ${login}` };
    });
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const f = await this.load();
    if (f.repo !== null && f.repo !== req.repo) throw new Error(`${this.file} is an export of ${f.repo}, not ${req.repo}`);
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const wrongRepo = f.changes.find((c) => c.repo !== req.repo);
    if (wrongRepo) throw new Error(`${this.file}: change ${wrongRepo.id} is in repo ${wrongRepo.repo}, not ${req.repo}`);
    const changes = f.changes.filter((c) => {
      const t = Date.parse(c.mergedAt);
      return t >= opens && t < closes && req.kinds.includes(c.kind);
    });
    return {
      changes: changes.map((c) => structuredClone(c)),
      defaultBranch: f.defaultBranch,
      limitations: [...JSON_FILE_LIMITATIONS, ...f.limitations],
      diagnostics: [{ label: "records in file outside the window or kinds", value: f.changes.length - changes.length }],
    };
  }
}

export default defineProvider<JsonFileProviderOptions>({
  providerApiVersion: PROVIDER_API_VERSION,
  name: "json-file",
  description: "Normalized ChangeRecords exported from any SCM (pr-rla/changes/v1)",
  hosts: () => [],
  create(options: JsonFileProviderOptions, ctx: ProviderContext) {
    if (!options || typeof options.path !== "string") throw new Error('json-file provider needs options.path (or --from-file <path>)');
    return new JsonFileProvider(isAbsolute(options.path) ? options.path : resolve(ctx.cwd, options.path));
  },
});
