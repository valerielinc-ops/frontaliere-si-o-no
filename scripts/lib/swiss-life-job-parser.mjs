#!/usr/bin/env node
/**
 * Swiss Life job parser — Workday API fetcher and job builder.
 *
 * Swiss Life uses a Workday ATS. The public career site is embedded via
 * Prospective.ch iframe at swisslife.ch, but the underlying data comes
 * from Workday at swisslife.wd3.myworkdayjobs.com.
 *
 * API:
 *   - POST /wday/cxs/swisslife/Swiss_Life_Career_Site/jobs  — paginated listing
 *   - GET  /wday/cxs/swisslife/Swiss_Life_Career_Site{externalPath} — job detail
 *
 * Filter: Valais locations only (Sion, Visp, GS Martigny).
 *
 * Source: https://www.swisslife.ch/en/about-us/job-careers/our-vacancies.html
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSwissLifeJobs()  — Fetch and parse all Valais jobs
 *   - isSwissLifeJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SWISS_LIFE_KEY = 'swiss-life';
export const SWISS_LIFE_COMPANY_NAME = 'Swiss Life';
export const SWISS_LIFE_COMPANY_DOMAIN = 'swisslife.ch';

const SWISS_LIFE_HQ = getCompanyDefaults(SWISS_LIFE_KEY);
const DEFAULT_SWISS_LIFE_CITY = SWISS_LIFE_HQ?.city || 'Sion';
const DEFAULT_SWISS_LIFE_CANTON = SWISS_LIFE_HQ?.canton || 'VS';

const WORKDAY_API_BASE =
  'https://swisslife.wd3.myworkdayjobs.com/wday/cxs/swisslife/Swiss_Life_Career_Site';
const WORKDAY_PUBLIC_BASE =
  'https://swisslife.wd3.myworkdayjobs.com/en-US/Swiss_Life_Career_Site';

/**
 * Workday location facet IDs for Valais.
 * Fetched from the Workday API facets response.
 */
const VALAIS_LOCATION_IDS = [
  '2464b261c84101a20ce1533a7210b338', // Sion
  '2464b261c8410153eea6493a72108b38', // Visp
  '1c896c1d677810015234c09368b80000', // GS Martigny
];

const PAGE_SIZE = 20;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Swiss Life.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSwissLifeJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SWISS_LIFE_KEY ||
    key.startsWith('swiss-life') ||
    company.includes('swiss life') ||
    url.includes('swisslife.ch') ||
    url.includes('swisslife.wd3.myworkdayjobs.com')
  );
}

/**
 * Validate that a URL belongs to Swiss Life's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'swisslife.ch' ||
      host.endsWith('.swisslife.ch') ||
      host === 'swisslife.wd3.myworkdayjobs.com'
    );
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
  if (/\b(vendita|sales|verkauf|commerce|immobil|courtier|makler)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|prévoyance|vorsorge|wealth|conseill|berat)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(support|customer|kundenserv)/.test(t)) return 'Supporto';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  if (/\b(erfahrung|expérience|experienced)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (/\bfull/i.test(t)) return 'FULL_TIME';
  if (/\bpart/i.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Workday API Client ───────────────────────────────────── */

/**
 * Fetch JSON from the Workday API with timeout handling.
 */
async function fetchJson(url, options = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en,de-CH;q=0.9',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...options.headers,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Fetch paginated job listings from Workday, filtered by Valais locations.
 * Queries each location facet separately to avoid missing jobs that belong
 * to multiple locations.
 */
async function fetchValaisListings() {
  const seen = new Map();

  for (const locationId of VALAIS_LOCATION_IDS) {
    let offset = 0;

    while (true) {
      console.log(`  📄 Fetching location ${locationId} at offset ${offset}...`);
      const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, {
        method: 'POST',
        body: JSON.stringify({
          appliedFacets: { locations: [locationId] },
          limit: PAGE_SIZE,
          offset,
          searchText: '',
        }),
      });

      if (!data || !Array.isArray(data.jobPostings)) {
        if (offset === 0) console.warn(`  ⚠️ No results for location ${locationId}`);
        break;
      }

      for (const posting of data.jobPostings) {
        const reqId = (posting.bulletFields || [])[0] || posting.externalPath;
        if (reqId && !seen.has(reqId)) {
          seen.set(reqId, posting);
        }
      }

      if (data.jobPostings.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await new Promise((r) => setTimeout(r, 300));
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return [...seen.values()];
}

/**
 * Fetch full detail for a single job from Workday.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

/* ── Location helpers ─────────────────────────────────────── */

/**
 * Extract a city name from Workday's locationsText field.
 * Handles "N Locations" format by returning empty string.
 */
function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  return cleaned.split(/\s*[,\-–]\s*/)[0].trim();
}

/**
 * Resolve the best Swiss city for a job from detail data.
 * Picks the first parseable Swiss location across primary, additionalLocations,
 * and the requisition descriptor — anywhere across the 26 cantons.
 */
function resolveSwissCity(info = {}, listingLocText = '') {
  const primary = parseWorkdayLocation(info.location || listingLocText);
  if (primary && inferAnyCanton(primary)) return primary;

  const additionalLocations = info.additionalLocations || [];
  for (const addLoc of additionalLocations) {
    const cleaned = normalizeSpace(String(addLoc || ''));
    if (cleaned && inferAnyCanton(cleaned)) return cleaned;
  }

  const reqLocDesc = info.jobRequisitionLocation?.descriptor || '';
  if (reqLocDesc) {
    const cleaned = parseWorkdayLocation(reqLocDesc);
    if (cleaned && inferAnyCanton(cleaned)) return cleaned;
  }

  if (primary) return primary;
  return DEFAULT_SWISS_LIFE_CITY;
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Swiss Life Valais jobs from the Workday API.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSwissLifeJobs() {
  console.log(`🔍 Fetching Swiss Life jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);
  console.log(`   Filter: Valais locations (Sion, Visp, Martigny)\n`);

  const listings = await fetchValaisListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Valais job listings returned from Workday API.');
    return [];
  }

  console.log(`\n  📋 Unique Valais listings found: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);

    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) {
      console.log('  ⏭️  Skipped — empty title');
      continue;
    }

    const city = resolveSwissCity(info, listing.locationsText);
    const canton = inferAnyCanton(city) || DEFAULT_SWISS_LIFE_CANTON;
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;
    const hiringOrg = detail?.hiringOrganization?.name || SWISS_LIFE_COMPANY_NAME;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} swiss-life ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || listing.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const description = descriptionText
      ? descriptionText
      : `${title} — ${hiringOrg}`;

    const job = {
      // ── Required fields ──
      id: `swiss-life-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SWISS_LIFE_COMPANY_NAME,
      companyKey: SWISS_LIFE_KEY,
      companyDomain: SWISS_LIFE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Swiss Life Dedicated Parser (Workday)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Assicurazioni / Previdenza',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (jobReqId) job.jobReqId = jobReqId;
    if (hiringOrg !== SWISS_LIFE_COMPANY_NAME) job.hiringOrganization = hiringOrg;

    jobs.push(job);
    console.log(`  ✅ ${jobReqId || '—'} — ${title.substring(0, 70)}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Swiss Life Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
