/**
 * Listing selectors for hosted career platforms whose public HTML has a
 * stable vacancy URL shape but no JSON-LD/microdata listing evidence.
 *
 * These functions only inspect links already present in the fetched page. The
 * caller still owns the polite transport, robots check, origin policy and
 * detail-page validation; an extractor never manufactures a URL or follows a
 * vendor API discovered in script text.
 */
import { extractLinks } from './careers-trail.mjs';
import { normalizeHost, registrableDomain } from './registrable.mjs';

const APPLYTOJOB_DOMAIN = 'applytojob.com';
const ALTAMIRAWEB_DOMAIN = 'altamiraweb.com';

/** @param {string} rawUrl @param {string} domain */
function isTenantOnPlatform(rawUrl, domain) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    return registrableDomain(host) === domain && host !== domain;
  } catch {
    return false;
  }
}

/** @param {string} value */
function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

/**
 * Applytojob exposes vacancies as same-origin `/apply/<opaque-id>/<slug>`
 * anchors. Its listing page has no structured listing block, so the generic
 * extractor sees only navigation and returns zero rows.
 *
 * @param {string} html
 * @param {string} effectiveUrl
 * @returns {{ title: string, url: string, sourceUrl: string, urlExplicit: true, via: 'known-template' }[]}
 */
export function extractApplytojobListingCandidates(html, effectiveUrl) {
  if (!isTenantOnPlatform(effectiveUrl, APPLYTOJOB_DOMAIN)) return [];
  const out = [];
  const seen = new Set();
  for (const link of extractLinks(html, effectiveUrl)) {
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (url.origin !== new URL(effectiveUrl).origin) continue;
    const match = /^\/apply\/([A-Za-z0-9_-]{6,64})\/([^/?#]+)\/?$/i.exec(url.pathname);
    const title = cleanTitle(link.text);
    if (!match || !title || title.length <= 3) continue;
    url.hash = '';
    url.search = '';
    const canonical = url.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({
      title,
      url: canonical,
      sourceUrl: canonical,
      urlExplicit: true,
      via: 'known-template',
    });
  }
  return out;
}

/**
 * Altamira's public boards expose either a constant pathname with `JobID` in
 * the query or a slug ending in a numeric id. The generic path-template
 * detector deliberately ignores query-only variation, so both public shapes
 * need a reviewed selector.
 *
 * @param {string} html
 * @param {string} effectiveUrl
 * @returns {{ title: string, url: string, sourceUrl: string, urlExplicit: true, via: 'known-template' }[]}
 */
export function extractAltamirawebListingCandidates(html, effectiveUrl) {
  if (!isTenantOnPlatform(effectiveUrl, ALTAMIRAWEB_DOMAIN)) return [];
  const out = [];
  const seen = new Set();
  for (const link of extractLinks(html, effectiveUrl)) {
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (url.origin !== new URL(effectiveUrl).origin) continue;
    const queryJobId = /^\/annunci-lavoro\/job-details\/?$/i.test(url.pathname)
      ? url.searchParams.get('JobID') || ''
      : '';
    const pathJobId = /^\/annunci-lavoro\/[^/?#]+-(\d{4,20})\.htm\/?$/i.exec(url.pathname)?.[1] || '';
    const jobId = queryJobId || pathJobId;
    const title = cleanTitle(link.text);
    if (!/^\d{4,20}$/.test(jobId) || !title || title.length <= 3) continue;
    if (queryJobId) {
      url.search = '';
      url.searchParams.set('JobID', jobId);
    }
    url.hash = '';
    const canonical = url.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({
      title,
      url: canonical,
      sourceUrl: canonical,
      urlExplicit: true,
      via: 'known-template',
    });
  }
  return out;
}

export const PLATFORM_FAMILY_ADAPTERS = Object.freeze({
  [APPLYTOJOB_DOMAIN]: Object.freeze({
    version: 'applytojob-family-v1',
    detailTemplate: '/apply/*/*',
    listingExtractor: extractApplytojobListingCandidates,
  }),
  [ALTAMIRAWEB_DOMAIN]: Object.freeze({
    version: 'altamiraweb-family-v1',
    detailTemplate: '/annunci-lavoro/*',
    listingExtractor: extractAltamirawebListingCandidates,
  }),
});

/** @param {unknown} platform @returns {any|null} */
export function platformFamilyAdapterFor(platform) {
  return PLATFORM_FAMILY_ADAPTERS[registrableDomain(String(platform || '').trim())] || null;
}

/** @param {unknown} platform @returns {((html: string, effectiveUrl: string) => any[])|null} */
export function platformListingExtractorFor(platform) {
  return platformFamilyAdapterFor(platform)?.listingExtractor || null;
}

/** @param {unknown} platform @returns {string|null} */
export function platformFamilyVersionFor(platform) {
  return platformFamilyAdapterFor(platform)?.version || null;
}

/** @param {unknown} platform @returns {string|null} */
export function platformFamilyDetailTemplateFor(platform) {
  return platformFamilyAdapterFor(platform)?.detailTemplate || null;
}

export const PLATFORM_FAMILY_DOMAINS = Object.freeze(Object.keys(PLATFORM_FAMILY_ADAPTERS));
