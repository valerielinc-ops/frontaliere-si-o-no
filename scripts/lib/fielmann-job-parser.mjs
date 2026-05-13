#!/usr/bin/env node
/**
 * Fielmann Group job parser — Workday API fetcher and job builder.
 *
 * The Fielmann career portal runs on Workday. The public CXS API
 * returns structured JSON without authentication.
 *
 * API:
 *   - POST .../jobs  — paginated listing (filter by Country facet)
 *   - GET  .../job/{externalPath}  — full job detail
 *
 * Source: https://jobs.fielmann.com/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const WORKDAY_API_BASE = 'https://fielmann.wd3.myworkdayjobs.com/wday/cxs/fielmann/External';
const WORKDAY_PUBLIC_BASE = 'https://fielmann.wd3.myworkdayjobs.com/en/External';
const SWISS_COUNTRY_ID = '187134fccb084a0ea9b4b95f23890dbe';
const PAGE_SIZE = 20;

export const FIELMANN_KEY = 'fielmann';
export const FIELMANN_COMPANY_NAME = 'Fielmann Group';
export const FIELMANN_COMPANY_DOMAIN = 'jobs.fielmann.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Fielmann Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFielmannJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FIELMANN_KEY ||
    key.startsWith('fielmann') ||
    company.includes('fielmann group') ||
    url.includes('jobs.fielmann.com')
  );
}

/**
 * Validate that a URL belongs to Fielmann Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.fielmann.com' || host.endsWith('.jobs.fielmann.com') ||
      host === 'fielmann.wd3.myworkdayjobs.com';
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(optik|optic|optom[eé]tr|augenoptik|opticien)/.test(t)) return 'Ottica';
  if (/\b(h[oö]rakustik|hearing|acousti)/.test(t)) return 'Acustica';
  if (/\b(ausbildung|apprenti|lehrling|lernend|formation)/.test(t)) return 'Formazione';
  if (/\b(trainee|graduate)/.test(t)) return 'Formazione';
  if (/\b(filialleiter|store\s*manager|responsab|boutique)/.test(t)) return 'Commerciale';
  if (/\b(vendita|sales|verkauf|commerce|conseill)/.test(t)) return 'Commerciale';
  if (/\b(it|software|develop|programm|data|digital)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|buchhalt|account|contab)/.test(t)) return 'Finanza';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(admin|segret)/.test(t)) return 'Amministrazione';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|ausbildung|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|meister|maître|master)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full') || t.includes('vollzeit')) return 'FULL_TIME';
  if (t.includes('part') || t.includes('teilzeit')) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Workday API Client ───────────────────────────────────── */

/**
 * Fetch JSON from Workday API with timeout handling.
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
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
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
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch paginated Swiss job listings from the Workday CXS API.
 */
async function fetchSwissJobListings() {
  const allPostings = [];
  let offset = 0;

  while (true) {
    console.log(`  📄 Fetching page at offset ${offset}...`);
    const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        appliedFacets: { Country: [SWISS_COUNTRY_ID] },
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    allPostings.push(...data.jobPostings);
    console.log(`  📋 Fetched ${data.jobPostings.length} jobs (total so far: ${allPostings.length} / ${data.total})`);

    if (allPostings.length >= (data.total || 0) || data.jobPostings.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  return allPostings;
}

/**
 * Fetch full detail for a single job from the Workday CXS API.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

/* ── Location Parsing ─────────────────────────────────────── */

/**
 * Parse location from Workday bulletFields or location string.
 * bulletFields[1] typically has format: "Street, PostalCode City"
 */
function parseWorkdayLocation(bulletFields = [], locationText = '') {
  const addressField = (bulletFields || [])[1] || locationText || '';
  const cleaned = normalizeSpace(addressField);

  // Try to extract city from "Street, PostalCode City" or "Store City (CHE)"
  const postalMatch = cleaned.match(/(\d{4})\s+([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ\s-]+)/);
  if (postalMatch) {
    return {
      city: normalizeSpace(postalMatch[2]),
      postalCode: postalMatch[1],
      streetAddress: cleaned.split(',')[0]?.trim() || '',
    };
  }

  // Try "StoreCode City (CHE)" format
  const storeMatch = cleaned.match(/^\d+\/?\d*\s+([A-ZÀ-Ÿa-zà-ÿ][\w\s-]+)/);
  if (storeMatch) {
    return {
      city: normalizeSpace(storeMatch[1]).replace(/\s*\(CHE\)\s*$/i, ''),
      postalCode: '',
      streetAddress: '',
    };
  }

  // Fallback: use the location text as city
  const fallbackCity = cleaned.replace(/\s*\(CHE\)\s*$/i, '').trim();
  return {
    city: fallbackCity || locationText || '',
    postalCode: '',
    streetAddress: '',
  };
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Fielmann Group Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllFielmannJobs() {
  console.log(`🔍 Fetching Fielmann Group jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland\n`);

  const listings = await fetchSwissJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`\n  📋 Swiss job listings found: ${listings.length}. Fetching details...\n`);

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);

    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) {
      console.log(`  ⏭️  Skipped — empty title`);
      continue;
    }

    // Parse location from detail or listing bulletFields
    const locInfo = parseWorkdayLocation(
      listing.bulletFields,
      info.location || '',
    );
    const city = locInfo.city || 'Sion';
    const postalCode = locInfo.postalCode || '';
    const streetAddress = locInfo.streetAddress || '';
    const canton = inferAnyCanton(city) || 'VS';

    // Description
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    // Canonical public URL: the Workday tenant detail page (live + HEAD-friendly).
    // The previously-used `jobs.fielmann.com/de/stellenangebote/detail/{reqId}-{slug}`
    // pattern was fabricated and returns 404, which made cleanup-jobs.mjs delete
    // every Fielmann job on every housekeeping run.
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} fielmann ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      // ── Required fields ──
      id: `fielmann-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FIELMANN_COMPANY_NAME,
      companyKey: FIELMANN_KEY,
      companyDomain: FIELMANN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Fielmann Group`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Fielmann Group` },
      location: city,
      canton,
      url: publicUrl,
      source: 'Fielmann Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ottica / Acustica',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      applyUrl: `${WORKDAY_PUBLIC_BASE}${externalPath}`,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total Fielmann Group jobs discovered: ${deduped.length}`);
  return deduped;
}
