#!/usr/bin/env node
/**
 * APG|SGA job parser — Fetcher and job builder.
 *
 * Source: https://www.apgsga.ch/de/karriere/offene-stellen/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllApgSgaJobs()  — Fetch and parse all jobs
 *   - isApgSgaJob()         — Match jobs belonging to this company
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

export const APG_SGA_KEY = 'apg-sga';
export const APG_SGA_COMPANY_NAME = 'APG|SGA';
export const APG_SGA_COMPANY_DOMAIN = 'apgsga.ch';

const CAREER_URL = 'https://www.apgsga.ch/de/karriere/offene-stellen/';
const BASE_URL = 'https://www.apgsga.ch';
const HQ = getCompanyDefaults('apg-sga');

/**
 * APG|SGA uses Ostendis platform for job listings. The careers page
 * typically embeds an Ostendis iframe or loads job data from their API.
 * We scrape the HTML and also try the Ostendis JSON feed.
 */
const OSTENDIS_API_URL = 'https://www.ostendis.com/api/public/v2/apgsga/jobs';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to APG|SGA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isApgSgaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === APG_SGA_KEY ||
    key.startsWith('apg-sga') ||
    company.includes('apg|sga') ||
    url.includes('apgsga.ch')
  );
}

/**
 * Validate that a URL belongs to APG|SGA's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'apgsga.ch' || host.endsWith('.apgsga.ch');
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
 * Try the Ostendis API for APG|SGA job listings.
 * Ostendis is a Swiss ATS that exposes a public API.
 */
async function tryOstendisApi() {
  try {
    console.log(`   Trying Ostendis API: ${OSTENDIS_API_URL}`);    let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
    // Ostendis may return HTML or JSON depending on the endpoint
    if (html.trim().startsWith('[') || html.trim().startsWith('{')) {
      const data = JSON.parse(html);
      const items = Array.isArray(data) ? data : data?.jobs || data?.results || [];
      if (items.length > 0) {
        console.log(`   Ostendis API returned ${items.length} jobs`);
        return items;
      }
    }
  } catch (err) {
    console.log(`   Ostendis API attempt failed: ${err.message}`);
  }
  return null;
}

/**
 * Parse the APG|SGA career page HTML for job listings.
 * Ostendis-based pages typically embed job cards or an iframe to Ostendis.
 */
function parseCareerPageHtml(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Look for Ostendis iframe
  const iframes = document.querySelectorAll('iframe[src]');
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || '';
    if (/ostendis/i.test(src)) {
      console.log(`   Found Ostendis iframe: ${src}`);
      return [{ __iframeUrl: src }];
    }
  }

  // Look for embedded JSON
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const jsonMatch = text.match(/(?:jobs|stellen|vacancies)\s*[:=]\s*(\[[\s\S]*?\])/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* not valid JSON */ }
    }
  }

  // Scrape job links from HTML
  const JOB_SELECTORS = [
    'a[href*="stelle"], a[href*="job"], a[href*="vacancy"], a[href*="ostendis"]',
    '.job-listing a, .career-listing a, .stelle a',
    '.offene-stellen a, .stellenangebote a',
    'article a, .card a',
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
        if (/login|privacy|cookie|impressum|datenschutz|kontakt|about/i.test(href)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

        // Extract location from context
        const parent = link.closest('li, tr, div, article') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const locMatch = parentText.match(/(?:lugano|zürich|zurich|bern|luzern|lausanne|genf|genève|basel|st\.\s*gallen)/i);
        const location = locMatch ? locMatch[0] : '';

        jobs.push({ title, url: fullUrl, location, description: '' });
      }
    } catch { /* selector not found */ }
    if (jobs.length > 0) break;
  }

  return jobs;
}

/**
 * Fetch HTML from an Ostendis iframe and parse it.
 */
async function tryOstendisIframe(iframeUrl) {
  try {
    console.log(`   Fetching Ostendis iframe: ${iframeUrl}`);
    const html = await fetchHtml(iframeUrl, { timeoutMs: 20000 });
    return parseCareerPageHtml(html);
  } catch (err) {
    console.log(`   Ostendis iframe fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all APG|SGA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try Ostendis API
 *  2. Fall back to HTML scraping of the career page
 *  3. Follow any Ostendis iframe if found
 */
export async function fetchAllApgSgaJobs() {
  console.log(`🔍 Fetching APG|SGA jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: Try Ostendis API
  let listings = await tryOstendisApi();

  // Strategy 2: Fall back to HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   Ostendis API did not return jobs, trying HTML scraping...');
    try {
      const html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
      listings = parseCareerPageHtml(html);

      // Follow Ostendis iframe if found
      if (listings?.length === 1 && listings[0].__iframeUrl) {
        const iframeUrl = listings[0].__iframeUrl;
        listings = await tryOstendisIframe(iframeUrl);
      }

      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No APG|SGA job listings found.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || listing.name || listing.bezeichnung || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.ort || listing.city || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Lugano';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const descriptionHtml = listing.description || listing.beschreibung || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.link || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} apg-sga ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Stelle bei APG|SGA in ${location}, Schweiz. APG|SGA ist der führende Schweizer Aussenwerbevermarkter mit Standorten in der ganzen Schweiz.`;

    const job = {
      id: `apg-sga-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: APG_SGA_COMPANY_NAME,
      companyKey: APG_SGA_KEY,
      companyDomain: APG_SGA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'APG|SGA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6900',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || listing.pensum || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.pensum || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Pubblicità / Media esterni',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || listing.datum || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total APG|SGA jobs discovered: ${jobs.length}`);
  return jobs;
}
