#!/usr/bin/env node
/**
 * Constellium Valais job parser — Fetcher and job builder.
 *
 * Source: https://jobs.constellium.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllConstelliumJobs()  — Fetch and parse all jobs
 *   - isConstelliumJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CONSTELLIUM_KEY = 'constellium';
export const CONSTELLIUM_COMPANY_NAME = 'Constellium Valais';
export const CONSTELLIUM_COMPANY_DOMAIN = 'constellium.com';

const WORKDAY_API_BASE = 'https://constellium.wd3.myworkdayjobs.com/wday/cxs/constellium/constellium';
const WORKDAY_PUBLIC_BASE = 'https://constellium.wd3.myworkdayjobs.com/en/constellium';
const WORKDAY_HOST = 'constellium.wd3.myworkdayjobs.com';

const PAGE_SIZE = 20;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Constellium Valais.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isConstelliumJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CONSTELLIUM_KEY ||
    key.startsWith('constellium') ||
    company.includes('constellium valais') ||
    url.includes('constellium.com') ||
    url.includes(WORKDAY_HOST)
  );
}

/**
 * Validate that a URL belongs to Constellium Valais's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'constellium.com' ||
      host.endsWith('.constellium.com') ||
      host === WORKDAY_HOST ||
      host.endsWith('.myworkdayjobs.com')
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

/* ── Workday API ──────────────────────────────────────────── */

/**
 * Call the Workday JSON API with timeout handling.
 */
async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'fr,en;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...options.headers,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`\u26a0\ufe0f HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`\u26a0\ufe0f Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Check if a listing's location text indicates a Swiss location.
 */
function isSwissLocation(locationsText = '') {
  const loc = normalize(locationsText);
  return (
    loc.startsWith('ch ') ||
    loc.startsWith('ch-') ||
    loc.includes('switzerland') ||
    loc.includes('schweiz') ||
    loc.includes('suisse') ||
    loc.includes('svizzera') ||
    loc.includes('sierre') ||
    loc.includes('sion') ||
    loc.includes('visp') ||
    loc.includes('valais') ||
    loc.includes('wallis') ||
    loc.includes('zurich') ||
    loc.includes('zürich') ||
    loc.includes('basel') ||
    loc.includes('bern') ||
    loc.includes('genev') ||
    loc.includes('lausanne') ||
    loc.includes('lugano') ||
    loc.includes('bellinzona')
  );
}

/**
 * Fetch all job listings from the Workday API with pagination,
 * then filter client-side for Swiss locations.
 */
async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('\u26a0\ufe0f Failed to fetch Workday listings.');
      break;
    }

    allPostings.push(...data.jobPostings);

    if (allPostings.length >= (data.total || 0) || data.jobPostings.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;

    if (data.jobPostings.length === PAGE_SIZE) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const swissPostings = allPostings.filter((p) => isSwissLocation(p.locationsText));
  console.log(`  \ud83c\udfaf Filtered ${allPostings.length} total \u2192 ${swissPostings.length} Swiss jobs`);
  return swissPostings;
}

/**
 * Fetch full detail for a single job posting.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

/* ── Location & Canton ────────────────────────────────────── */

/**
 * Parse city name from Workday location text like "CH - Sierre".
 */
function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  const match = cleaned.match(/-\s*(.+)$/);
  return match ? match[1].trim() : cleaned;
}

function inferCanton(location = '') {
  const canton = inferSwissTargetCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('sierre') || loc.includes('sion') || loc.includes('visp') || loc.includes('viège') || loc.includes('valais')) return 'VS';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  return 'VS'; // Default to Valais — Constellium's main Swiss site is Sierre
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Constellium Valais Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllConstelliumJobs() {
  console.log(`\ud83d\udd0d Fetching Constellium Valais jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland (all Swiss locations)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('\u26a0\ufe0f No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  \ud83d\udccb Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  \ud83d\udcc4 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);

    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) {
      console.log(`  \u23ed\ufe0f  Skipped \u2014 empty title`);
      continue;
    }

    const locationRaw = info.location || listing.locationsText || '';
    let city = parseWorkdayLocation(locationRaw);
    if (!city) city = 'Sierre';

    const canton = inferCanton(city);
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;

    const descText = descriptionText
      ? `${descriptionText}\n\nConstellium Valais SA is a global leader in aluminium products and solutions, with a major rolling and recycling facility in Sierre (Valais), Switzerland. The company serves aerospace, automotive, packaging, and defence markets.`.trim()
      : `${title} position at Constellium Valais in ${city}, Switzerland.\n\nConstellium Valais SA is a global leader in aluminium products and solutions, with a major rolling and recycling facility in Sierre (Valais), Switzerland. The company serves aerospace, automotive, packaging, and defence markets.`.trim();

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} constellium ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || listing.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      id: `constellium-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CONSTELLIUM_COMPANY_NAME,
      companyKey: CONSTELLIUM_KEY,
      companyDomain: CONSTELLIUM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descText,
      descriptionByLocale: { [sourceLang]: descText },
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
      sector: 'Metallurgia / Alluminio',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      url: publicUrl,
      applyUrl: publicUrl,
      source: 'Constellium Valais Dedicated Parser (Workday)',
      sourceLang,
      crawledAt: new Date().toISOString(),
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n\ud83d\udccb Total unique Constellium Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
