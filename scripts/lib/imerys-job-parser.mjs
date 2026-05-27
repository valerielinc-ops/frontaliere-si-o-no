#!/usr/bin/env node
/**
 * Imerys job parser — Fetcher and job builder.
 *
 * Source: https://www.imerys.com/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllImerysJobs()  — Fetch and parse all jobs
 *   - isImerysJob()         — Match jobs belonging to this company
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

export const IMERYS_KEY = 'imerys';
export const IMERYS_COMPANY_NAME = 'Imerys';
export const IMERYS_COMPANY_DOMAIN = 'imerys.com';

const CAREER_URL = 'https://www.imerys.com/careers';
const HQ = getCompanyDefaults('imerys');

/**
 * Imerys uses SmartRecruiters. Their job search API is typically at:
 *   https://careers.smartrecruiters.com/Imerys/
 * The SmartRecruiters public API provides JSON job listings.
 */
const SR_API_BASE = 'https://careers.smartrecruiters.com/Imerys';
const SR_API_URL = 'https://api.smartrecruiters.com/v1/companies/Imerys/postings';
const SR_SEARCH_PARAMS = { country: 'ch', limit: 100 };

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Imerys.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isImerysJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IMERYS_KEY ||
    key.startsWith('imerys') ||
    company.includes('imerys') ||
    url.includes('imerys.com')
  );
}

/**
 * Validate that a URL belongs to Imerys's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'imerys.com' || host.endsWith('.imerys.com');
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
 * Fetch Swiss jobs from the SmartRecruiters API.
 * SmartRecruiters exposes a public API for job postings.
 */
async function trySmartRecruitersApi() {
  const params = new URLSearchParams(SR_SEARCH_PARAMS);
  const apiUrl = `${SR_API_URL}?${params}`;
  try {
    console.log(`   Trying SmartRecruiters API: ${apiUrl}`);
    const data = await fetchJson(apiUrl, { timeoutMs: 20000 });
    const items = data?.content || data?.results || data?.jobs || (Array.isArray(data) ? data : []);
    if (items.length > 0) {
      console.log(`   SmartRecruiters API returned ${items.length} Swiss jobs`);
      return items;
    }
  } catch (err) {
    console.log(`   SmartRecruiters API attempt failed: ${err.message}`);
  }
  return null;
}

/**
 * Parse the SmartRecruiters career page HTML for Imerys.
 */
async function trySmartRecruitersHtml() {
  const srUrl = `${SR_API_BASE}?search=&location=Switzerland`;
  try {
    console.log(`   Trying SmartRecruiters HTML: ${srUrl}`);    let html = '';
  try {
    html = await fetchHtml(srUrl, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
    if (!html) return [];

    const { document } = new JSDOM(html).window;
    const jobs = [];
    const seen = new Set();

    // SmartRecruiters renders job cards
    const JOB_SELECTORS = [
      'a.job-link, a[href*="/jobs/"]',
      '.opening-job a, .job-result a',
      'h3 a, h4 a, .job-title a',
      'li a[href*="smartrecruiters"]',
    ];

    for (const selector of JOB_SELECTORS) {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');

        if (!title || title.length < 5 || seen.has(title.toLowerCase())) continue;
        if (/login|privacy|about/i.test(href)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `${SR_API_BASE}${href.startsWith('/') ? '' : '/'}${href}`;

        // Extract location from context
        const parent = link.closest('li, div, article, section') || link.parentElement;
        const parentText = (parent?.textContent || '').toLowerCase();
        const locMatch = parentText.match(/(?:bodio|switzerland|schweiz|zurich|zürich|paris|france)/i);

        jobs.push({
          title,
          url: fullUrl,
          location: locMatch ? locMatch[0] : '',
          description: '',
        });
      }
      if (jobs.length > 0) break;
    }

    return jobs;
  } catch (err) {
    console.log(`   SmartRecruiters HTML fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Parse the Imerys corporate careers page for any job data.
 */
function parseImerysCareerPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Look for embedded job links
  const links = document.querySelectorAll('a[href*="career"], a[href*="job"], a[href*="smartrecruiters"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const title = normalizeSpace(link.textContent || '');

    if (!title || title.length < 5 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    const fullUrl = href.startsWith('http') ? href : `https://www.imerys.com${href.startsWith('/') ? '' : '/'}${href}`;
    jobs.push({ title, url: fullUrl, location: '', description: '' });
  }

  return jobs;
}

/**
 * Check if a location is in Switzerland (Bodio area or broader).
 */
function isSwissLocation(location = '') {
  const loc = location.toLowerCase();
  return /bodio|switzerland|schweiz|suisse|svizzera|ticino|tessin|zurich|zürich/i.test(loc) || !loc;
}

/**
 * Fetch all Imerys jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try SmartRecruiters API for Swiss jobs
 *  2. Try SmartRecruiters HTML page
 *  3. Fall back to Imerys corporate careers page
 *  4. Filter for Swiss/Bodio locations
 */
export async function fetchAllImerysJobs() {
  console.log(`🔍 Fetching Imerys jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: SmartRecruiters API
  let listings = await trySmartRecruitersApi();

  // Strategy 2: SmartRecruiters HTML
  if (!listings || listings.length === 0) {
    listings = await trySmartRecruitersHtml();
  }

  // Strategy 3: Imerys corporate page
  if (!listings || listings.length === 0) {
    console.log('   Trying Imerys corporate careers page...');
    try {
      const html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
      listings = parseImerysCareerPage(html);
      console.log(`   Corporate page found ${listings?.length || 0} links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Imerys job listings found.');
    return [];
  }

  // Filter for Swiss locations
  const swissListings = listings.filter((l) => {
    const loc = l.location || l.city || l.relocation?.country || '';
    return isSwissLocation(loc);
  });

  console.log(`  📋 Total listings: ${listings.length}, Swiss-filtered: ${swissListings.length}`);

  const jobs = [];
  for (const listing of swissListings) {
    const title = normalizeSpace(listing.title || listing.name || listing.label || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || listing.city || '';
    const location = (typeof rawLocation === 'object' ? rawLocation.city || rawLocation.name : normalizeSpace(rawLocation)) || HQ?.city || 'Bodio';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const descriptionHtml = listing.description || listing.jobAd?.sections?.jobDescription?.text || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.ref || listing.applyUrl || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} imerys ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Imerys in ${location}, Switzerland. Imerys is a world leader in mineral-based specialty solutions, with a production facility in Bodio (Ticino) specializing in graphite and carbon products.`;

    const job = {
      id: `imerys-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IMERYS_COMPANY_NAME,
      companyKey: IMERYS_KEY,
      companyDomain: IMERYS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Imerys Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6743',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.typeOfEmployment || listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Industria mineraria / Materiali speciali',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || listing.releasedDate?.split('T')[0] || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Imerys jobs discovered: ${jobs.length}`);
  return jobs;
}
