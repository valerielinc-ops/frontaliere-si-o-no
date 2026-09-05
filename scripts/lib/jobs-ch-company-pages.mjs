#!/usr/bin/env node
/**
 * Shared reader for a jobs.ch company profile.
 *
 * Four dedicated crawlers (gim-architekten, saint-gobain-weber-isover, strabag,
 * visionapartments) scrape the same public jobs.ch surface and carried four
 * byte-identical copies of the same loop, including the same
 * `catch → console.warn → continue` that makes a failed fetch look exactly like
 * a company with no openings. That ambiguity is what keeps reopening
 * `[crawler-health] … crawler unhealthy` issues (#7458): the monitor cannot tell
 * "the source says zero" from "the run never reached the source".
 *
 * One copy, and the loop now reports which of the two it saw.
 */
import { fetchHtml } from './hospital-custom-html-helpers.mjs';

export const JOBS_CH_BASE_URL = 'https://www.jobs.ch';

/**
 * Open vacancy detail links rendered on a company profile.
 *
 * @param {string} html
 * @returns {string[]} absolute jobs.ch URLs
 */
export function parseVacancyLinks(html = '') {
  if (!html) return [];
  const urls = new Set();
  const re = /href="(\/en\/vacancies\/detail\/[a-f0-9-]+\/)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.add(`${JOBS_CH_BASE_URL}${m[1]}`);
  }
  return Array.from(urls);
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The company slug this page declares as its own, read from `rel="canonical"`.
 *
 * The canonical is used rather than the requested path because jobs.ch keeps
 * legacy numeric profile ids alive as redirects: `70650-gim-architekten-ag`
 * answers 200 but canonicalises to `d7896bfc-…-gim-architekten-ag`, so scoping
 * on the requested slug would never match and the proof would be dead on
 * arrival for every redirected profile.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function parseCanonicalCompanySlug(html = '') {
  const link = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(String(html || ''))
    || /<link\b[^>]*href=["'][^"']*["'][^>]*rel=["']canonical["'][^>]*>/i.exec(String(html || ''));
  if (!link) return null;
  const href = /href=["']([^"']+)["']/i.exec(link[0]);
  if (!href) return null;
  // locale-segment-ok: '/en/' is jobs.ch's own site-language path, not a site locale route
  const slug = /\/[a-z]{2}\/companies\/([^/"'?#]+)\//i.exec(href[1]);
  return slug ? slug[1] : null;
}

/**
 * The server-rendered vacancy counter on the profile's own tab:
 * `<a href="/en/companies/<slug>/vacancies/" …>Jobs (N)</a>`.
 *
 * Deliberately a *second, independent* reading of the same fact that
 * `parseVacancyLinks` extracts. If jobs.ch renames the detail-link shape while
 * the company still has openings, the links go to zero but the counter does
 * not — so an empty result stops being provable and the crawler stays visibly
 * unhealthy instead of silently retiring live vacancies.
 *
 * SCOPED TO THIS PAGE'S OWN COMPANY, and that is the whole point. A profile
 * page carries other employers' `/companies/<slug>/vacancies/` hrefs — measured
 * on both live GIM profiles 2026-09-05, each also links `867-jobcloud-ag` (the
 * "Join our team" footer). An unscoped regex takes the FIRST counter in the
 * document, so a foreign `Jobs (0)` would grant the proof and the run would
 * retire live vacancies (`retainMissingJobs: false`) exactly in the scenario
 * this second reading exists to catch.
 *
 * Live control 2026-09-05: `city-pop-ag` → `Jobs (1)`, 1 link;
 * `strabag-ag` → `Jobs (22)`, 12 links on page 1 (the counter is the whole
 * board, the links are one page — which is why only `0` is ever read as proof);
 * both GIM profiles → `Jobs (0)`, 0 links.
 *
 * @param {string} html
 * @returns {number|null} the count, or null when this page's own tab did not
 *   render (including: no canonical, so no company to scope to)
 */
export function parseVacancyCountTab(html = '') {
  const source = String(html || '');
  const slug = parseCanonicalCompanySlug(source);
  if (!slug) return null;
  // locale-segment-ok: '/en/' is jobs.ch's own site-language path, not a site locale route
  const re = new RegExp(
    `href="/[a-z]{2}/companies/${escapeRegExp(slug)}/vacancies/"[^>]*>\\s*Jobs\\s*\\((\\d+)\\)\\s*<`,
    'i',
  );
  const m = re.exec(source);
  return m ? Number(m[1]) : null;
}

/** @param {{ label: string, identity?: string }} target */
function identityMarkerFor(target) {
  return target.identity || String(target.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Case- and whitespace-insensitive containment: jobs.ch renders the employer
 * name from its own record, so casing and internal spacing follow the profile,
 * not our `COMPANY_TARGETS` label (`STRABAG AG` vs `Strabag AG`). An exact
 * `includes()` would refuse the proof on a page that plainly is the right one.
 */
function pageNamesEmployer(html, identity) {
  if (!identity) return false;
  const fold = (value) => String(value).toLowerCase().replace(/\s+/g, ' ');
  return fold(html).includes(fold(identity));
}

/**
 * Walk every jobs.ch profile of one employer and collect its open vacancies.
 *
 * @param {Array<{ path: string, label: string, identity?: string }>} targets
 * @param {{ fetchPage?: (url: string) => Promise<string>, pathSuffix?: string }} [options]
 *   `pathSuffix` is `'vacancies/'` for employers whose board is paginated and
 *   only lists openings on the dedicated sub-tab.
 * @returns {Promise<{ vacancyUrls: string[], provenEmpty: boolean, evidence: string }>}
 *   `provenEmpty` is true only when EVERY profile was fetched, was still this
 *   employer's own profile, rendered its counter, and that counter read zero.
 *   A swallowed fetch error, an unrecognised page or a non-zero counter all
 *   leave it false — i.e. "we did not observe an empty source", which the
 *   caller must translate into "keep the previous slice".
 */
export async function collectJobsChVacancyUrls(targets, { fetchPage = fetchHtml, pathSuffix = '' } = {}) {
  const vacancyUrls = new Set();
  const counters = [];
  let everyProfileProvenEmpty = true;

  for (const target of targets) {
    // locale-segment-ok: '/en/' is jobs.ch's own external site-language path, not a site locale route
    const companyPageUrl = `${JOBS_CH_BASE_URL}/en/companies/${target.path}/${pathSuffix}`;
    // A failed fetch is NOT swallowed. The four copies of this loop each did
    // `catch → warn → continue`, which is how "the runner could not reach
    // jobs.ch" became indistinguishable from "the employer has no openings".
    // Letting it propagate hands the error to the classifier
    // `runStandardCrawlerPipeline` already implements around `fetchJobs()`: a
    // connection-level failure or an exhausted anti-bot fence soft-exits and
    // keeps the previous slice, while a real HTTP status (404 gone, persistent
    // 503) surfaces as the break it is. It also removes the partial-batch
    // hazard — one profile answering while the other is unreachable can no
    // longer publish a batch that silently omits half the employer.
    const html = await fetchPage(companyPageUrl);
    const links = parseVacancyLinks(html);
    console.log(`  📋 ${target.label}: ${links.length} open vacancy link(s)`);
    for (const link of links) vacancyUrls.add(link);

    const renderedCount = parseVacancyCountTab(html);
    // A 200 does not prove the page is the page we asked for — a WAF shell or a
    // CDN catch-all answers 200 with HTML too. The employer's own name has to
    // be on it before its counter says anything about this employer.
    const isOwnProfile = pageNamesEmployer(html, identityMarkerFor(target));
    if (renderedCount === null || !isOwnProfile) {
      console.warn(
        `  ⚠️ ${target.label}: no rendered "Jobs (N)" counter on this employer's profile`
        + ` (counter=${renderedCount ?? 'absent'}, identity=${isOwnProfile})`,
      );
      everyProfileProvenEmpty = false;
      continue;
    }
    counters.push(`${target.path}=${renderedCount}`);
    if (renderedCount !== 0) everyProfileProvenEmpty = false;
  }

  return {
    vacancyUrls: [...vacancyUrls],
    provenEmpty: everyProfileProvenEmpty && vacancyUrls.size === 0,
    evidence: `jobs.ch company profiles render a zero vacancy counter (${counters.join(', ')})`,
  };
}
