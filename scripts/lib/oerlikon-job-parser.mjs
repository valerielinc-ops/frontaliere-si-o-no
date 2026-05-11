#!/usr/bin/env node
/**
 * Oerlikon job parser — Fetcher and job builder.
 *
 * Source: https://careers.oerlikon.com/search/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOerlikonJobs()  — Fetch and parse all jobs
 *   - isOerlikonJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OERLIKON_KEY = 'oerlikon';
export const OERLIKON_COMPANY_NAME = 'Oerlikon';
export const OERLIKON_COMPANY_DOMAIN = 'oerlikon.com';

const CAREER_URL = 'https://careers.oerlikon.com/search/';
const HQ = getCompanyDefaults('oerlikon');

/**
 * Oerlikon uses SAP SuccessFactors Career Site Builder (CSB).
 * The CSB sites typically expose a search API. Common patterns:
 *   - POST /career?_s.crb=...  (with JSON body for search)
 *   - GET  /api/apply/v2/jobs?location=...
 * We try the SuccessFactors API and fall back to HTML scraping.
 */
const SF_SEARCH_URL = 'https://careers.oerlikon.com/api/apply/v2/jobs';
const SF_SEARCH_PARAMS = {
  domain: 'oerlikon.com',
  start: 0,
  num: 50,
  location: 'Switzerland',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Oerlikon.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOerlikonJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OERLIKON_KEY ||
    key.startsWith('oerlikon') ||
    company.includes('oerlikon') ||
    url.includes('oerlikon.com')
  );
}

/**
 * Validate that a URL belongs to Oerlikon's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'oerlikon.com' || host.endsWith('.oerlikon.com');
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
 * Try the SuccessFactors Career Site Builder search API.
 * CSB sites typically expose a REST endpoint for job search.
 */
async function trySuccessFactorsSearch() {
  const params = new URLSearchParams(SF_SEARCH_PARAMS);
  const apiUrl = `${SF_SEARCH_URL}?${params}`;
  try {
    console.log(`   Trying SuccessFactors API: ${apiUrl}`);
    const data = await fetchJson(apiUrl, { timeoutMs: 20000 });
    const items = data?.positions || data?.jobs || data?.results || data?.requisitionList || (Array.isArray(data) ? data : []);
    if (items.length > 0) {
      console.log(`   API returned ${items.length} jobs`);
      return items;
    }
  } catch (err) {
    console.log(`   API attempt failed: ${err.message}`);
  }
  return null;
}

/**
 * Parse the Oerlikon career search page HTML.
 * SuccessFactors CSB sites render job cards with links.
 */
function parseSearchPageHtml(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Look for embedded JSON data
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    // CSB often uses __NEXT_DATA__ or window.__DATA__
    const dataMatch = text.match(/"(?:positions|jobs|requisitions)"\s*:\s*(\[[\s\S]*?\])/i);
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* not valid JSON */ }
    }
  }

  // Scrape job links from rendered HTML
  const JOB_SELECTORS = [
    'a[href*="job"], a[href*="requisition"], a[href*="position"]',
    '.job-listing a, .job-card a, .search-result a',
    '.results a, .position a',
    'h2 a, h3 a, h4 a',
  ];

  for (const selector of JOB_SELECTORS) {
    try {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');

        if (!title || title.length < 5) continue;
        if (seen.has(title.toLowerCase())) continue;
        if (/login|privacy|cookie|about|imprint/i.test(href)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `https://careers.oerlikon.com${href.startsWith('/') ? '' : '/'}${href}`;

        // Check for location in surrounding text
        const parent = link.closest('li, tr, div, article') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const locMatch = parentText.match(/(?:balzers|trübbach|pfäffikon|zürich|liechtenstein|switzerland|schweiz)/i);
        const location = locMatch ? locMatch[0] : '';

        jobs.push({
          title,
          url: fullUrl,
          location,
          description: '',
        });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Check if a location is near the GR border or Swiss.
 */
function isRelevantLocation(location = '') {
  const loc = location.toLowerCase();
  return /balzers|trübbach|truebbach|pfäffikon|pfaffikon|schweiz|switzerland|suisse|svizzera|liechtenstein|ch\b|zürich|zurich|bern|basel/i.test(loc) || !loc;
}

/**
 * Fetch all Oerlikon jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try SuccessFactors search API
 *  2. Fall back to HTML scraping of the career search page
 *  3. Filter for Swiss/Liechtenstein locations (near GR border)
 */
export async function fetchAllOerlikonJobs() {
  console.log(`🔍 Fetching Oerlikon jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: Try API
  let listings = await trySuccessFactorsSearch();

  // Strategy 2: Fall back to HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   SuccessFactors API did not return jobs, trying HTML scraping...');
    try {
      const html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
      listings = parseSearchPageHtml(html);
      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Oerlikon job listings found.');
    return [];
  }

  // Filter for relevant locations
  const relevantListings = listings.filter((l) => {
    const loc = l.location || l.city || l.country || '';
    return isRelevantLocation(loc);
  });

  console.log(`  📋 Total listings: ${listings.length}, Relevant: ${relevantListings.length}`);

  const jobs = [];
  for (const listing of relevantListings) {
    const title = normalizeSpace(listing.title || listing.name || listing.jobTitle || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.city || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Balzers';
    const canton = inferAnyCanton(location) || HQ?.canton || 'GR';
    const descriptionHtml = listing.description || listing.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.link || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} oerlikon ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Oerlikon in ${location}. OC Oerlikon is a global technology group specializing in surface solutions, polymer processing, and additive manufacturing.`;

    const job = {
      id: `oerlikon-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OERLIKON_COMPANY_NAME,
      companyKey: OERLIKON_KEY,
      companyDomain: OERLIKON_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Oerlikon Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '9496',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Tecnologia / Ingegneria di superficie',
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

  console.log(`\n📋 Total Oerlikon jobs discovered: ${jobs.length}`);
  return jobs;
}
