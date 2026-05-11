#!/usr/bin/env node
/**
 * IKEA Svizzera job parser — Fetcher and job builder.
 *
 * Source: https://jobs.ikea.com/en/location/grancia-jobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllIkeaJobs()  — Fetch and parse all jobs
 *   - isIkeaJob()         — Match jobs belonging to this company
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

export const IKEA_KEY = 'ikea';
export const IKEA_COMPANY_NAME = 'IKEA Svizzera';
export const IKEA_COMPANY_DOMAIN = 'ikea.com';

const CAREER_URL = 'https://jobs.ikea.com/en/location/grancia-jobs';
const BASE_URL = 'https://jobs.ikea.com';
const HQ = getCompanyDefaults('ikea');

/**
 * IKEA uses iCIMS / TalentBrew. The career site renders job cards that
 * contain links and titles. We scrape the listing page HTML with JSDOM.
 * Alternative: IKEA may expose a JSON search API at /api/jobs.
 */
const SEARCH_API_URLS = [
  'https://jobs.ikea.com/api/jobs?location=grancia&limit=50',
  'https://jobs.ikea.com/api/jobs?location=switzerland&limit=50',
  'https://jobs.ikea.com/api/jobs?q=&location=Ticino&limit=50',
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
 * Check if a job belongs to IKEA Svizzera.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isIkeaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IKEA_KEY ||
    key.startsWith('ikea') ||
    company.includes('ikea svizzera') ||
    url.includes('ikea.com')
  );
}

/**
 * Validate that a URL belongs to IKEA Svizzera's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ikea.com' || host.endsWith('.ikea.com');
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
 * Try IKEA's JSON search APIs to fetch job listings.
 * iCIMS/TalentBrew sites sometimes expose a search API.
 */
async function trySearchApi() {
  for (const apiUrl of SEARCH_API_URLS) {
    try {
      console.log(`   Trying IKEA search API: ${apiUrl}`);
      const data = await fetchJson(apiUrl, { timeoutMs: 15000 });
      const items = data?.jobs || data?.results || data?.data || (Array.isArray(data) ? data : []);
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
 * Parse the IKEA jobs listing page HTML.
 * TalentBrew sites render job cards with links and titles.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // TalentBrew / iCIMS selectors
  const JOB_SELECTORS = [
    '.iCIMS_JobsTable a[href*="job"]',
    '.jobs-list a, .job-listing a',
    'a[href*="/job/"], a[href*="/jobs/"]',
    '.results-list a, .search-results a',
    'h2 a, h3 a, h4 a',
  ];

  for (const selector of JOB_SELECTORS) {
    const links = document.querySelectorAll(selector);
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const title = normalizeSpace(link.textContent || '');

      if (!title || title.length < 5) continue;
      if (seen.has(title.toLowerCase())) continue;
      // Filter out non-job links
      if (/login|privacy|cookie|about|locations|culture|benefits|search/i.test(title)) continue;

      seen.add(title.toLowerCase());
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

      // Extract location from nearby text
      const parent = link.closest('li, tr, div, article') || link.parentElement;
      const parentText = parent?.textContent || '';
      const locationMatch = parentText.match(/(?:grancia|lugano|zurich|zürich|bern|geneva|lausanne|basel|spreitenbach|st\.\s*gallen|lyssach|rothenburg|pratteln)/i);
      const location = locationMatch ? locationMatch[0] : 'Grancia';

      jobs.push({ title, url: fullUrl, location, description: '' });
    }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Fetch detail page for a single IKEA job listing.
 */
async function fetchDetailDescription(url) {
  try {    let html = '';
  try {
    html = await fetchHtml(url, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
    if (!html) return '';
    const { document } = new JSDOM(html).window;

    const BODY_SELECTORS = [
      '.iCIMS_JobContent',
      '.job-description',
      '.job-details',
      '[class*="description"]',
      'article',
      'main',
    ];

    for (const sel of BODY_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = stripHtml(el.innerHTML || '');
      if (text.length >= 100) return text;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Check if a location is in Ticino (or neighboring southern Switzerland).
 */
function isTicinoLocation(location = '') {
  const loc = location.toLowerCase();
  return /grancia|lugano|manno|mendrisio|chiasso|bellinzona|locarno|biasca|stabio|caslano|paradiso|massagno/i.test(loc);
}

/**
 * Fetch all IKEA Svizzera jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try IKEA search API endpoints
 *  2. Fall back to HTML scraping of the listing page
 *  3. Fetch detail pages for descriptions
 */
export async function fetchAllIkeaJobs() {
  console.log(`🔍 Fetching IKEA Svizzera jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: Try JSON API
  let listings = await trySearchApi();

  // Strategy 2: Fall back to HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   JSON API did not return jobs, trying HTML scraping...');
    try {
      const html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
      listings = parseListingPage(html);
      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No IKEA job listings found.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || listing.name || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.city || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Grancia';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const publicUrl = listing.url || listing.link || CAREER_URL;

    // Fetch detail page for description
    let descriptionText = stripHtml(listing.description || listing.content || '');
    if (descriptionText.length < 100 && publicUrl !== CAREER_URL) {
      const detailDesc = await fetchDetailDescription(publicUrl);
      if (detailDesc.length > descriptionText.length) descriptionText = detailDesc;
    }

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ikea ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at IKEA Svizzera, ${location}. IKEA is the world's largest furniture retailer, with a store in Grancia (Ticino), Switzerland.`;

    const job = {
      id: `ikea-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IKEA_COMPANY_NAME,
      companyKey: IKEA_KEY,
      companyDomain: IKEA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'IKEA Svizzera Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6916',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Vendita al dettaglio / Arredamento',
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

  console.log(`\n📋 Total IKEA Svizzera jobs discovered: ${jobs.length}`);
  return jobs;
}
