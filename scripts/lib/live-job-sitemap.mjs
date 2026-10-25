/**
 * Boundary for live job discovery: a URL-set sitemap's canonical `<loc>`
 * entries are the probe candidates; hreflang alternates are metadata for
 * their page, not additional jobs to request.
 *
 * Keep this selection outside the generic sitemap crawler so every live-gate
 * caller makes the same primary-vs-alternate choice without changing the
 * crawler's union used by IndexNow and snapshot consumers.
 */
import { parseSitemapXml } from './sitemap-crawl.mjs';

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

// A job-detail path is a single slug segment under any locale's canton-aware
// job root. Hubs share that shape but are not listings — exclude them below.
export const JOB_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/[^/]+\/$/i;
const NON_DETAIL_PREFIX_RE = /\/(?:azienda-|company-|unternehmen-|entreprise-|settori|categoria-|category-|kategorie-|categorie-|ricerca-|recherche-|search-|suche-|pagina-|page-|seite-)/i;

function livePathFromUrl(value, baseUrl = LIVE_BASE_URL) {
  let parsed;
  let base;
  try {
    parsed = new URL(value, `${baseUrl}/`);
    base = new URL(`${baseUrl}/`);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  return parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
}

/**
 * Extract canonical active-job candidates from a URL-set sitemap.
 *
 * `urls` intentionally remains a primary-plus-hreflang union for the generic
 * crawler. This live-gate consumer must select `primaryUrls`, otherwise every
 * localized alternate becomes another HTTP probe and can be mistaken for a
 * second job.
 */
export function extractJobDetailPathsFromSitemapXml(xml, baseUrl = LIVE_BASE_URL) {
  let parsed;
  try {
    const host = new URL(`${baseUrl}/`).hostname;
    parsed = parseSitemapXml(xml, { baseUrl, host });
  } catch {
    return [];
  }

  const paths = [];
  const seen = new Set();
  for (const url of parsed.primaryUrls) {
    const path = livePathFromUrl(url, baseUrl);
    if (!path || !JOB_DETAIL_PATH_RE.test(path) || NON_DETAIL_PREFIX_RE.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
