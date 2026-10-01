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
import { selectJobBoardInventory } from '../services/jobBoardInventory';
import { buildLocaleJob, type JobEntry } from './shared/slimJobIndex';
import { isFixtureJob } from '../scripts/lib/fixture-data-filter.mjs';
import type { JobBoardLocale } from './jobBoardSeoPure';

/**
 * Read `data/jobs.json` from `rootDir` and count the same canton inventory delivered to the SPA.
 * Translation eligibility affects detail indexation, never the visible list total.
 * Returns zero counts if the file is missing or malformed — callers should
 * treat zeros as "skip dynamic override".
 */
export function getActiveJobCountsByLocale(
  rootDir: string,
  canton = 'TI',
): Record<JobBoardLocale, number> {
  const file = path.resolve(rootDir, 'data/jobs.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { it: 0, en: 0, de: 0, fr: 0 };
    const jobs = (parsed as JobEntry[]).filter((job) => !isFixtureJob(job));
    return Object.fromEntries((['it', 'en', 'de', 'fr'] as const).map((locale) => [
      locale, selectJobBoardInventory(jobs.map((job) => buildLocaleJob(job, locale)), canton).length,
    ])) as Record<JobBoardLocale, number>;
  } catch {
    return { it: 0, en: 0, de: 0, fr: 0 };
  }
}
