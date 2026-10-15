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

import { FUEL_INDEX_SLUG, FUEL_SECTION_SLUG } from '../../build-plugins/shared/fuelRouteSlugs.mjs';
import { isBlogSectionPath } from '../lib/articleSections.mjs';
import { isHealthFacilitiesSectionPath } from '../lib/healthFacilitiesSections.mjs';
import { isJobBoardSectionPathname } from '../lib/jobBoardSections.mjs';
import { isPlateAuctionSectionPath } from '../lib/plateAuctionSections.mjs';
import { BING_METADATA_FINDING_CODES } from './bing-finding-codes.mjs';

export const TEMPLATE_FINDING_CODES = BING_METADATA_FINDING_CODES;

const FUEL_SECTION_PREFIXES = Object.freeze(
  Object.entries(FUEL_SECTION_SLUG).flatMap(([locale, byFuel]) => Object.values(byFuel).map((slug) =>
    `/${locale === 'it' ? '' : `${locale}/`}${slug}/`)),
);

const FUEL_INDEX_SEGMENTS = Object.freeze(
  Object.values(FUEL_INDEX_SLUG).flatMap((byLocale) => Object.values(byLocale)),
);

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
    matches: isBlogSectionPath,
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
    id: 'fuel-daily-route-family',
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
    matches: isHealthFacilitiesSectionPath,
  },
  {
    id: 'plate-auction-route-family',
    label: 'Aste targhe',
    sourcePaths: Object.freeze([
      'build-plugins/plateAuctionsPagesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: isPlateAuctionSectionPath,
  },
  {
    id: 'job-board-pages',
    label: 'Hub e pagine job board',
    sourcePaths: Object.freeze([
      'build-plugins/jobsSeoPagesPlugin.ts',
      'services/seo/meta-descriptions.ts',
      'build-plugins/shared/titleSuffix.ts',
    ]),
    matches: isJobBoardSectionPathname,
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

/**
 * Stable compact family table shared by the crawl artifacts.
 *
 * Referrer records store only `[sitemapUrlIndex, templateIndex]`; labels and
 * source paths live here once instead of being repeated for every frontier
 * URL. Keep the order append-only so an artifact can be inspected alongside
 * the code version that produced it.
 */
export const BING_TEMPLATE_TABLE = Object.freeze([
  ...FAMILY_DEFINITIONS,
  UNKNOWN_FAMILY,
  AMBIGUOUS_FAMILY,
].map(({ matches: _matcher, ...family }) => Object.freeze({
  id: family.id,
  label: family.label,
  sourcePaths: Object.freeze([...family.sourcePaths]),
})));

const TEMPLATE_INDEX_BY_ID = new Map(BING_TEMPLATE_TABLE.map((family, index) => [family.id, index]));
const UNKNOWN_TEMPLATE_INDEX = TEMPLATE_INDEX_BY_ID.get(UNKNOWN_FAMILY.id);

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

/** Return the stable compact index for a page's classified template family. */
export function templateIndexFor(value) {
  const id = classifyBingTemplate(value).id;
  return TEMPLATE_INDEX_BY_ID.get(id) ?? UNKNOWN_TEMPLATE_INDEX;
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

/**
 * Attribute frontier findings to the page template that emitted each link.
 *
 * `frontierManifest.referrerRefs` is aligned with `frontierManifest.urls` and
 * contains compact `[sitemapUrlIndex, templateIndex]` pairs. The output keeps
 * the same table once, then emits bounded rows and URL samples for the issue.
 */
export function buildFrontierAttribution(findings, {
  frontierManifest = null,
  sitemapManifest = null,
  sampleLimit = 3,
} = {}) {
  const limit = Math.max(0, Math.floor(Number(sampleLimit) || 0));
  const frontierUrls = frontierManifest?.urls || [];
  const referrerRefs = frontierManifest?.referrerRefs || [];
  const refsByTarget = new Map(frontierUrls.map((url, index) => [url, referrerRefs[index] || []]));
  const rows = new Map();
  let findingsWithReferrer = 0;

  for (const item of findings || []) {
    if (item?.scope !== 'discovered-frontier') continue;
    const targetTemplate = templateIndexFor(item.url);
    const refs = (refsByTarget.get(item.url) || [])
      .filter((pair) => Array.isArray(pair) && pair.length >= 2)
      .map(([sourceIndex, referrerTemplate]) => [Number(sourceIndex), Number(referrerTemplate)])
      .filter(([sourceIndex, referrerTemplate]) => Number.isInteger(sourceIndex) && Number.isInteger(referrerTemplate));
    const effectiveRefs = refs.length > 0 ? refs : [[-1, UNKNOWN_TEMPLATE_INDEX]];
    if (refs.length > 0) findingsWithReferrer += 1;

    for (const [sourceIndex, referrerTemplate] of effectiveRefs) {
      const key = `${referrerTemplate}\u0000${targetTemplate}\u0000${item.code}`;
      const current = rows.get(key) || {
        referrerTemplate,
        targetTemplate,
        code: item.code,
        findingCount: 0,
        samples: [],
        sampleKeys: new Set(),
        findingKeys: new Set(),
      };
      if (!current.findingKeys.has(item.url)) {
        current.findingKeys.add(item.url);
        current.findingCount += 1;
      }
      const sourceUrl = sitemapManifest?.urls?.[sourceIndex] || '';
      if (sourceUrl && current.samples.length < limit) {
        const sampleKey = `${sourceUrl}\u0000${item.url}`;
        if (!current.sampleKeys.has(sampleKey)) {
          current.sampleKeys.add(sampleKey);
          current.samples.push([sourceUrl, item.url]);
        }
      }
      rows.set(key, current);
    }
  }

  return {
    version: 1,
    templateTable: frontierManifest?.templateTable || BING_TEMPLATE_TABLE,
    findingCount: (findings || []).filter((item) => item?.scope === 'discovered-frontier').length,
    findingsWithReferrer,
    unreferencedFindings: (findings || []).filter((item) => item?.scope === 'discovered-frontier' && !(refsByTarget.get(item.url) || []).length).length,
    rows: [...rows.values()]
      .map(({ sampleKeys: _sampleKeys, findingKeys: _findingKeys, ...row }) => row)
      .sort((a, b) => b.findingCount - a.findingCount
        || a.referrerTemplate - b.referrerTemplate
        || a.targetTemplate - b.targetTemplate
        || a.code.localeCompare(b.code)),
  };
}

export {
  FAMILY_DEFINITIONS,
  FUEL_SECTION_PREFIXES,
};
