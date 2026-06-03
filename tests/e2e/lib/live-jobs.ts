import type { Page } from 'playwright/test';

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

// Last-resort fallbacks if the live sitemap is unreachable. These may still
// expire — the sitemap is the durable source. Kept minimal.
const FALLBACK_JOB_DETAILS: ReadonlyArray<string> = [
  '/cerca-lavoro-ticino/meccanico-a-di-produzione-afc-bellinzona-ffs-officine-ferrovie-federali-bellinzona/',
];

// A job-detail path is a single slug segment under the canton job root. Hubs
// (azienda-/ricerca-/search-/settori/pagina-) share that shape but are not
// listings — exclude them.
const JOB_DETAIL_PATH_RE = /^\/cerca-lavoro-ticino\/[^/]+\/$/;
const NON_DETAIL_PREFIX_RE = /\/(azienda-|settori|ricerca-|search-|pagina-)/;

async function listSitemapJobDetailPaths(page: Page): Promise<string[]> {
  const res = await page.request
    .get(`${LIVE_BASE_URL}/sitemap-jobs-ticino.xml`, { timeout: 15_000 })
    .catch(() => null);
  if (!res || !res.ok()) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].replace(LIVE_BASE_URL, ''))
    .filter((p) => JOB_DETAIL_PATH_RE.test(p) && !NON_DETAIL_PREFIX_RE.test(p));
}

/**
 * Returns job-detail paths that respond 200 and emit a `<main>` element in
 * their static HTML (i.e. active listings, not expired soft-landings).
 *
 * @param opts.limit max paths to return (caps how many URLs are probed).
 * @param opts.requireCompanyLink also require a `/cerca-lavoro-ticino/azienda-`
 *   link in the static HTML. Note: HTML presence does not guarantee the link
 *   is *visible* after hydration — callers that click it must still gate on
 *   `isVisible()` at runtime (some layouts hide the company link).
 */
export async function listActiveJobDetailPaths(
  page: Page,
  opts: { limit?: number; requireCompanyLink?: boolean } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 8;
  const candidates = [...(await listSitemapJobDetailPaths(page)), ...FALLBACK_JOB_DETAILS];
  const active: string[] = [];
  // Cap probes — the sitemap has thousands of URLs; we only need the first
  // few active ones and must not turn discovery into a slow crawl.
  for (const path of candidates.slice(0, 40)) {
    if (active.length >= limit) break;
    const res = await page.request
      .get(`${LIVE_BASE_URL}${path}`, { maxRedirects: 5, timeout: 15_000 })
      .catch(() => null);
    if (!res || res.status() !== 200) continue;
    const html = await res.text();
    // Expired soft-landings wrap content in <article class="ft-static-article">
    // and never hydrate a <main>. Skip them.
    if (!/<main[\s>]/i.test(html)) continue;
    if (opts.requireCompanyLink && !/\/cerca-lavoro-ticino\/azienda-/.test(html)) continue;
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
      'No active live job-detail URL found (sitemap-jobs-ticino.xml + pinned fallbacks all stale/expired/unreachable).',
    );
  }
  return path;
}
