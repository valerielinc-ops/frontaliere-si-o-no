#!/usr/bin/env node
/**
 * Straumann job parser — Fetcher and job builder.
 *
 * Source: https://careers.straumann.com/global/en/search-results
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStraumannJobs()  — Fetch and parse all jobs
 *   - isStraumannJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STRAUMANN_KEY = 'straumann';
export const STRAUMANN_COMPANY_NAME = 'Straumann';
export const STRAUMANN_COMPANY_DOMAIN = 'straumann.com';

const CAREER_URL = 'https://careers.straumann.com/global/en/search-results';
const WIDGETS_API = 'https://careers.straumann.com/widgets';
const ATS_HOST = 'careers.straumann.com';
const SECTOR = 'Dental / Medical Devices (MedTech)';

// HQ fallback (Basel, Basel-Stadt) per recon record.
const HQ = { city: 'Basel', canton: 'BS', postalCode: '4002', region: 'Basel-Stadt' };

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a Phenom `postedDate` value to ISO YYYY-MM-DD.
 * Phenom usually returns an ISO-ish date; fall back to today when absent/unparseable.
 */
function normalizePostedDate(value) {
  const today = new Date().toISOString().split('T')[0];
  if (!value) return today;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  // Already a bare YYYY-MM-DD string?
  const m = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : today;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Straumann.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isStraumannJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STRAUMANN_KEY ||
    key.startsWith('straumann') ||
    company.includes('straumann') ||
    url.includes('straumann.com')
  );
}

/**
 * Validate that a URL belongs to Straumann's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary domain + subdomains (covers careers.straumann.com, the real ATS host).
    return host === 'straumann.com' || host.endsWith('.straumann.com');
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
 * Build the Phenom People `refineSearch` widget request body for a page offset.
 * The Switzerland country facet is selected server-side; we also post-filter below.
 */
function buildRefineSearchBody(from) {
  return {
    lang: 'en_global',
    deviceType: 'desktop',
    country: 'global',
    pageName: 'search-results',
    ddoKey: 'refineSearch',
    sortBy: '',
    subsearch: '',
    from,
    jobs: true,
    counts: true,
    all_fields: ['category', 'country', 'state', 'city', 'type'],
    size: 10,
    clearAll: false,
    jdsource: 'facets',
    isSliderEnable: false,
    pageId: 'page19',
    siteType: 'external',
    keywords: '',
    global: true,
    selected_fields: { country: ['Switzerland'] },
    locationData: {},
  };
}

/**
 * Build the public job-detail URL from a Phenom job record.
 * Format: https://careers.straumann.com/global/en/job/{jobId}/{slugified-title}
 */
function buildJobUrl(job) {
  const id = job.jobId || job.reqId;
  const titleSlug = slugify(job.title || '');
  // locale-segment-ok: external Straumann careers ATS URL, not a site locale route
  return `https://careers.straumann.com/global/en/job/${id}/${titleSlug}`;
}

/**
 * Fetch all Switzerland job listings from the Phenom People `refineSearch` widget.
 * The API caps each response at 10 jobs regardless of `size`, so we paginate via
 * `from` in increments of 10 until a page returns fewer than 10 jobs.
 * Returns raw listing objects: {title, location, url, postedAt?, description?, jobReqId?, ...}
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${WIDGETS_API} (Phenom refineSearch, country=Switzerland)`);

  const headers = {
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://careers.straumann.com',
    Referer: CAREER_URL,
  };

  const listings = [];
  const PAGE = 10;
  const MAX_PAGES = 50; // safety cap (Switzerland count ~10; total global ~216)

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const data = await fetchJson(WIDGETS_API, {
      method: 'POST',
      headers,
      body: buildRefineSearchBody(from),
    });

    const jobs = data?.refineSearch?.data?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0) break;

    for (const job of jobs) {
      // Post-filter: a multi-location job can leak a foreign country into the set.
      const country = job.country || '';
      const cityStateCountry = job.cityStateCountry || '';
      const isCh =
        country === 'Switzerland' || /Switzerland\s*$/i.test(cityStateCountry);
      if (!isCh) continue;

      const location =
        job.city ||
        (cityStateCountry ? cityStateCountry.replace(/,\s*Switzerland\s*$/i, '').trim() : '') ||
        job.state ||
        '';

      listings.push({
        title: job.title || '',
        location,
        city: job.city || '',
        state: job.state || '',
        url: buildJobUrl(job),
        postedAt: job.postedDate || '',
        description: job.descriptionTeaser || '',
        category: job.category || '',
        department: job.department || '',
        jobReqId: job.reqId || job.jobId || '',
      });
    }

    if (jobs.length < PAGE) break;
  }

  return listings;
}

/**
 * Fetch all Straumann jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllStraumannJobs() {
  console.log(`🔍 Fetching Straumann jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(listing.location || listing.city || '') || HQ.city;
    const canton = inferSwissTargetCanton(location) || HQ.canton;
    const descriptionHtml = listing.description || '';
    const descriptionText = normalizeSpace(stripHtml(descriptionHtml));
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} straumann ch`);
    const idSeed = listing.jobReqId ? `straumann-${listing.jobReqId}` : publicUrl;
    const urlHash = createHash('sha1').update(idSeed).digest('hex').slice(0, 12);

    const fallbackDesc = `${title} — ${STRAUMANN_COMPANY_NAME}, ${location} (CH).`;
    const description = descriptionText || fallbackDesc;

    const job = {
      // ── Required fields ──
      id: `straumann-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STRAUMANN_COMPANY_NAME,
      companyKey: STRAUMANN_KEY,
      companyDomain: STRAUMANN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Straumann Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: canton === HQ.canton ? HQ.region : undefined,
      postalCode: canton === HQ.canton ? HQ.postalCode : undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: listing.category || detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: normalizePostedDate(listing.postedAt),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Straumann jobs discovered: ${jobs.length}`);
  return jobs;
}
