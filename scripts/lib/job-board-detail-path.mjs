import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTION_LEGACY_TI,
  TI_LEGACY_CITY_HUB_SLUGS,
} from '../../build-plugins/shared/cantonResolvers.mjs';
import { isJobBoardSectorHubPath } from '../../build-plugins/shared/jobSectorSlugs.mjs';
import { JOB_BOARD_COMPANY_HUB_PATH_RX } from './jobBoardCompanyHubPath.mjs';
import {
  createJobBoardDetailPathMatcher,
  JOB_BOARD_DETAIL_PATH_RE,
  parseJobBoardDetailPath,
} from './job-board-detail-path-core.mjs';

export { JOB_BOARD_DETAIL_PATH_RE, parseJobBoardDetailPath };

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
let matcher;

/**
 * Sparse-checkout adapter for tools that need the route helper without the
 * generated canton data. The assembly path uses the data-driven core through
 * the slug-stability rule, so changes to this fallback do not invalidate its
 * cached output.
 */
function getMatcher() {
  if (matcher !== undefined) return matcher;
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    matcher = createJobBoardDetailPathMatcher({
      cantonSlugFile: read('canton-url-slugs.json'),
      municipalitiesFile: read('canton-municipalities.json'),
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    matcher = null;
  }
  return matcher;
}

/**
 * Positive route identity for a job detail, with a conservative fallback for
 * sparse checkouts that omit the route data.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isJobBoardDetailPath(input) {
  const parsed = parseJobBoardDetailPath(input);
  if (!parsed) return false;

  const fullMatcher = getMatcher();
  if (fullMatcher) return fullMatcher(input);

  const { locale, section, tail } = parsed;
  if (section === SECTION_LEGACY_TI[locale]) {
    if (tail.length === 2) return TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
    return !TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
  }
  // Without route data a sparse checkout cannot prove that a one-tail path is
  // a city hub. Full checkouts always use the data-driven matcher above.
  return tail.length === 1;
}

const NON_DETAIL_EXACT_SLUGS = new Set([
  'tutti', 'all', 'alle', 'tous',
  'aziende', 'companies', 'unternehmen', 'entreprises',
  'settori', 'sectors', 'branchen', 'secteurs',
  'categoria', 'category', 'kategorie', 'categorie',
  'ricerca', 'recherche', 'search', 'suche',
]);
const CATEGORY_HUB_SLUG_PREFIXES = ['categoria-', 'category-', 'kategorie-', 'categorie-'];
const NON_DETAIL_SLUG_PREFIXES = [
  'ricerca-', 'search-', 'suche-', 'recherche-',
  ...CATEGORY_HUB_SLUG_PREFIXES,
  'pagina-', 'page-', 'seite-',
];

/**
 * True for a job-board category hub (`/<locale>/<canton section>/categoria-*`
 * and its localized siblings). These are sitemap-listed but are not details,
 * so `isJobBoardSitemapDetailPath` never selects them: cleanup of a hub that
 * is no longer emitted needs this separate, equally positive predicate.
 */
export function isJobBoardCategoryHubPath(input) {
  if (!isJobBoardDetailPath(input)) return false;
  const slug = String(input).split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
  return CATEGORY_HUB_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

/**
 * True only for a job-detail-shaped route, excluding the hub families that
 * share the same section/leaf shape and are also allowed in job sitemaps.
 * This is the safe population for cleanup against the JobPosting allowlist.
 */
export function isJobBoardSitemapDetailPath(input) {
  if (!isJobBoardDetailPath(input)) return false;
  if (JOB_BOARD_COMPANY_HUB_PATH_RX.test(input)) return false;
  if (isJobBoardSectorHubPath(input)) return false;
  const slug = String(input).split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
  return (
    !NON_DETAIL_EXACT_SLUGS.has(slug) &&
    !NON_DETAIL_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))
  );
}
