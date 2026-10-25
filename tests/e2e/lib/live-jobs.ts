import type { Page } from 'playwright/test';
import { parseSitemapXml } from '../../../scripts/lib/sitemap-crawl.mjs';

/**
 * Runtime discovery of currently-active job-detail URLs on the deployed site.
 *
 * Why this exists: live e2e specs used to pin specific job slugs (e.g.
 * `…/senior-manager-reporting…-tether-operations-lugano/`). Job listings
 * expire on a rolling window. An expired job does NOT 404 — it serves a
 * soft-landing page (HTTP 200, SPA bundle present) whose content is wrapped
 * in `<article class="ft-static-article">` with **no `<main>` element**. So
 * specs that `await page.locator('main').waitFor({ state: 'attached' })`
 * silently time-bombed: green until the pinned slug crossed its expiry, then
 * a 30 s timeout with no code change — purely a calendar boundary
 * (incident 2026-06-03, validate-live run 26866011528).
 *
 * Fix: discover the job-detail URL at test time from the live jobs sitemap
 * (which lists only active listings — expired ones are pruned), verifying the
 * static HTML actually carries a `<main>` before committing. Pinned slugs
 * remain only as a last-resort fallback if the sitemap is unreachable.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

// `sitemap-jobs.xml` is the canonical owner of active IT job-detail URLs.
// `sitemap-jobs-ticino.xml` was the old shard name; keep it as a compatibility
// source while older deploys can still be the live site during propagation.
const JOB_SITEMAP_PATHS: readonly string[] = [
  '/sitemap-jobs.xml',
  '/sitemap-jobs-ticino.xml',
];
const MAX_SITEMAP_CANDIDATES = 40;

// Last-resort fallbacks if the live sitemap is unreachable. These may still
// expire — the sitemap is the durable source. Kept minimal.
const FALLBACK_JOB_DETAILS: ReadonlyArray<string> = [
  '/cerca-lavoro-ticino/meccanico-a-di-produzione-afc-bellinzona-ffs-officine-ferrovie-federali-bellinzona/',
];

// A job-detail path is a single slug segment under any locale's canton-aware
// job root. The live sitemap can contain a non-Ticino canton even when the TI
// section has no active listing; restricting this to the legacy TI root made
// every live smoke test fail with "no active job" in that perfectly valid
// state. Hubs (azienda-/ricerca-/search-/settori/pagina-) share that shape but
// are not listings — exclude them below.
export const JOB_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/[^/]+\/$/i;
const NON_DETAIL_PREFIX_RE = /\/(?:azienda-|company-|unternehmen-|entreprise-|settori|categoria-|category-|kategorie-|categorie-|ricerca-|recherche-|search-|suche-|pagina-|page-|seite-)/i;

// Company links are emitted under the same canton-aware section as their
// source job and use the locale-specific company namespace.
export const COMPANY_HUB_HREF_RE = /\/(?:azienda|company|unternehmen|entreprise)-/i;
export const COMPANY_HUB_LINK_SELECTOR = 'main a[href*="/azienda-"], main a[href*="/company-"], main a[href*="/unternehmen-"], main a[href*="/entreprise-"]';

function livePathFromUrl(value: string, baseUrl = LIVE_BASE_URL): string | null {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(value, `${baseUrl}/`);
    base = new URL(`${baseUrl}/`);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return path;
}

/**
 * Extract active canton-aware job-detail paths from one job sitemap.
 *
 * The sitemap topology changed from the TI-specific file to the canonical
 * `sitemap-jobs.xml`; parsing the URL set instead of matching one filename
 * keeps the live test aligned with both generations and with hreflang links.
 */
export function extractJobDetailPathsFromSitemapXml(
  xml: string,
  baseUrl = LIVE_BASE_URL,
): string[] {
  let parsed;
  try {
    const host = new URL(`${baseUrl}/`).hostname;
    parsed = parseSitemapXml(xml, { baseUrl, host });
  } catch {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const url of parsed.primaryUrls) {
    const path = livePathFromUrl(url, baseUrl);
    if (!path || !JOB_DETAIL_PATH_RE.test(path) || NON_DETAIL_PREFIX_RE.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

async function fetchJobSitemap(page: Page, path: string): Promise<string | null> {
  const response = await page.request
    .get(`${LIVE_BASE_URL}${path}`, { timeout: 15_000 })
    .catch(() => null);
  if (!response || !response.ok()) return null;
  return response.text();
}

async function listSitemapJobDetailPaths(page: Page): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const sitemapPath of JOB_SITEMAP_PATHS) {
    const xml = await fetchJobSitemap(page, sitemapPath);
    if (!xml) continue;
    for (const path of extractJobDetailPathsFromSitemapXml(xml)) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Returns job-detail paths that respond 200 and emit a `<main>` element in
 * their static HTML (i.e. active listings, not expired soft-landings).
 *
 * @param opts.limit max paths to return (caps how many URLs are probed).
 * @param opts.requireCompanyLink also require a locale/canton-aware company
 *   link in the static HTML. Note: HTML presence does not guarantee the link
 *   is *visible* after hydration — callers that click it must still gate on
 *   `isVisible()` at runtime (some layouts hide the company link).
 */
export async function listActiveJobDetailPaths(
  page: Page,
  opts: { limit?: number; requireCompanyLink?: boolean } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 8;
  // Keep the probe bounded while reserving a slot for every pinned fallback.
  // Otherwise 40 stale sitemap entries would prevent the fallback from being
  // tried at all, even though it is explicitly the last-resort source.
  const sitemapCandidates = await listSitemapJobDetailPaths(page);
  const candidates = [
    ...new Set([
      ...sitemapCandidates.slice(0, MAX_SITEMAP_CANDIDATES),
      ...FALLBACK_JOB_DETAILS,
    ]),
  ];
  const active: string[] = [];
  // Cap probes — the sitemap has thousands of URLs; we only need the first
  // few active ones and must not turn discovery into a slow crawl.
  for (const path of candidates) {
    if (active.length >= limit) break;
    const res = await page.request
      .get(`${LIVE_BASE_URL}${path}`, { maxRedirects: 5, timeout: 15_000 })
      .catch(() => null);
    if (!res || res.status() !== 200) continue;
    const html = await res.text();
    // Expired soft-landings wrap content in <article class="ft-static-article">
    // and never hydrate a <main>. Skip them.
    if (!/<main[\s>]/i.test(html)) continue;
    if (opts.requireCompanyLink && !COMPANY_HUB_HREF_RE.test(html)) continue;
    active.push(path);
  }
  return active;
}

/**
 * Resolves a single active job-detail path (200 + `<main>` in static HTML).
 * Throws if none can be found.
 */
export async function resolveActiveJobDetailPath(page: Page): Promise<string> {
  const [path] = await listActiveJobDetailPaths(page, { limit: 1 });
  if (!path) {
    throw new Error(
      'No active live job-detail URL found (canton-aware job sitemaps + pinned fallbacks all stale/expired/unreachable).',
    );
  }
  return path;
}
