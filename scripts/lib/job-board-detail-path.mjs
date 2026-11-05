import { readFileSync } from 'node:fs';
import {
  AGGREGATE_KEY,
  SECTION_LEGACY_TI,
  TI_LEGACY_CITY_HUB_SLUGS,
  createCantonResolvers,
} from '../../build-plugins/shared/cantonResolvers.mjs';

const cantonSlugFile = JSON.parse(readFileSync(new URL('../../data/canton-url-slugs.json', import.meta.url), 'utf8'));
const municipalitiesFile = JSON.parse(readFileSync(new URL('../../data/canton-municipalities.json', import.meta.url), 'utf8'));
const {
  isKnownCityHubSlug,
  resolveCantonFromSection,
} = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

/** Shared route shape for a flat page below a canton-aware job board. */
export const JOB_BOARD_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/[^/]+\/$/i;

/**
 * Positive route identity for a flat job detail.
 *
 * The one-segment shape is shared by details and hubs. This predicate mirrors
 * the router's city-vs-job split: known city hubs are not details, including
 * the five legacy TI hubs and the data-driven cities under new canton roots.
 * Editorial/category/company exclusions remain with callers because their
 * contracts differ (for example, a live sitemap pre-filter accepts a real job
 * slug that happens to start with `company-`).
 */
export function isJobBoardDetailPath(path) {
  const normalized = String(path || '').endsWith('/') ? String(path || '') : `${String(path || '')}/`;
  if (!JOB_BOARD_DETAIL_PATH_RE.test(normalized)) return false;

  const parts = normalized.split('/').filter(Boolean);
  const locale = ['en', 'de', 'fr'].includes(parts[0]?.toLowerCase()) ? parts[0].toLowerCase() : 'it';
  const sectionIndex = locale === 'it' ? 0 : 1;
  const section = parts[sectionIndex]?.toLowerCase();
  const slug = parts[sectionIndex + 1]?.toLowerCase();
  if (!section || !slug) return false;

  const canton = resolveCantonFromSection(locale, section);
  if (!canton) return false;

  // The legacy router branch owns only these five clean TI hubs. New-canton
  // sections use the data-driven city resolver below.
  if (canton === 'TI' && section === SECTION_LEGACY_TI[locale]) {
    return !TI_LEGACY_CITY_HUB_SLUGS.includes(slug);
  }
  return !isKnownCityHubSlug(slug, canton === AGGREGATE_KEY ? undefined : canton);
}
