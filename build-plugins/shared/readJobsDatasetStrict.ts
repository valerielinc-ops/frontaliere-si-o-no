/**
 * Fail-closed read of `data/jobs.json` for build plugins.
 *
 * A plugin that cannot read the job dataset must STOP the build, not continue
 * with zero jobs: the build would otherwise publish per-canton / per-profession
 * pages computed from nothing and report success (run 43520109946, 2026-11-14:
 * `[weekly-employers]` and `[orphan-query-landings]` logged "failed to parse
 * jobs.json" and went on with 0 jobs, `degraded=false`).
 *
 * A MISSING file stays an empty corpus: fixture roots and shallow checkouts have
 * none, and `prep` always assembles it before a real build. An unreadable or
 * unparsable file is an error and is rethrown with the plugin label, and so is a
 * file that parses to the WRONG SHAPE (`{}`, `null`, a number...): only a JSON
 * array or the `{ jobs: [...] }` envelope is a dataset. Reading `{}` as `[]`
 * would emit empty SEO pages with a green build, the exact fail-open this module
 * exists to close.
 */
import * as fs from 'node:fs';
import * as np from 'node:path';
import { readJsonFile } from '../../scripts/lib/read-large-json.mjs';

export class DatasetReadError extends Error {
  constructor(label: string, filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`[${label}] cannot read ${np.basename(filePath)}: ${detail} — refusing to continue with 0 jobs`);
    this.name = 'DatasetReadError';
    (this as { cause?: unknown }).cause = cause;
  }
}

/** What a parsed value is, for the error message. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object without a `jobs` array' : typeof value;
}

/**
 * The jobs of a parsed dataset: the array itself, or the `jobs` array of the
 * `{ jobs: [...] }` envelope (small files arrive as that object through
 * JSON.parse). Anything else is an error, never an empty corpus.
 */
export function jobsFromParsedDataset<T = unknown>(parsed: unknown, label: string, filePath: string): T[] {
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown }).jobs)) {
    return (parsed as { jobs: T[] }).jobs;
  }
  throw new DatasetReadError(label, filePath, new Error(`expected a JSON array or { jobs: [...] }, got ${describeShape(parsed)}`));
}

export function readJobsArrayStrict<T = unknown>(rootDir: string, label: string): readonly T[] {
  const jobsPath = np.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];
  let parsed: unknown;
  try {
    parsed = readJsonFile(jobsPath);
  } catch (err) {
    throw new DatasetReadError(label, jobsPath, err);
  }
  // Outside the catch: a wrong shape is already a DatasetReadError, not re-wrapped.
  return jobsFromParsedDataset<T>(parsed, label, jobsPath);
}
