#!/usr/bin/env node
/**
 * Bally job parser — Fetcher and job builder.
 *
 * Source: https://www.bally.com/en-ch/careers.html
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBallyJobs()  — Fetch and parse all jobs
 *   - isBallyJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BALLY_KEY = 'bally';
export const BALLY_COMPANY_NAME = 'Bally';
export const BALLY_COMPANY_DOMAIN = 'bally.com';

const CAREER_URL = 'https://www.bally.com/en-ch/careers.html';
const HQ = getCompanyDefaults('bally');

/**
 * Bally's careers page may have moved or is intermittently 404.
 * We try multiple potential URLs: the original, a common alternative,
 * and the Bally Group careers page (parent company Regent since 2023).
 */
const CAREER_URLS = [
  'https://www.bally.com/en-ch/careers.html',
  'https://www.bally.com/careers',
  'https://www.bally.com/en-ch/careers',
  'https://careers.bally.com/',
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
 * Check if a job belongs to Bally.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBallyJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BALLY_KEY ||
    key.startsWith('bally') ||
    company.includes('bally') ||
    url.includes('bally.com')
  );
}

/**
 * Validate that a URL belongs to Bally's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bally.com' || host.endsWith('.bally.com');
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
 * Parse a Bally careers page HTML for job listings.
 * Bally typically lists open positions as links or cards.
 */
function parseCareerPageHtml(html = '', baseUrl = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Look for embedded JSON-LD or structured data
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const postings = Array.isArray(data) ? data : data?.['@graph'] || [data];
      for (const item of postings) {
        if (item?.['@type'] === 'JobPosting') {
          jobs.push({
            title: item.title || '',
            url: item.url || baseUrl,
            location: item.jobLocation?.address?.addressLocality || 'Caslano',
            description: item.description || '',
          });
        }
      }
      if (jobs.length > 0) return jobs;
    } catch { /* not valid JSON-LD */ }
  }

  // Scrape job links from HTML
  const JOB_SELECTORS = [
    'a[href*="career"], a[href*="job"], a[href*="position"], a[href*="lavora"]',
    '.job-listing a, .career-listing a, .position-card a',
    '.vacancy a, .opening a',
    'h2 a, h3 a, h4 a',
    'li a, article a',
  ];

  for (const selector of JOB_SELECTORS) {
    try {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');

        if (!title || title.length < 5) continue;
        if (seen.has(title.toLowerCase())) continue;
        // Filter out navigation/footer links
        if (/login|privacy|cookie|newsletter|terms|contact|store|shop|collection/i.test(href)) continue;
        if (/login|privacy|cookie|newsletter|terms|customer service/i.test(title.toLowerCase())) continue;

        seen.add(title.toLowerCase());
        const origin = baseUrl ? new URL(baseUrl).origin : 'https://www.bally.com';
        const fullUrl = href.startsWith('http') ? href : `${origin}${href.startsWith('/') ? '' : '/'}${href}`;

        jobs.push({ title, url: fullUrl, location: 'Caslano', description: '' });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Fetch all Bally jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy: Try multiple potential career page URLs since the page
 * may have moved. Parse whatever HTML comes back.
 */
export async function fetchAllBallyJobs() {
  console.log(`🔍 Fetching Bally jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];

  // Try each potential careers URL
  for (const url of CAREER_URLS) {
    try {
      console.log(`   Trying: ${url}`);      let html = '';
  try {
    html = await fetchHtml(url, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
      const found = parseCareerPageHtml(html, url);
      if (found.length > 0) {
        listings = found;
        console.log(`   Found ${found.length} job links at ${url}`);
        break;
      }
      console.log(`   No jobs found at ${url}`);
    } catch (err) {
      console.log(`   Fetch failed for ${url}: ${err.message}`);
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Bally job listings found (careers page may have moved or be temporarily unavailable).');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Caslano';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} bally ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Bally, ${location}. Bally is a Swiss luxury fashion house founded in 1851, headquartered in Caslano (Ticino), known for its leather goods and footwear.`;

    const job = {
      id: `bally-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BALLY_COMPANY_NAME,
      companyKey: BALLY_KEY,
      companyDomain: BALLY_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Bally Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6987',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Moda / Lusso',
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

  console.log(`\n📋 Total Bally jobs discovered: ${jobs.length}`);
  return jobs;
}
