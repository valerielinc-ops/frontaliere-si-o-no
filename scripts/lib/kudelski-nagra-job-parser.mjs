#!/usr/bin/env node
/**
 * Kudelski NAGRA job parser — Fetcher and job builder.
 *
 * Source: https://careers.nagra.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKudelskiNagraJobs()  — Fetch and parse all jobs
 *   - isKudelskiNagraJob()         — Match jobs belonging to this company
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

export const KUDELSKI_NAGRA_KEY = 'kudelski-nagra';
export const KUDELSKI_NAGRA_COMPANY_NAME = 'Kudelski NAGRA';
export const KUDELSKI_NAGRA_COMPANY_DOMAIN = 'nagra.com';

const CAREER_URL = 'https://careers.nagra.com/';
const BASE_URL = 'https://careers.nagra.com';
const HQ = getCompanyDefaults('kudelski-nagra');

/**
 * Kudelski/NAGRA uses Greenhouse for recruitment. Greenhouse provides
 * a public JSON API for job boards.
 */
const GH_BOARDS_API = 'https://boards-api.greenhouse.io/v1/boards/kudelski/jobs';
const GH_BOARDS_DETAIL = 'https://boards-api.greenhouse.io/v1/boards/kudelski/jobs';
const GH_PUBLIC_BASE = 'https://careers.nagra.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kudelski NAGRA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKudelskiNagraJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KUDELSKI_NAGRA_KEY ||
    key.startsWith('kudelski-nagra') ||
    company.includes('kudelski nagra') ||
    url.includes('nagra.com')
  );
}

/**
 * Validate that a URL belongs to Kudelski NAGRA's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'nagra.com' || host.endsWith('.nagra.com');
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
 * Fetch jobs from Greenhouse Boards API.
 * Greenhouse provides a public JSON API for job boards.
 * The board slug may be 'kudelski', 'nagra', 'kudelskigroup', etc.
 */
async function tryGreenhouseApi() {
  const boardSlugs = ['kudelski', 'nagra', 'kudelskigroup', 'kudelski-group'];

  for (const board of boardSlugs) {
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
    try {
      console.log(`   Trying Greenhouse API: ${apiUrl}`);
      const data = await fetchJson(apiUrl, { timeoutMs: 15000 });
      const items = data?.jobs || (Array.isArray(data) ? data : []);
      if (items.length > 0) {
        console.log(`   Greenhouse API (board: ${board}) returned ${items.length} jobs`);
        return { items, board };
      }
    } catch (err) {
      console.log(`   Greenhouse board '${board}' failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Parse the careers.nagra.com HTML page for job listings.
 * If not Greenhouse, try generic HTML scraping.
 */
function parseNagraCareerPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Check for Lever-style job listings
  const leverLinks = document.querySelectorAll('a[href*="lever.co"], a[href*="jobs.lever.co"]');
  if (leverLinks.length > 0) {
    for (const link of leverLinks) {
      const href = link.getAttribute('href') || '';
      const title = normalizeSpace(link.textContent || '');
      if (!title || title.length < 5 || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      jobs.push({ title, url: href, location: '', description: '' });
    }
    return jobs;
  }

  // Generic scraping: job links
  const JOB_SELECTORS = [
    'a[href*="job"], a[href*="position"], a[href*="career"]',
    '.job-listing a, .opening a, .vacancy a',
    'h2 a, h3 a, h4 a',
    '.departments a, .team a',
  ];

  for (const selector of JOB_SELECTORS) {
    try {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');

        if (!title || title.length < 5 || seen.has(title.toLowerCase())) continue;
        if (/login|privacy|cookie|about|contact|blog/i.test(href)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

        // Extract location from context
        const parent = link.closest('li, tr, div, article, section') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const locMatch = parentText.match(/(?:lugano|cheseaux|lausanne|phoenix|paris|zurich|zürich|switzerland)/i);

        jobs.push({ title, url: fullUrl, location: locMatch ? locMatch[0] : '', description: '' });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Check if a location is relevant (Lugano/Ticino or broader Swiss).
 */
function isRelevantLocation(location = '') {
  const loc = location.toLowerCase();
  return /lugano|ticino|tessin|cheseaux|lausanne|switzerland|schweiz|suisse|svizzera|vaud/i.test(loc) || !loc;
}

/**
 * Fetch all Kudelski NAGRA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try Greenhouse Boards API with multiple board slugs
 *  2. Fall back to HTML scraping of careers.nagra.com
 *  3. Filter for Swiss locations (Kudelski is headquartered in Cheseaux-sur-Lausanne
 *     with a significant office in Lugano)
 */
export async function fetchAllKudelskiNagraJobs() {
  console.log(`🔍 Fetching Kudelski NAGRA jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];
  let ghBoard = '';

  // Strategy 1: Greenhouse API
  const ghResult = await tryGreenhouseApi();
  if (ghResult) {
    listings = ghResult.items;
    ghBoard = ghResult.board;
  }

  // Strategy 2: HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   Greenhouse API did not return jobs, trying HTML scraping...');
    try {      let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
      listings = parseNagraCareerPage(html);
      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Kudelski NAGRA job listings found.');
    return [];
  }

  // Filter for Swiss locations
  const swissListings = listings.filter((l) => {
    const loc = l.location?.name || l.location || l.city || '';
    return isRelevantLocation(typeof loc === 'string' ? loc : loc?.name || '');
  });

  console.log(`  📋 Total listings: ${listings.length}, Swiss-filtered: ${swissListings.length}`);

  const jobs = [];
  for (const listing of swissListings) {
    const title = normalizeSpace(listing.title || listing.name || '');
    if (!title || title.length < 3) continue;

    // Greenhouse returns location as { name: "..." } or a string
    const rawLoc = listing.location?.name || listing.location || listing.city || '';
    const location = normalizeSpace(typeof rawLoc === 'string' ? rawLoc : rawLoc?.name || '') || HQ?.city || 'Lugano';
    const canton = inferAnyCanton(location) || HQ?.canton || '';

    // Greenhouse provides job content as HTML
    const descriptionHtml = listing.content || listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);

    // Build public URL
    let publicUrl = listing.absolute_url || listing.url || listing.link || '';
    if (!publicUrl && ghBoard) {
      publicUrl = `https://boards.greenhouse.io/${ghBoard}/jobs/${listing.id}`;
    }
    if (!publicUrl) publicUrl = CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} kudelski-nagra ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Kudelski NAGRA in ${location}. The Kudelski Group is a world leader in digital security and convergent media solutions, with NAGRA providing content protection technology for major media companies.`;

    const job = {
      id: `kudelski-nagra-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KUDELSKI_NAGRA_COMPANY_NAME,
      companyKey: KUDELSKI_NAGRA_KEY,
      companyDomain: KUDELSKI_NAGRA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Kudelski NAGRA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6900',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sicurezza digitale / Media technology',
      currency: 'CHF',
      featured: false,
      postedDate: listing.updated_at?.slice(0, 10) || listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.absolute_url || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Kudelski NAGRA jobs discovered: ${jobs.length}`);
  return jobs;
}
