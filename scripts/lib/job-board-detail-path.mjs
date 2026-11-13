import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGGREGATE_KEY,
  SECTION_LEGACY_TI,
  TI_LEGACY_CITY_HUB_SLUGS,
  createCantonResolvers,
} from '../../build-plugins/shared/cantonResolvers.mjs';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
let resolvers;

/**
 * The housekeeping sparse checkout deliberately omits the generated data
 * tree. Keep the route resolver data-injected and lazy so importing the slug
 * stability rule does not make that lightweight job fail at module load; the
 * full checkout still gets the exact data-driven city-vs-job decision.
 */
function getResolvers() {
  if (resolvers !== undefined) return resolvers;
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    resolvers = createCantonResolvers({
      cantonSlugFile: read('canton-url-slugs.json'),
      municipalitiesFile: read('canton-municipalities.json'),
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    resolvers = null;
  }
  return resolvers;
}

/**
 * Shared route shape for a page below a canton-aware job board.
 *
 * Canonical details are flat (`/<section>/<slug>/`). Keep the optional
 * city/detail form too: old city-scoped links can still occur in the served
 * URL ledger and the final segment is the job slug in that shape.
 */
export const JOB_BOARD_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/(?:[^/]+\/){1,2}$/i;

/**
 * Positive route identity for a job detail.
 *
 * The one-segment shape is shared by details and hubs. This predicate mirrors
 * the router's city-vs-job split: known city hubs are not details, including
 * the five legacy TI hubs and the data-driven cities under new canton roots.
 * A two-segment tail is a city-scoped detail only when its first segment is a
 * known city for the resolved canton. Editorial/category/company exclusions
 * remain with callers because their contracts differ (for example, a live
 * sitemap pre-filter accepts a real job slug that happens to start with
 * `company-`).
 */
export function isJobBoardDetailPath(path) {
  const normalized = String(path || '').endsWith('/') ? String(path || '') : `${String(path || '')}/`;
  if (!JOB_BOARD_DETAIL_PATH_RE.test(normalized)) return false;

  const parts = normalized.split('/').filter(Boolean);
  const locale = ['en', 'de', 'fr'].includes(parts[0]?.toLowerCase()) ? parts[0].toLowerCase() : 'it';
  const sectionIndex = locale === 'it' ? 0 : 1;
  const section = parts[sectionIndex]?.toLowerCase();
  const tail = parts.slice(sectionIndex + 1).map((part) => part.toLowerCase());
  if (!section || tail.length < 1 || tail.length > 2 || tail.some((part) => !part)) return false;

  const routeResolvers = getResolvers();
  if (!routeResolvers) {
    if (cantonIsLegacyTi(locale, section)) {
      if (tail.length === 2) return TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
      return !TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
    }
    // A sparse checkout without the route data cannot prove that a one-tail
    // path is a city hub. Keep the old positive shape as the safe fallback;
    // the full deploy checkout always takes the data-driven branch below.
    return tail.length === 1;
  }

  const { isKnownCityHubSlug, resolveCantonFromSection } = routeResolvers;
  const canton = resolveCantonFromSection(locale, section);
  if (!canton) return false;

  if (tail.length === 2) {
    // A city/detail path is valid only when the first tail segment is a
    // router-owned city hub. This keeps `/section/city/` out of the ledger
    // while retaining the nested detail form used by older links.
    const [city] = tail;
    const cityIsKnown = canton === 'TI' && section === SECTION_LEGACY_TI[locale]
      ? TI_LEGACY_CITY_HUB_SLUGS.includes(city)
      : isKnownCityHubSlug(city, canton === AGGREGATE_KEY ? undefined : canton);
    return cityIsKnown;
  }

  const [slug] = tail;
  // The legacy router branch owns only these five clean TI hubs. New-canton
  // sections use the data-driven city resolver below.
  if (canton === 'TI' && section === SECTION_LEGACY_TI[locale]) {
    return !TI_LEGACY_CITY_HUB_SLUGS.includes(slug);
  }
  return !isKnownCityHubSlug(slug, canton === AGGREGATE_KEY ? undefined : canton);
}

function cantonIsLegacyTi(locale, section) {
  return section === SECTION_LEGACY_TI[locale];
}
