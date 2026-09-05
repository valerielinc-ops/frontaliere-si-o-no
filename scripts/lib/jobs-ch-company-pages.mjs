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
 * Live control 2026-09-05: `city-pop-ag` → `Jobs (1)`, 1 link;
 * `strabag-ag` → `Jobs (22)`, 12 links on page 1 (the counter is the whole
 * board, the links are one page — which is why only `0` is ever read as proof);
 * both GIM profiles → `Jobs (0)`, 0 links.
 *
 * @param {string} html
 * @returns {number|null} the count, or null when the tab did not render
 */
export function parseVacancyCountTab(html = '') {
  // locale-segment-ok: '/en/' is jobs.ch's own site-language path, not a site locale route
  const m = /href="\/en\/companies\/[^"]*\/vacancies\/"[^>]*>\s*Jobs\s*\((\d+)\)\s*</i.exec(String(html || ''));
  return m ? Number(m[1]) : null;
}

/** @param {{ label: string, identity?: string }} target */
function identityMarkerFor(target) {
  return target.identity || String(target.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
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
    let html = '';
    try {
      html = await fetchPage(companyPageUrl);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${target.label} company page: ${err?.message || err}`);
      everyProfileProvenEmpty = false;
      continue;
    }
    const links = parseVacancyLinks(html);
    console.log(`  📋 ${target.label}: ${links.length} open vacancy link(s)`);
    for (const link of links) vacancyUrls.add(link);

    const renderedCount = parseVacancyCountTab(html);
    // A 200 does not prove the page is the page we asked for — a WAF shell or a
    // CDN catch-all answers 200 with HTML too. The employer's own name has to
    // be on it before its counter says anything about this employer.
    const identity = identityMarkerFor(target);
    const isOwnProfile = Boolean(identity) && html.includes(identity);
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
