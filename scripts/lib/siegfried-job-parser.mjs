#!/usr/bin/env node
/**
 * Siegfried job parser — Workday API fetcher and job builder.
 *
 * Siegfried is a global CDMO (Contract Development & Manufacturing
 * Organization) headquartered in Zofingen (AG), with a major
 * manufacturing site in Evionnaz (VS) and offices in Schlieren (ZH).
 *
 * The career portal runs on Workday (wd103). The public CXS API
 * returns structured JSON without authentication.
 *
 * API: POST https://siegfried.wd103.myworkdayjobs.com/wday/cxs/siegfried/external/jobs
 * Detail: GET  https://siegfried.wd103.myworkdayjobs.com/wday/cxs/siegfried/external{externalPath}
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSiegfriedJobs()  — Fetch and parse all Swiss jobs
 *   - isSiegfriedJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SIEGFRIED_KEY = 'siegfried';
export const SIEGFRIED_COMPANY_NAME = 'Siegfried';
export const SIEGFRIED_COMPANY_DOMAIN = 'siegfried.ch';

const WORKDAY_API_BASE = 'https://siegfried.wd103.myworkdayjobs.com/wday/cxs/siegfried/external';
const WORKDAY_PUBLIC_BASE = 'https://siegfried.wd103.myworkdayjobs.com/en/external';
const WORKDAY_HOST = 'siegfried.wd103.myworkdayjobs.com';

/** Workday facet ID for Switzerland */
const SWISS_COUNTRY_ID = '187134fccb084a0ea9b4b95f23890dbe';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Siegfried.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSiegfriedJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SIEGFRIED_KEY ||
    key.startsWith('siegfried') ||
    company.includes('siegfried') ||
    url.includes('siegfried.ch') ||
    url.includes(WORKDAY_HOST)
  );
}

/**
 * Validate that a URL belongs to Siegfried's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'siegfried.ch' ||
      host.endsWith('.siegfried.ch') ||
      host === WORKDAY_HOST
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|process.?safety)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|betriebselektrik)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|officer|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|procurement)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply.?chain)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|produktion|schichtf)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|compliance)/.test(t)) return 'Legale';
  if (/\b(lab\b|laborat|analyt|chemistry|chimie|r&d|research|scientist)/.test(t)) return 'Ricerca e Sviluppo';
  if (/\b(betriebsleiter|director|head|lead|manager|leitung)/.test(t)) return 'Management';
  if (/\b(maintenance|wartung|werkschutz|security)/.test(t)) return 'Manutenzione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leitung|betriebsleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (/part/i.test(t)) return 'PART_TIME';
  if (/full/i.test(t)) return 'FULL_TIME';
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
        'Accept-Language': 'en,fr-CH;q=0.9,de-CH;q=0.8',
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
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * List all Swiss jobs from the Workday API, handling pagination.
 */
async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: { locationCountry: [SWISS_COUNTRY_ID] },
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

    // Rate limiting between pagination requests
    await new Promise((r) => setTimeout(r, 500));
  }

  return allPostings;
}

/**
 * Fetch full detail for a single job posting.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

/* ── Location & Canton ────────────────────────────────────── */

function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  // Workday shows "2 Locations" for multi-location jobs — not useful
  if (/\d+\s+location/i.test(cleaned)) return '';
  const parts = cleaned.split(/\s*-\s*/);
  return parts.length > 0 ? parts[0].trim() : cleaned;
}

function inferCanton(location = '') {
  const canton = inferAnyCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('evionnaz') || loc.includes('monthey') || loc.includes('st-maurice')) return 'VS';
  if (loc.includes('zofingen') || loc.includes('aarau')) return 'AG';
  if (loc.includes('schlieren') || loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  return '';
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Siegfried Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSiegfriedJobs() {
  console.log(`🔍 Fetching Siegfried jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland (locationCountry=${SWISS_COUNTRY_ID})\n`);

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

    // ── Location resolution ──
    let locationRaw = info.location || listing.locationsText || '';
    let city = parseWorkdayLocation(locationRaw);

    // For multi-location jobs, try the requisition location
    if (!city && info.jobRequisitionLocation?.descriptor) {
      city = parseWorkdayLocation(info.jobRequisitionLocation.descriptor);
    }
    // Fallback: check additionalLocations for a Swiss entry
    if (!city && info.additionalLocations) {
      for (const addLoc of info.additionalLocations) {
        const country = addLoc?.country?.alpha2Code || '';
        if (country === 'CH') {
          city = parseWorkdayLocation(addLoc?.descriptor || '');
          break;
        }
      }
    }
    if (!city) city = 'Evionnaz'; // Default — main manufacturing site in VS

    const canton = inferCanton(city);
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;

    // Build source-locale description with company context
    const companyBlurb =
      'Siegfried is a leading CDMO (Contract Development & Manufacturing Organization) ' +
      'headquartered in Zofingen, Switzerland. The company operates manufacturing sites ' +
      'in Evionnaz (Valais), Zofingen (Aargau), and Schlieren (Zurich).';
    const description = descriptionText
      ? `${descriptionText}\n\n${companyBlurb}`.trim()
      : `${title} position at Siegfried in ${city}, Switzerland.\n\n${companyBlurb}`.trim();

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} siegfried ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';
    const hiringOrg = detail?.hiringOrganization?.name || SIEGFRIED_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `siegfried-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SIEGFRIED_COMPANY_NAME,
      companyKey: SIEGFRIED_KEY,
      companyDomain: SIEGFRIED_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Siegfried Dedicated Parser (Workday)',
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
      sector: 'Farmaceutica / Biotecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (jobReqId) job.jobReqId = jobReqId;
    if (hiringOrg !== SIEGFRIED_COMPANY_NAME) job.hiringOrganization = hiringOrg;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Siegfried Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}
