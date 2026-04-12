#!/usr/bin/env node
/**
 * Union Bancaire Privée job parser — Fetcher and job builder.
 *
 * Source: https://www.ubp.com/en/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllUbpJobs()  — Fetch and parse all jobs
 *   - isUbpJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UBP_KEY = 'ubp';
export const UBP_COMPANY_NAME = 'Union Bancaire Privée';
export const UBP_COMPANY_DOMAIN = 'ubp.com';

const CAREER_URL = 'https://www.ubp.com/en/careers';
const BASE_URL = 'https://www.ubp.com';
const HQ = getCompanyDefaults('ubp');

/**
 * UBP uses Oracle Cloud HCM (formerly Taleo). Their careers page typically
 * either embeds an iframe to Oracle HCM or renders job listings server-side.
 * We try scraping the HTML for job links and titles.
 */

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Union Bancaire Privée.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isUbpJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === UBP_KEY ||
    key.startsWith('ubp') ||
    company.includes('union bancaire privée') ||
    url.includes('ubp.com')
  );
}

/**
 * Validate that a URL belongs to Union Bancaire Privée's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ubp.com' || host.endsWith('.ubp.com');
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
 * Parse the UBP careers page HTML for job listings.
 * UBP may use Oracle Cloud HCM (Taleo), an embedded iframe,
 * or server-rendered job list.
 */
function parseCareerPageHtml(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Look for an embedded Oracle HCM iframe URL
  const iframes = document.querySelectorAll('iframe[src]');
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || '';
    if (/oracle|taleo|hcm|recruit/i.test(src)) {
      console.log(`   Found Oracle HCM iframe: ${src}`);
      // Return the iframe URL so we can try to fetch it separately
      return [{ __iframeUrl: src }];
    }
  }

  // Strategy 2: Look for embedded JSON data
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const jsonMatch = text.match(/"(?:jobs|vacancies|positions|openings)"\s*:\s*(\[[\s\S]*?\])/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* not valid JSON */ }
    }
  }

  // Strategy 3: Scrape job links from rendered HTML
  const JOB_SELECTORS = [
    'a[href*="career"], a[href*="job"], a[href*="vacancy"], a[href*="position"]',
    'a[href*="emploi"], a[href*="stelle"]',
    '.job-listing a, .career-listing a, .position-card a, .vacancy-item a',
    '.job-list a, .openings a',
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
        if (/login|privacy|cookie|about|contact|newsletter/i.test(href)) continue;
        if (/our offices|about us|contact|disclaimer/i.test(title.toLowerCase())) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

        // Try to extract location from context
        const parent = link.closest('li, tr, div, article, section') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const locMatch = parentText.match(/(?:lugano|geneva|genève|zurich|zürich|london|monaco)/i);
        const location = locMatch ? locMatch[0] : '';

        jobs.push({ title, url: fullUrl, location, description: '' });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Try to fetch job data from an Oracle HCM iframe URL.
 */
async function tryOracleHcmIframe(iframeUrl) {
  try {
    console.log(`   Trying Oracle HCM iframe: ${iframeUrl}`);
    const html = await fetchHtml(iframeUrl, { timeoutMs: 20000 });
    if (!html) return [];
    return parseCareerPageHtml(html);
  } catch (err) {
    console.log(`   Oracle HCM iframe fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Filter for Lugano/Ticino-related jobs (UBP is based in Geneva
 * with offices in Lugano, Zurich, and globally).
 */
function isLuganoRelevant(location = '', title = '') {
  const combined = `${location} ${title}`.toLowerCase();
  return /lugano|ticino|tessin|locarno|bellinzona/i.test(combined) || !location;
}

/**
 * Fetch all Union Bancaire Privée jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Fetch and parse the careers page HTML
 *  2. If Oracle HCM iframe found, follow it
 *  3. Extract job listings from whatever HTML is available
 */
export async function fetchAllUbpJobs() {
  console.log(`🔍 Fetching Union Bancaire Privée jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];

  try {
    const html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
    listings = parseCareerPageHtml(html);

    // If we found an Oracle HCM iframe, follow it
    if (listings.length === 1 && listings[0].__iframeUrl) {
      const iframeUrl = listings[0].__iframeUrl;
      listings = await tryOracleHcmIframe(iframeUrl);
    }
  } catch (err) {
    console.warn(`   HTML fetch failed: ${err.message}`);
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No UBP job listings found (Oracle HCM may require JS rendering).');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || listing.name || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.city || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Lugano';
    const canton = inferSwissTargetCanton(location) || HQ?.canton || 'TI';
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || listing.link || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ubp ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Union Bancaire Privée (UBP) in ${location}. UBP is one of Switzerland's leading private banks, with offices in Lugano, Geneva, and Zurich, specializing in wealth management and asset management.`;

    const job = {
      id: `ubp-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: UBP_COMPANY_NAME,
      companyKey: UBP_KEY,
      companyDomain: UBP_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Union Bancaire Privée Dedicated Parser',
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
      sector: 'Banca / Gestione patrimoniale',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Union Bancaire Privée jobs discovered: ${jobs.length}`);
  return jobs;
}
