#!/usr/bin/env node
/**
 * Huntsman Corporation job parser — Workday API fetcher and job builder.
 *
 * Source: https://huntsman.wd1.myworkdayjobs.com/en/Huntsman
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHuntsmanJobs()  — Fetch and parse all jobs
 *   - isHuntsmanJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HUNTSMAN_KEY = 'huntsman';
export const HUNTSMAN_COMPANY_NAME = 'Huntsman Corporation';
export const HUNTSMAN_COMPANY_DOMAIN = 'huntsman.com';

const WORKDAY_API_BASE = 'https://huntsman.wd1.myworkdayjobs.com/wday/cxs/huntsman/Huntsman';
const WORKDAY_PUBLIC_BASE = 'https://huntsman.wd1.myworkdayjobs.com/en/Huntsman';
const WORKDAY_HOST = 'huntsman.wd1.myworkdayjobs.com';

/** Workday facet ID for Switzerland */
const SWISS_LOCATION_ID = '187134fccb084a0ea9b4b95f23890dbe';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Huntsman Corporation.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHuntsmanJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HUNTSMAN_KEY ||
    key.startsWith('huntsman') ||
    company.includes('huntsman corporation') ||
    url.includes('huntsman.com') ||
    url.includes('huntsman.wd1.myworkdayjobs.com')
  );
}

/**
 * Validate that a URL belongs to Huntsman Corporation's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'huntsman.com' ||
      host.endsWith('.huntsman.com') ||
      host === WORKDAY_HOST
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|measurement)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|electricien|automaticien|metrolog)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply\s*chain|warehousing)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|shift|conditionnement|pilote)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(project\s*manag|chef\s*de\s*projet)/.test(t)) return 'Management';
  if (/\b(laborat|lab\b|laboratory)/.test(t)) return 'Ricerca';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|supervisor|leader)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('part')) return 'PART_TIME';
  if (t.includes('full')) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Workday API ──────────────────────────────────────────── */

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en,fr-CH;q=0.9',
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
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * List all Swiss jobs from the Workday API with pagination.
 */
async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: { Location_Country: [SWISS_LOCATION_ID] },
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    allPostings.push(...data.jobPostings);

    if (allPostings.length >= (data.total || 0) || data.jobPostings.length < limit) {
      break;
    }
    offset += limit;

    if (data.jobPostings.length === limit) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return allPostings;
}

/**
 * Fetch full detail for a single job posting.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

/* ── Location & canton ────────────────────────────────────── */

function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  // Workday format: "Switzerland - Monthey" or "Germany - Bad Sackingen"
  const parts = cleaned.split(/\s*-\s*/);
  // Return city part (last segment for "Country - City" format)
  return parts.length >= 2 ? parts.slice(1).join('-').trim() : parts[0].trim();
}

function inferCanton(location = '') {
  const canton = inferAnyCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('monthey')) return 'VS';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('visp') || loc.includes('viège')) return 'VS';
  if (loc.includes('sion')) return 'VS';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  return 'VS'; // Default: Monthey is Huntsman's main Swiss site
}

/**
 * Extract the best Swiss location from a job listing + detail.
 * Multi-location jobs list Switzerland locations in additionalLocations.
 */
function resolveSwissCity(detail, listing) {
  const info = detail?.jobPostingInfo || {};
  const primaryLoc = info.location || listing?.locationsText || '';

  // If primary location is already in Switzerland, use it
  if (normalize(primaryLoc).includes('switzerland')) {
    return parseWorkdayLocation(primaryLoc);
  }

  // Check additionalLocations for Swiss locations
  const additionalLocs = info.additionalLocations || [];
  for (const addLoc of additionalLocs) {
    const loc = typeof addLoc === 'string' ? addLoc : (addLoc?.descriptor || '');
    if (normalize(loc).includes('switzerland')) {
      return parseWorkdayLocation(loc);
    }
  }

  // Fallback: parse whatever location text we have
  const city = parseWorkdayLocation(primaryLoc);
  return city || 'Monthey';
}

/* ── Main fetch function ─────────────────────────────────── */

/**
 * Fetch all Huntsman Corporation Swiss jobs from the Workday API.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHuntsmanJobs() {
  console.log(`🔍 Fetching Huntsman Corporation jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland (all Swiss locations)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

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

    const city = resolveSwissCity(detail, listing);
    const canton = inferCanton(city);
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;

    const descBody = descriptionText
      ? `${descriptionText}\n\nHuntsman Corporation is a global manufacturer of differentiated and specialty chemicals. The company operates a major production site in Monthey (Valais), Switzerland.`.trim()
      : `${title} position at Huntsman Corporation in ${city}, Switzerland.\n\nHuntsman Corporation is a global manufacturer of differentiated and specialty chemicals. The company operates a major production site in Monthey (Valais), Switzerland.`.trim();

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} huntsman ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      // ── Required fields ──
      id: `huntsman-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HUNTSMAN_COMPANY_NAME,
      companyKey: HUNTSMAN_KEY,
      companyDomain: HUNTSMAN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descBody,
      descriptionByLocale: { [sourceLang]: descBody },
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location: city,
      canton,
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Chimica',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      url: publicUrl,
      applyUrl: publicUrl,
      source: 'Huntsman Corporation Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Huntsman Corporation jobs discovered: ${jobs.length}`);
  return jobs;
}
