/**
 * Node-backed job-board SEO data loader.
 *
 * Pure job-board types, predicates and metadata builders live in
 * `jobBoardSeoPure.ts`, which is safe for browser consumers. This wrapper
 * preserves the historical import path for build-time data loading.
 */

export * from './jobBoardSeoPure';

import path from 'node:path';
import { expandCantonGroup } from '../services/cantonList';
import {
  isListingInventoryJob,
  listingInventoryId,
  normalizeListingIdentity,
} from '../services/jobBoardInventory';
import { iterateJsonArrayFile } from '../scripts/lib/read-large-json.mjs';
import { buildLocaleJob, type JobEntry } from './shared/slimJobIndex';
import { isFixtureJob } from '../scripts/lib/fixture-data-filter.mjs';
import type { JobBoardLocale } from './jobBoardSeoPure';

/**
 * Read `data/jobs.json` from `rootDir` and count the same canton inventory delivered to the SPA.
 * Translation eligibility affects detail indexation, never the visible list total.
 * When no canton is supplied, the count covers the national aggregate; callers
 * that render a canton landing pass its explicit canton code.
 * Returns zero counts if the file is missing or malformed — callers should
 * treat zeros as "skip dynamic override".
 */
export function getActiveJobCountsByLocale(
  rootDir: string,
  canton?: string,
): Record<JobBoardLocale, number> {
  const file = path.resolve(rootDir, 'data/jobs.json');
  try {
    const inventoryCanton = canton ?? '_AGGREGATE_';
    const cantonMembers = inventoryCanton === '_AGGREGATE_'
      ? null
      : new Set(expandCantonGroup(inventoryCanton));
    const seenByLocale = {
      it: new Set<string>(),
      en: new Set<string>(),
      de: new Set<string>(),
      fr: new Set<string>(),
    };

    for (const value of iterateJsonArrayFile(file)) {
      if (!value || typeof value !== 'object') continue;
      const rawJob = value as JobEntry;
      if (isFixtureJob(rawJob) || !isListingInventoryJob(rawJob)) continue;
      const job = normalizeListingIdentity(rawJob);
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const localized = buildLocaleJob(job, locale);
        if (!isListingInventoryJob(localized)) continue;
        if (cantonMembers && !cantonMembers.has(String(localized.canton || ''))) continue;
        seenByLocale[locale].add(listingInventoryId(localized));
      }
    }

    return {
      it: seenByLocale.it.size,
      en: seenByLocale.en.size,
      de: seenByLocale.de.size,
      fr: seenByLocale.fr.size,
    };
  } catch {
    return { it: 0, en: 0, de: 0, fr: 0 };
  }
}
