#!/usr/bin/env node
/**
 * Canton du Valais job parser — Fetcher and job builder.
 *
 * Source: https://vs.service-now.com/x/hdvi2/hvs-ats-portal/landing/params/language/fr/spref/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCantonValaisJobs()  — Fetch and parse all jobs
 *   - isCantonValaisJob()         — Match jobs belonging to this company
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

export const CANTON_VALAIS_KEY = 'canton-valais';
export const CANTON_VALAIS_COMPANY_NAME = 'Canton du Valais';
export const CANTON_VALAIS_COMPANY_DOMAIN = 'vs.ch';

const CAREER_URL = 'https://vs.service-now.com/x/hdvi2/hvs-ats-portal/landing/params/language/fr/spref/';
const HQ = getCompanyDefaults('canton-valais');

/**
 * ServiceNow SPA endpoints — the portal renders client-side but the data
 * is served by a REST API. We try the known ServiceNow table API patterns.
 */
const SN_API_URLS = [
  // ServiceNow Table API for job postings (common pattern)
  'https://vs.service-now.com/api/x_hdvi2_hvs_ats/ats_portal/jobs?language=fr',
  // Alternative: scripted REST API
  'https://vs.service-now.com/api/x_hdvi2_hvs_ats/ats_portal_api/jobs?sysparm_limit=100&language=fr',
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
 * Check if a job belongs to Canton du Valais.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCantonValaisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CANTON_VALAIS_KEY ||
    key.startsWith('canton-valais') ||
    company.includes('canton du valais') ||
    url.includes('vs.ch')
  );
}

/**
 * Validate that a URL belongs to Canton du Valais's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'vs.ch' || host.endsWith('.vs.ch');
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
 * Try ServiceNow REST API endpoints to fetch job listings as JSON.
 * ServiceNow SPAs often expose a scripted REST API for the portal data.
 */
async function tryServiceNowApi() {
  const UA = process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  for (const apiUrl of SN_API_URLS) {
    try {
      console.log(`   Trying ServiceNow API: ${apiUrl}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Accept-Language': 'fr-CH,fr;q=0.9',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        // ServiceNow returns { result: [...] } for table API
        const items = data?.result || data?.jobs || data?.data || (Array.isArray(data) ? data : []);
        if (items.length > 0) {
          console.log(`   ServiceNow API returned ${items.length} items`);
          return items;
        }
      } else {
        console.log(`   API returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`   API attempt failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Parse the ServiceNow portal HTML page for embedded job data.
 * ServiceNow SPAs often embed JSON data in script tags or have
 * pre-rendered content for SEO.
 */
function parseServiceNowHtml(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Look for embedded JSON data in script tags
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    // ServiceNow often embeds data as window.__data or angular scope data
    const jsonMatches = text.match(/(?:jobs|postings|positions)\s*[:=]\s*(\[[\s\S]*?\])/i);
    if (jsonMatches) {
      try {
        const parsed = JSON.parse(jsonMatches[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* not valid JSON */ }
    }
  }

  // Strategy 2: Look for job listing elements in rendered HTML
  const JOB_SELECTORS = [
    'a[href*="job"], a[href*="vacancy"], a[href*="position"], a[href*="stelle"]',
    '.job-listing, .job-card, .vacancy-item, .position-item',
    'li[class*="job"], div[class*="job"], article[class*="job"]',
    '.list-group-item a, .card a, tr td a',
  ];

  for (const selector of JOB_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const link = el.tagName === 'A' ? el : el.querySelector('a');
        if (!link) continue;

        const href = link.getAttribute('href') || '';
        const title = normalizeSpace(link.textContent || '');
        if (!title || title.length < 5 || seen.has(title)) continue;

        // Filter out navigation links, social links, etc.
        if (/login|register|contact|about|faq|legal|privacy/i.test(href)) continue;
        if (/cookie|banner|header|footer|nav/i.test(el.className || '')) continue;

        seen.add(title);
        const fullUrl = href.startsWith('http') ? href : `https://vs.service-now.com${href.startsWith('/') ? '' : '/'}${href}`;

        jobs.push({
          title,
          url: fullUrl,
          location: 'Sion',
          description: '',
        });
      }
    } catch { /* selector not found */ }
  }

  return jobs;
}

/**
 * Fetch all Canton du Valais jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try ServiceNow REST API endpoints
 *  2. Fall back to HTML scraping of the portal page
 *  3. Return empty array gracefully if nothing found
 */
export async function fetchAllCantonValaisJobs() {
  console.log(`🔍 Fetching Canton du Valais jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Strategy 1: Try ServiceNow API
  let listings = await tryServiceNowApi();

  // Strategy 2: Fall back to HTML scraping
  if (!listings || listings.length === 0) {
    console.log('   ServiceNow API did not return jobs, trying HTML scraping...');
    try {      let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
      listings = parseServiceNowHtml(html);
      console.log(`   HTML scraping found ${listings?.length || 0} potential jobs`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found (ServiceNow SPA may require JS rendering).');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || listing.name || listing.short_description || '');
    if (!title || title.length < 3) continue;

    // Extract location from listing data or default to Sion
    const rawLocation = listing.location || listing.city || listing.work_location || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Sion';
    const canton = inferAnyCanton(location) || HQ?.canton || 'VS';
    const descriptionHtml = listing.description || listing.job_description || listing.content || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.link || listing.apply_url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} canton-valais ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Poste au sein de l'administration cantonale du Valais, Suisse.`;

    const job = {
      id: `canton-valais-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CANTON_VALAIS_COMPANY_NAME,
      companyKey: CANTON_VALAIS_KEY,
      companyDomain: CANTON_VALAIS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Canton du Valais Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '1950',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.employment_type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Administration publique / Service public',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || listing.posted_date || listing.sys_created_on?.slice(0, 10) || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Canton du Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
