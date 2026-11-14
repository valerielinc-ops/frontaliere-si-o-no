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
 * unparsable file is an error and is rethrown with the plugin label.
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

export function readJobsArrayStrict<T = unknown>(rootDir: string, label: string): readonly T[] {
  const jobsPath = np.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];
  try {
    const parsed = readJsonFile(jobsPath);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    throw new DatasetReadError(label, jobsPath, err);
  }
}
