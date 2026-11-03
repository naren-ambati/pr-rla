import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  PROVIDER_API_VERSION,
  assertChangeRecord,
  defineProvider,
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
    const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
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
