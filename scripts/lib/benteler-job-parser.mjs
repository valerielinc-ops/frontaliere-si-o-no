#!/usr/bin/env node
/**
 * Benteler job parser — Fetcher and job builder.
 *
 * Source: https://career.benteler.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBentelerJobs()  — Fetch and parse all jobs
 *   - isBentelerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BENTELER_KEY = 'benteler';
export const BENTELER_COMPANY_NAME = 'Benteler';
export const BENTELER_COMPANY_DOMAIN = 'benteler.com';

const CAREER_URL = 'https://career.benteler.com/';
const HQ = getCompanyDefaults('benteler');

/**
 * Benteler uses SAP SuccessFactors. Their career site typically serves
 * job data via a JSON API or embeds it in the HTML as a script block.
 * We try to discover the SuccessFactors API endpoint and fall back to
 * HTML scraping.
 */
const SF_API_URLS = [
  'https://career.benteler.com/api/jobs?country=CH&limit=50',
  'https://career.benteler.com/api/v1/jobs?location=Switzerland&limit=50',
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Benteler.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBentelerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BENTELER_KEY ||
    key.startsWith('benteler') ||
    company.includes('benteler') ||
    url.includes('benteler.com')
  );
}

/**
 * Validate that a URL belongs to Benteler's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'benteler.com' || host.endsWith('.benteler.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Try SuccessFactors-style API endpoints to fetch job listings.
 */
async function trySuccessFactorsApi() {
  for (const apiUrl of SF_API_URLS) {
    try {
      console.log(`   Trying SuccessFactors API: ${apiUrl}`);
      const data = await fetchJson(apiUrl, { timeoutMs: 15000 });
      const items = data?.jobs || data?.results || data?.d?.results || data?.requisitions || (Array.isArray(data) ? data : []);
      if (items.length > 0) {
        console.log(`   API returned ${items.length} jobs`);
        return items;
      }
    } catch (err) {
      console.log(`   API attempt failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Parse the Benteler career page HTML for job listings.
 * SuccessFactors sites often render server-side or embed JSON data.
 */
function parseCareerPageHtml(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Look for embedded JSON in script tags
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    // SuccessFactors often uses __NEXT_DATA__ or embedded requisition data
    const jsonMatch = text.match(/"(?:jobs|requisitions|postings)"\s*:\s*(\[[\s\S]*?\])/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* not valid JSON */ }
    }
  }

  // Scrape job links from HTML
  const JOB_SELECTORS = [
    'a[href*="job"], a[href*="/go/"], a[href*="requisition"]',
    '.job-listing a, .job-card a, .vacancy a',
    '.career-listing a, .position-card a',
    'h2 a, h3 a',
  ];

  for (const selector of JOB_SELECTORS) {
    try {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');

        if (!title || title.length < 5) continue;
        if (seen.has(title.toLowerCase())) continue;
        if (/login|register|contact|about|impressum|datenschutz/i.test(href)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `https://career.benteler.com${href.startsWith('/') ? '' : '/'}${href}`;

        // Check if this looks like a Swiss job
        const parent = link.closest('li, tr, div, article') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const isSwiss = /schweiz|switzerland|suisse|svizzera|manno|ticino|tessin|lugano|ch\b/i.test(parentText);

        jobs.push({
          title,
          url: fullUrl,
          location: isSwiss ? 'Manno' : '',
          description: '',
          isSwiss,
        });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Check if a location string indicates a Swiss target location. Uses the
 * canonical BFS-based check so every canton/municipality is recognized.
 */
function isSwissLocation(location = '') {
  const loc = String(location || '');
  if (!loc) return false;
  if (/\b(schweiz|switzerland|suisse|svizzera|ch)\b/i.test(loc)) return true;
  return isTargetSwissLocation(loc);
}

/**
 * Fetch all Benteler jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try SuccessFactors API endpoints
 *  2. Fall back to HTML scraping
 *  3. Filter for Swiss locations (Benteler is global, we only want CH jobs)
 */
export async function fetchAllBentelerJobs() {
  console.log(`🔍 Fetching Benteler jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: Try API
  let listings = await trySuccessFactorsApi();

  // Strategy 2: Fall back to HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   SuccessFactors API did not return jobs, trying HTML scraping...');
    try {
      const html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
      listings = parseCareerPageHtml(html);
      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Benteler job listings found.');
    return [];
  }

  // Filter for Swiss locations only
  const swissListings = listings.filter((l) => {
    const loc = l.location || l.city || l.country || '';
    return l.isSwiss || isSwissLocation(loc) || !loc; // Include if no location (might be Swiss)
  });

  console.log(`  📋 Total listings: ${listings.length}, Swiss-filtered: ${swissListings.length}`);

  const jobs = [];
  for (const listing of swissListings) {
    const title = normalizeSpace(listing.title || listing.name || listing.jobTitle || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.city || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Manno';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const descriptionHtml = listing.description || listing.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.link || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} benteler ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Stelle bei Benteler in ${location}, Schweiz. Benteler ist ein globaler Automobil- und Stahlzulieferer mit einem Standort in Manno (Tessin).`;

    const job = {
      id: `benteler-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BENTELER_COMPANY_NAME,
      companyKey: BENTELER_KEY,
      companyDomain: BENTELER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Benteler Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6928',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Automotive / Industria siderurgica',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || listing.datePosted || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Benteler jobs discovered: ${jobs.length}`);
  return jobs;
}
