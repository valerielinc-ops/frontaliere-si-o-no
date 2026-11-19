/**
 * Per-family URL-count ratchet used by the post-deploy sitemap comparison.
 * Counts include each unique canonical loc and its listed hreflang URLs.
 */

import { isExternallyServedUrl } from './externally-served-paths.mjs';

export const SITEMAP_FAMILY_COVERAGE_KEYS = Object.freeze([
  'events',
  'fuel-italian-stations',
  'job-market',
  'orphan-landings',
  'profession-cantons',
  'profession-cities',
  'topics',
]);

/**
 * These families have membership driven by live data: rendered indexability
 * (matchingJobs >= 3 and wordCount >= MIN) for orphan-landings, the ad floor
 * for profession-cities, and the presence of a fuel price for
 * fuel-italian-stations (a station that loses its diesel price keeps its
 * route slot). Below the floor, the build emits a noindex,follow bridge at
 * the same URL and removes that page from the sitemap (AGENTS.md).
 * 0.1 is a COLLAPSE bound (loss of the mechanism), not a churn allowance.
 * Never add a structural family here without an explicit decision. Adding
 * fuel-italian-stations is that motivated decision: the family is data-driven,
 * not structural, and the tolerance still requires valid bridge evidence for
 * every removed URL (noindex,follow file in dist).
 * Evidence: publisher 43795558997 (orphan-landings 1913→1906 = -0.4%,
 * profession-cities 252→248 = -1.6%); publisher 44286440277
 * (fuel-italian-stations 4120→4112 = -0.19%: 2 stations without a diesel
 * price x 4 locales = 8 URLs replaced by noindex,follow bridges).
 *
 * Per-family proof that membership is data/time driven AND the build keeps a
 * noindex,follow document at the SAME URL when the page leaves the sitemap:
 * - fuel-italian-stations: price presence; build-plugins/fuelDailyPagesPlugin.ts:5560
 *   (generateFuelItalianStationAvailabilityBridges) -> renderFuelBelowFloorBridge
 *   (fuelDailyPagesPlugin.ts:211, buildCanonicalBridgePage noindex).
 * - profession-cantons: jobs floor (meetsJobsFloor); build-plugins/professionCantonLandings.ts:607
 *   and :644 -> renderProfessionBelowFloorBridge -> shared/salaryStatsBridge.ts:55-63 (noindex: true).
 * - topics: TOPIC_HUB_MIN_ARTICLES floor and thin-page gate; build-plugins/topicClusterHubsPlugin.ts:1085
 *   and :1120 -> renderBridgePage (:639, robots 'noindex,follow' at :667), same URL.
 * - job-market: weekly archives past WEEKLY_INDEXABLE_LIMIT; build-plugins/jobMarketSnapshotPlugin.ts:2276-2286
 *   keeps emitting the page with noindex (robots at :1766) and drops it from the sitemap (:2301).
 * NOT here by construction: events. Its sitemap URLs are content pages, ended events
 * move to the indexable sitemap-eventi-storici.xml and the redirect bridge is
 * `noindex: false` (build-plugins/eventsSeoPagesPlugin.ts:5155-5160), so an
 * events decrease has no noindex,follow bridge and must stay a regression.
 */
export const SITEMAP_FAMILY_CHURN_TOLERANCE = Object.freeze({
  'fuel-italian-stations': 0.1,
  'job-market': 0.1,
  'orphan-landings': 0.1,
  'profession-cantons': 0.1,
  'profession-cities': 0.1,
  topics: 0.1,
});

export const SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION = 1;

/**
 * Keep the family-count ratchet inside the same ownership boundary as the
 * publisher sitemap validator. Article URLs are refreshed and served by the
 * corpus repo, so their local copies cannot prove this site's coverage.
 */
export function filterExternallyServedUrlsFromSitemapCoverage(snapshot) {
  if (!snapshot || Array.isArray(snapshot) || !snapshot.perSitemap
    || typeof snapshot.perSitemap !== 'object' || Array.isArray(snapshot.perSitemap)) {
    return snapshot;
  }
  return {
    ...snapshot,
    perSitemap: Object.fromEntries(Object.entries(snapshot.perSitemap).map(([name, urls]) => [
      name,
      Array.isArray(urls) ? urls.filter((url) => !isExternallyServedUrl(url)) : urls,
    ])),
  };
}

/**
 * Expired job pages have a separate archive-evidence contract. Their sitemap
 * population is intentionally much larger than the active page manifests, so
 * the publisher gate must not treat those URLs as active-page omissions.
 */
export const EXPIRED_JOB_SITEMAP_FILE_RX = /^sitemap-jobs-expired(?:-\d+)?\.xml$/u;

export function isExpiredJobSitemapKey(key) {
  const name = String(key || '').split('/').pop().toLowerCase();
  return EXPIRED_JOB_SITEMAP_FILE_RX.test(name);
}

export function sitemapCoverageFamilyForKey(key) {
  const name = String(key || '').split('/').pop().toLowerCase();
  if (name === 'sitemap-orphan-landings.xml') return 'orphan-landings';
  if (name === 'sitemap-profession-cantons.xml') return 'profession-cantons';
  if (name === 'sitemap-profession-cities.xml') return 'profession-cities';
  if (name === 'sitemap-fuel-italian-stations.xml') return 'fuel-italian-stations';
  if (name === 'sitemap-job-market.xml') return 'job-market';
  if (/^sitemap-topics-[a-z0-9-]+\.xml$/i.test(name)) return 'topics';
  if (/^sitemap-eventi(?:-[a-z0-9-]+)?\.xml$/i.test(name)) return 'events';
  return null;
}

function sitemapFamilyUrlSets(snapshot) {
  if (!snapshot || Array.isArray(snapshot) || !snapshot.perSitemap || typeof snapshot.perSitemap !== 'object') {
    throw new Error('A per-sitemap snapshot is required for family coverage comparison');
  }

  const urlsByFamily = new Map(SITEMAP_FAMILY_COVERAGE_KEYS.map((family) => [family, new Set()]));
  for (const [key, urls] of Object.entries(snapshot.perSitemap)) {
    const family = sitemapCoverageFamilyForKey(key);
    if (!family) continue;
    if (!Array.isArray(urls)) throw new Error(`Invalid URL list for ${key}`);
    const familyUrls = urlsByFamily.get(family);
    for (const url of urls) {
      if (typeof url !== 'string' || !url) throw new Error(`Invalid sitemap URL in ${key}`);
      familyUrls.add(url);
    }
  }
  return urlsByFamily;
}

/** Count unique URLs across each restored family, merging its sitemap shards. */
export function countSitemapFamilyUrls(snapshot) {
  const urlsByFamily = sitemapFamilyUrlSets(snapshot);
  return Object.fromEntries([...urlsByFamily].map(([family, urls]) => [family, urls.size]));
}

/** Return the complete unique URL difference within one family. */
export function sitemapFamilyUrlDifferences(previousSnapshot, currentSnapshot, family) {
  const previousUrls = sitemapFamilyUrlSets(previousSnapshot).get(family) ?? new Set();
  const currentUrls = sitemapFamilyUrlSets(currentSnapshot).get(family) ?? new Set();
  return {
    removedUrls: [...previousUrls].filter((url) => !currentUrls.has(url)).sort(),
    addedUrls: [...currentUrls].filter((url) => !previousUrls.has(url)).sort(),
  };
}

/** Compare unique URLs within one family and return sorted bounded samples. */
export function diffSitemapFamilyUrls(previousSnapshot, currentSnapshot, family) {
  const { removedUrls, addedUrls } = sitemapFamilyUrlDifferences(previousSnapshot, currentSnapshot, family);
  return {
    removed: removedUrls.length,
    added: addedUrls.length,
    removedSample: removedUrls.slice(0, 5),
    addedSample: addedUrls.slice(0, 5),
  };
}

function bridgeEvidenceEntriesForFamily(bridgeEvidence, family) {
  if (!bridgeEvidence || bridgeEvidence.schemaVersion !== SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION
    || bridgeEvidence.kind !== 'sitemap-family-bridge-evidence'
    || bridgeEvidence.complete !== true
    || !Array.isArray(bridgeEvidence.entries)) {
    return { entries: [], validShape: false };
  }
  return {
    entries: bridgeEvidence.entries.filter((entry) => entry?.family === family),
    validShape: true,
  };
}

/**
 * Validate the lightweight build receipt for URLs removed from a data-driven
 * sitemap family. The receipt is generated from the same dist tree that
 * produced the new sitemap, so the gate can verify bridge coverage without
 * downloading the full published site.
 */
export function validateSitemapFamilyBridgeEvidence(
  previousSnapshot,
  currentSnapshot,
  bridgeEvidence,
  family,
) {
  const previousUrls = sitemapFamilyUrlSets(previousSnapshot).get(family) ?? new Set();
  const currentUrls = sitemapFamilyUrlSets(currentSnapshot).get(family) ?? new Set();
  const removedUrls = [...previousUrls]
    .filter((url) => !currentUrls.has(url) && !isExternallyServedUrl(url))
    .sort();
  if (removedUrls.length === 0) return { valid: true, errors: [], entries: [] };

  const { entries, validShape } = bridgeEvidenceEntriesForFamily(bridgeEvidence, family);
  const errors = [];
  if (!validShape) {
    return {
      valid: false,
      errors: [`${family}: bridge evidence is missing or has an unsupported schema`],
      entries: [],
    };
  }

  const byUrl = new Map();
  for (const entry of entries) {
    const url = String(entry?.url ?? '');
    if (!url || byUrl.has(url)) {
      errors.push(`${family}: bridge evidence has a missing or duplicate URL ${JSON.stringify(url)}`);
      continue;
    }
    byUrl.set(url, entry);
    if (typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      errors.push(`${family}: bridge evidence path is invalid for ${url}`);
    }
    if (!/^[0-9a-f]{64}$/u.test(String(entry.sha256 ?? '').toLowerCase())) {
      errors.push(`${family}: bridge evidence hash is invalid for ${url}`);
    }
    if (entry.robots !== 'noindex,follow') {
      errors.push(`${family}: bridge evidence is not noindex,follow for ${url}`);
    }
    if (!removedUrls.includes(url)) {
      errors.push(`${family}: bridge evidence URL is not a removed sitemap URL: ${url}`);
    }
  }
  for (const url of removedUrls) {
    if (!byUrl.has(url)) errors.push(`${family}: missing bridge evidence for removed URL ${url}`);
  }

  return { valid: errors.length === 0, errors, entries };
}

function declarationsByFamily(declarations) {
  if (!declarations || declarations.version !== 1 || !Array.isArray(declarations.decreases)) {
    throw new Error('Coverage declarations must use schema version 1 and a decreases array');
  }
  const byFamily = new Map();
  const invalid = [];
  for (const [index, declaration] of declarations.decreases.entries()) {
    const family = declaration?.family;
    const reason = typeof declaration?.reason === 'string' ? declaration.reason.trim() : '';
    const valid = SITEMAP_FAMILY_COVERAGE_KEYS.includes(family)
      && Number.isInteger(declaration?.previousCount)
      && declaration.previousCount >= 0
      && Number.isInteger(declaration?.currentCount)
      && declaration.currentCount >= 0
      && declaration.currentCount < declaration.previousCount
      && reason.length >= 20;
    if (!valid || byFamily.has(family)) {
      invalid.push({ index, family: String(family || ''), reason: 'invalid or duplicate decrease declaration' });
      continue;
    }
    byFamily.set(family, { ...declaration, reason });
  }
  return { byFamily, invalid };
}

/** Compare current family counts with the pre-deploy snapshot. */
export function evaluateSitemapFamilyCoverage(previous, current, declarations, bridgeEvidence = null) {
  const before = countSitemapFamilyUrls(previous);
  const after = countSitemapFamilyUrls(current);
  const { byFamily, invalid } = declarationsByFamily(declarations);
  const usedDeclarations = new Set();
  const families = SITEMAP_FAMILY_COVERAGE_KEYS.map((family) => ({
    family,
    previousCount: before[family],
    currentCount: after[family],
    delta: after[family] - before[family],
  }));
  const regressions = [];
  const allowedDecreases = [];
  const churn = [];
  const bridgeEvidenceErrors = [];

  for (const entry of families) {
    if (entry.delta >= 0) continue;
    const tolerance = SITEMAP_FAMILY_CHURN_TOLERANCE[entry.family];
    if (tolerance !== undefined
      && entry.currentCount > 0
      && entry.previousCount - entry.currentCount <= Math.floor(entry.previousCount * tolerance)) {
      const bridge = validateSitemapFamilyBridgeEvidence(previous, current, bridgeEvidence, entry.family);
      if (bridge.valid) {
        churn.push({ ...entry, tolerance });
        continue;
      }
      bridgeEvidenceErrors.push(...bridge.errors);
    }
    const declaration = byFamily.get(entry.family);
    if (!declaration
      || declaration.previousCount !== entry.previousCount
      || declaration.currentCount !== entry.currentCount) {
      regressions.push(entry);
      continue;
    }
    usedDeclarations.add(entry.family);
    allowedDecreases.push({ ...entry, reason: declaration.reason });
  }

  // Once an exact declared decrease has been deployed, its resulting count
  // becomes the previous snapshot. Retire that declaration automatically so
  // the next deploy does not fail on an already-consumed exception. A later
  // decrease still fails above because it cannot match the same exact pair.
  const consumedDeclarations = [...byFamily.entries()]
    .filter(([family, declaration]) =>
      !usedDeclarations.has(family) && before[family] === declaration.currentCount,
    )
    .map(([family]) => ({ family, reason: 'declared decrease is now the previous deployment baseline' }));
  const consumedFamilies = new Set(consumedDeclarations.map(({ family }) => family));
  // Data-driven families use the collapse bound; their declarations are exact
  // fallbacks beyond it, not baselines that can become stale during evidenced churn.
  const staleDeclarations = [...byFamily.keys()]
    .filter((family) => SITEMAP_FAMILY_CHURN_TOLERANCE[family] === undefined)
    .filter((family) => !usedDeclarations.has(family) && !consumedFamilies.has(family))
    .map((family) => ({ family, reason: 'declaration does not match a current decrease or deployed baseline' }));

  return {
    families,
    regressions,
    allowedDecreases,
    churn,
    bridgeEvidenceErrors,
    consumedDeclarations,
    invalidDeclarations: invalid,
    staleDeclarations,
  };
}
