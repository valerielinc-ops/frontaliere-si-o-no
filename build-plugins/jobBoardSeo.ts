/**
 * Node-backed job-board SEO data loader.
 *
 * Pure job-board types, predicates and metadata builders live in
 * `jobBoardSeoPure.ts`, which is safe for browser consumers. This wrapper
 * preserves the historical import path for build-time data loading.
 */

export * from './jobBoardSeoPure';

import fs from 'node:fs';
import path from 'node:path';
import {
  countActiveJobsByLocale,
  type JobBoardLocale,
  type RawJob,
} from './jobBoardSeoPure';

/**
 * Read `data/jobs.json` from `rootDir` and compute per-locale active counts.
 * Returns zero counts if the file is missing or malformed — callers should
 * treat zeros as "skip dynamic override".
 */
export function getActiveJobCountsByLocale(
  rootDir: string,
): Record<JobBoardLocale, number> {
  const file = path.resolve(rootDir, 'data/jobs.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { it: 0, en: 0, de: 0, fr: 0 };
    return countActiveJobsByLocale(parsed as RawJob[]);
  } catch {
    return { it: 0, en: 0, de: 0, fr: 0 };
  }
}
