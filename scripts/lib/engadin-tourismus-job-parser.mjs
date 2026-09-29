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

function createDocument(html = '') {
  const sanitized = String(html || '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  return new JSDOM(sanitized).window.document;
}

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
  const document = createDocument(html);
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Find "Mehr lesen" links to job detail pages
  const moreLinks = document.querySelectorAll('a.more[href*="ueber-uns/jobs/jobs/"]');
  for (const link of moreLinks) {
    const title = (link.getAttribute('title') || '').trim();
    let href = link.getAttribute('href') || '';
    // Detail pages are canonical without any query string (verified via
    // <link rel="canonical">); the site's TYPO3 cache has been observed
    // appending stray/malformed query params (e.g. `print=1'a'a=0&cHash=...`)
    // onto these links, so drop the query string entirely instead of trying
    // to surgically strip known params — a partial strip can leave garbage
    // glued onto the slug and produce a 404 (#3421).
    href = href.split('?')[0];
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
      // See Strategy 1 above: drop the entire query string rather than
      // surgically stripping known params (#3421).
      href = href.split('?')[0];

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
 * Parse a job detail page for the vacancy text.
 *
 * Issue 5253: the old selector list ended in `article`/`main`/`#content` and a
 * "largest block of the page" fallback. None of the job-scoped containers
 * exists on the current TYPO3 news template, so every job published the whole
 * page navigation ("• Über uns | • Jobs • Strategie & Auftrag …", 2/2 jobs).
 * The vacancy lives in the news record: `.news-single .article`, whose second
 * grid row is the body (the first row is the H2 title and the date). Only
 * job-scoped containers are read; a page without one yields '' and the job is
 * not published instead of carrying navigation text. The application
 * paragraph with the recruiter's e-mail and phone is dropped: it is contact
 * chrome, not the role.
 */
const VACANCY_BODY_SELECTORS = [
  '.news-single .article .space-element-b-large',
  '.news-single .news-text-wrap',
  '.frame-type-text .ce-bodytext',
  '.ce-bodytext',
];

function parseDetailPage(html = '') {
  if (!html) return '';

  const document = createDocument(html);
  for (const sel of VACANCY_BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    for (const paragraph of el.querySelectorAll('p')) {
      if (paragraph.querySelector('a[href^="mailto:"], a[href^="tel:"], a[href*="UnCryptMailto"]')) paragraph.remove();
    }
    const body = stripHtml(el.innerHTML || '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body) return body;
  }
  return '';
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/multimedia|video|foto|media|content|kommunikation/i.test(t)) return 'marketing';
  if (/kauffrau|kaufmann|commercial|administration/i.test(t)) return 'admin';
  if (/\b(lehr|ausbildung|apprent|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ]))/i.test(t)) return 'apprenticeship';
  if (/tourismus|tourism|reise|hotel|gastro/i.test(t)) return 'tourism';
  if (/it\b|developer|software|engineer|data/i.test(t)) return 'technology';
  if (/marketing|sales|vertrieb/i.test(t)) return 'sales';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/\b(lehr|ausbildung|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|junior|entry|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprent|praktik)/i.test(title)) return 'ENTRY';
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

    // Language of the published body, not of the title (issue 5253): titles
    // are loanword soup ("Candidatura spontanea", "Junior Logistics
    // Specialist", "Guest Experience Specialist") and filed the body under a
    // foreign source slot. The title is only the fallback when no body exists.
    // Source text only (issue 5253): without a vacancy body of at least 50
    // words the job is left out of this run — the standard pipeline retains
    // the stored record — instead of being published with navigation text.
    if (description.split(/\s+/).filter(Boolean).length < 50) {
      console.warn(`  ⏭️ ${listing.title}: no vacancy text on the detail page — not published this run`);
      continue;
    }

    const sourceLang = detectLang(description || listing.title, 'de');
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

export const __internals = {
  createDocument,
  parseListingPage,
  parseDetailPage,
};
