/**
 * Engadin Tourismus AG — Job listing parser
 *
 * Career page: https://www.engadintourismus.ch/unternehmen/jobs
 *   (redirects from engadin.ch/en/jobs)
 *
 * TYPO3-based CMS. Job listings use "Mehr lesen" links to detail pages.
 * Detail pages at /ueber-uns/jobs/jobs/{slug}
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.engadintourismus.ch';
const CAREERS_URL = 'https://www.engadintourismus.ch/unternehmen/jobs';
const HQ = getCompanyDefaults('engadin-tourismus');

export const ENGADIN_TOURISMUS_KEY = 'engadin-tourismus';
export const ENGADIN_TOURISMUS_COMPANY_NAME = 'Engadin Tourismus AG';
export const ENGADIN_TOURISMUS_COMPANY_DOMAIN = 'engadintourismus.ch';

export const MIN_DESC_LENGTH = 100;

/* ── Job identification ───────────────────────────────────── */

export function isEngadinTourismusJob(job = {}) {
  const key = String(job?.companyKey || '').trim().toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === ENGADIN_TOURISMUS_KEY ||
    company.includes('engadin tourismus') ||
    url.includes('engadintourismus.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.includes('engadintourismus.ch') || host.includes('engadin.ch');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Engadin Tourismus jobs listing page.
 * Returns an array of { title, url } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Find "Mehr lesen" links to job detail pages
  const moreLinks = document.querySelectorAll('a.more[href*="ueber-uns/jobs/jobs/"]');
  for (const link of moreLinks) {
    const title = (link.getAttribute('title') || '').trim();
    let href = link.getAttribute('href') || '';
    href = href.replace(/[?&]print=1/, '').replace(/[?&]cHash=[^&]*/, '').replace(/[?&]$/, '');
    if (!href || !title) continue;

    const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push({ title, url });
  }

  // Strategy 2: Fallback — look for any job links
  if (jobs.length === 0) {
    const links = document.querySelectorAll('a[href*="/jobs/"]');
    for (const link of links) {
      let href = link.getAttribute('href') || '';
      if (!href.includes('ueber-uns/jobs/jobs/')) continue;
      href = href.replace(/[?&]print=1/, '').replace(/[?&]cHash=[^&]*/, '').replace(/[?&]$/, '');

      const title = normalizeSpace(link.textContent || '');
      if (!title || title.length < 5 || /mehr lesen/i.test(title)) continue;

      const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({ title, url });
    }
  }

  return jobs;
}

/**
 * Parse a job detail page for full description.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  const BODY_SELECTORS = [
    '.frame-type-text',
    '.ce-bodytext',
    'article',
    '.content-main',
    '#content',
    'main',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const candidate = stripHtml(el.innerHTML || '');
      if (candidate.length > body.length) body = candidate;
    }
    if (body.length >= MIN_DESC_LENGTH) break;
  }

  if (body.length < MIN_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripHtml(best.innerHTML || '');
    }
  }

  return body;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/multimedia|video|foto|media|content|kommunikation/i.test(t)) return 'marketing';
  if (/kauffrau|kaufmann|commercial|administration/i.test(t)) return 'admin';
  if (/lehr|ausbildung|apprent|stage/i.test(t)) return 'apprenticeship';
  if (/tourismus|tourism|reise|hotel|gastro/i.test(t)) return 'tourism';
  if (/it\b|developer|software|engineer|data/i.test(t)) return 'technology';
  if (/marketing|sales|vertrieb/i.test(t)) return 'sales';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|praktik/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Engadin Tourismus jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllEngadinTourismusJobs() {
  console.log(`  Fetching Engadin Tourismus jobs from ${CAREERS_URL}`);

  const html = await fetchHtml(CAREERS_URL, { timeoutMs: 25000 });
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url);
        description = parseDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    const sourceLang = detectLang(listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} St. Moritz`, 'engadin-tourismus');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, description);

    jobs.push({
      id: `${ENGADIN_TOURISMUS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ENGADIN_TOURISMUS_COMPANY_NAME,
      companyKey: ENGADIN_TOURISMUS_KEY,
      companyDomain: ENGADIN_TOURISMUS_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'St. Moritz',
      canton: HQ.canton,
      addressLocality: 'St. Moritz',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Turismo',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Engadin Tourismus Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Engadin Tourismus jobs discovered: ${jobs.length}`);
  return jobs;
}
