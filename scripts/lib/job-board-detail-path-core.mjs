import {
  AGGREGATE_KEY,
  SECTION_LEGACY_TI,
  TI_LEGACY_CITY_HUB_SLUGS,
  createCantonResolvers,
} from '../../build-plugins/shared/cantonResolvers.mjs';

/**
 * Shared route shape for a page below a canton-aware job board.
 *
 * Canonical details are flat (`/<section>/<slug>/`). Keep the optional
 * city/detail form too: old city-scoped links can still occur in the served
 * URL ledger and the final segment is the job slug in that shape.
 */
export const JOB_BOARD_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/(?:[^/]+\/){1,2}$/i;

/**
 * Parse a job-board detail route without reading data files.
 *
 * @param {string} input
 * @returns {{ locale: string, section: string, tail: string[] } | null}
 */
export function parseJobBoardDetailPath(input) {
  const value = String(input || '');
  const normalized = value.endsWith('/') ? value : `${value}/`;
  if (!JOB_BOARD_DETAIL_PATH_RE.test(normalized)) return null;

  const parts = normalized.split('/').filter(Boolean);
  const locale = ['en', 'de', 'fr'].includes(parts[0]?.toLowerCase()) ? parts[0].toLowerCase() : 'it';
  const sectionIndex = locale === 'it' ? 0 : 1;
  const section = parts[sectionIndex]?.toLowerCase();
  const tail = parts.slice(sectionIndex + 1).map((part) => part.toLowerCase());
  if (!section || tail.length < 1 || tail.length > 2 || tail.some((part) => !part)) return null;
  return { locale, section, tail };
}

/**
 * Create the full-checkout route matcher used by assembly.
 *
 * Keeping file loading outside this module lets sparse-checkout adapters
 * change without changing the assembler's code fingerprint.
 */
export function createJobBoardDetailPathMatcher({ cantonSlugFile, municipalitiesFile }) {
  const { isKnownCityHubSlug, resolveCantonFromSection } = createCantonResolvers({
    cantonSlugFile,
    municipalitiesFile,
  });

  return function isJobBoardDetailPath(input) {
    const parsed = parseJobBoardDetailPath(input);
    if (!parsed) return false;

    const { locale, section, tail } = parsed;
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
  };
}
