#!/usr/bin/env node

/**
 * Attribute Bing title/meta findings to the generator family that owns the
 * URL.  The full-tree crawler deliberately reports symptoms, while this
 * inventory supplies the missing repair boundary: one route family, one
 * emitter (or an explicit unknown/ambiguous result), and small URL samples.
 *
 * Keep this registry conservative.  A URL that does not match exactly is
 * more useful as `unknown` than as a guessed first match: the next issue can
 * then add the missing route with evidence instead of sending a fix to the
 * wrong generator.
 */

export const TEMPLATE_FINDING_CODES = Object.freeze([
  'title-too-long',
  'meta-description-too-short',
]);

const ARTICLE_PREFIXES = Object.freeze([
  '/articoli-frontaliere/',
  '/en/cross-border-articles/',
  '/de/grenzgaenger-artikel/',
  '/fr/articles-frontalier/',
  '/articoli-svizzera/',
  '/en/swiss-articles/',
  '/de/schweiz-artikel/',
  '/fr/articles-suisse/',
]);

const FUEL_SECTION_PREFIXES = Object.freeze([
  '/prezzi-diesel/',
  '/prezzi-benzina/',
  '/en/diesel-price-switzerland/',
  '/en/gasoline-price-switzerland/',
  '/de/dieselpreis-schweiz/',
  '/de/benzinpreis-schweiz/',
  '/fr/prix-gasoil-suisse/',
  '/fr/prix-essence-suisse/',
]);

const FUEL_INDEX_SEGMENTS = Object.freeze([
  'stazioni-svizzere',
  'swiss-stations',
  'schweizer-tankstellen',
  'stations-suisses',
  'stazioni-italia',
  'italian-stations',
  'italienische-tankstellen',
  'stations-italiennes',
  'citta-italiane',
  'italian-cities',
  'italienische-staedte',
  'villes-italiennes',
]);

const HEALTH_FACILITY_PREFIXES = Object.freeze([
  '/strutture-sanitarie/',
  '/en/healthcare-facilities/',
  '/de/gesundheitseinrichtungen/',
  '/fr/etablissements-sante/',
]);

const PLATE_AUCTION_PREFIXES = Object.freeze([
  '/aste-targhe-svizzera/',
  '/en/swiss-plate-auctions/',
  '/de/schweizer-nummernschildauktionen/',
  '/fr/encheres-plaques-suisses/',
]);

const JOB_BOARD_ROUTE_RE = /^\/(?:(?:en|de|fr)\/)?(?:cerca-lavoro|find-jobs|jobs-in-der|jobs-in|jobs-im|trouver-emploi)-[a-z0-9-]+(?:\/|$)/i;

function isFuelIndexPath(pathname) {
  return FUEL_SECTION_PREFIXES.some((section) =>
    FUEL_INDEX_SEGMENTS.some((segment) => pathname.startsWith(`${section}${segment}/`)));
}

const FAMILY_DEFINITIONS = Object.freeze([
  {
    id: 'article-pages',
    label: 'Articoli editoriali',
    sourcePaths: Object.freeze([
      'packages/articles/engine/ogPagesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: (pathname) => ARTICLE_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
  },
  {
    id: 'fuel-station-index-pages',
    label: 'Indici stazioni/carburanti',
    sourcePaths: Object.freeze([
      'build-plugins/fuelStationIndexPages.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: isFuelIndexPath,
  },
  {
    id: 'fuel-daily-pages',
    label: 'Pagine carburante giornaliere/leaf',
    sourcePaths: Object.freeze([
      'build-plugins/fuelDailyPagesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: (pathname) => FUEL_SECTION_PREFIXES.some((section) => pathname.startsWith(section))
      && !isFuelIndexPath(pathname),
  },
  {
    id: 'health-facility-pages',
    label: 'Strutture sanitarie',
    sourcePaths: Object.freeze([
      'build-plugins/healthFacilitiesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: (pathname) => HEALTH_FACILITY_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
  },
  {
    id: 'plate-auction-pages',
    label: 'Aste targhe',
    sourcePaths: Object.freeze([
      'build-plugins/plateAuctionsPagesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: (pathname) => PLATE_AUCTION_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
  },
  {
    id: 'job-board-pages',
    label: 'Hub e pagine job board',
    sourcePaths: Object.freeze([
      'build-plugins/jobsSeoPagesPlugin.ts',
      'services/seo/meta-descriptions.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: (pathname) => JOB_BOARD_ROUTE_RE.test(pathname),
  },
]);

const UNKNOWN_FAMILY = Object.freeze({
  id: 'unknown',
  label: 'Template non classificato',
  sourcePaths: Object.freeze([]),
});

const AMBIGUOUS_FAMILY = Object.freeze({
  id: 'ambiguous',
  label: 'Template ambiguo',
  sourcePaths: Object.freeze([]),
});

function pathnameFor(value) {
  try {
    const parsed = new URL(String(value || ''), 'https://frontaliereticino.ch');
    const pathname = parsed.pathname.replace(/\/+/g, '/') || '/';
    return pathname.length > 1 && !pathname.endsWith('/') ? `${pathname}/` : pathname;
  } catch {
    return null;
  }
}

/**
 * Resolve a URL to exactly one known family, or preserve uncertainty.
 *
 * @returns {{id: string, label: string, sourcePaths: string[], pathname: string|null, reason?: string}}
 */
export function classifyBingTemplate(value) {
  const pathname = pathnameFor(value);
  if (!pathname) return { ...UNKNOWN_FAMILY, pathname: null, reason: 'invalid-url' };

  const matches = FAMILY_DEFINITIONS.filter((family) => family.matches(pathname));
  if (matches.length === 1) {
    const { matches: _matcher, ...family } = matches[0];
    return { ...family, pathname };
  }
  if (matches.length > 1) return { ...AMBIGUOUS_FAMILY, pathname, reason: 'multiple-route-families' };
  return { ...UNKNOWN_FAMILY, pathname, reason: 'no-route-family' };
}

function emptyCodeCounts() {
  return Object.fromEntries(TEMPLATE_FINDING_CODES.map((code) => [code, 0]));
}

function emptySamples() {
  return Object.fromEntries(TEMPLATE_FINDING_CODES.map((code) => [code, []]));
}

/**
 * Build a compact, deterministic inventory from crawler findings.
 *
 * Only the two residual metadata codes are included.  Samples are bounded so
 * the issue body stays readable while the full finding list remains in the
 * JSON artifact for follow-up decomposition.
 */
export function buildTemplateInventory(findings, { sampleLimit = 3 } = {}) {
  const limit = Math.max(0, Math.floor(Number(sampleLimit) || 0));
  const byFamily = new Map();
  const relevant = (findings || [])
    .filter((item) => TEMPLATE_FINDING_CODES.includes(item?.code))
    .map((item) => ({ item, classification: classifyBingTemplate(item.url) }))
    .sort((a, b) => `${a.item.code}\u0000${a.item.url}`.localeCompare(`${b.item.code}\u0000${b.item.url}`));

  for (const { item, classification } of relevant) {
    const current = byFamily.get(classification.id) || {
      id: classification.id,
      label: classification.label,
      sourcePaths: [...classification.sourcePaths],
      findingCount: 0,
      urlSet: new Set(),
      codeCounts: emptyCodeCounts(),
      samples: emptySamples(),
      reasons: new Set(),
    };
    current.findingCount += 1;
    current.urlSet.add(item.url);
    current.codeCounts[item.code] += 1;
    if (classification.reason) current.reasons.add(classification.reason);
    if (current.samples[item.code].length < limit && !current.samples[item.code].includes(item.url)) {
      current.samples[item.code].push(item.url);
    }
    byFamily.set(classification.id, current);
  }

  const families = [...byFamily.values()]
    .map((family) => ({
      id: family.id,
      label: family.label,
      sourcePaths: family.sourcePaths,
      findingCount: family.findingCount,
      urlCount: family.urlSet.size,
      codeCounts: family.codeCounts,
      samples: family.samples,
      ...(family.reasons.size > 0 ? { reasons: [...family.reasons].sort() } : {}),
    }))
    .sort((a, b) => b.findingCount - a.findingCount || a.id.localeCompare(b.id));

  const classifiedFindings = relevant.filter(({ classification }) =>
    classification.id !== UNKNOWN_FAMILY.id && classification.id !== AMBIGUOUS_FAMILY.id).length;
  return {
    version: 1,
    findingCount: relevant.length,
    classifiedFindings,
    unclassifiedFindings: relevant.length - classifiedFindings,
    families,
  };
}

export { ARTICLE_PREFIXES, FAMILY_DEFINITIONS, FUEL_SECTION_PREFIXES, HEALTH_FACILITY_PREFIXES, PLATE_AUCTION_PREFIXES };
