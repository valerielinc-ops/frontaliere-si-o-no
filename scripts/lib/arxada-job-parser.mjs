#!/usr/bin/env node
/**
 * Arxada job parser — Workday API fetcher and job builder.
 *
 * Arxada (formerly part of Lonza) is a specialty chemicals company
 * headquartered in Basel with major production facilities in Visp (VS).
 * Their careers portal runs on Workday under the LSI (Lonza Specialty
 * Ingredients) tenant.
 *
 * Source: https://lsi.wd3.myworkdayjobs.com/Arxada_Careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllArxadaJobs()  — Fetch and parse all Swiss jobs
 *   - isArxadaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const WORKDAY_API_BASE = 'https://lsi.wd3.myworkdayjobs.com/wday/cxs/lsi/Arxada_Careers';
const WORKDAY_PUBLIC_BASE = 'https://lsi.wd3.myworkdayjobs.com/en/Arxada_Careers';
const WORKDAY_HOST = 'lsi.wd3.myworkdayjobs.com';

const PAGE_SIZE = 20;

export const ARXADA_KEY = 'arxada';
export const ARXADA_COMPANY_NAME = 'Arxada';
export const ARXADA_COMPANY_DOMAIN = 'arxada.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Arxada.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isArxadaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ARXADA_KEY ||
    key.startsWith('arxada') ||
    company.includes('arxada') ||
    url.includes('arxada.com') ||
    url.includes('lsi.wd3.myworkdayjobs.com')
  );
}

/**
 * Validate that a URL belongs to Arxada's domain or Workday host.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'arxada.com' ||
      host.endsWith('.arxada.com') ||
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
  if (/\b(chem|laborat|lab\b|analyt|spectro|chromato|synthes)/.test(t)) return 'Chimica';
  if (/\b(ingegner|engineer|entwickl|anlage)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|schlosser|fitter|rohr|pipe)/.test(t)) return 'Tecnica';
  if (/\b(manufactur|production|batch|process|operat|schicht)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality|valid|qualif)/.test(t)) return 'Qualita';
  if (/\b(scientist|research|r&d|innovation|forsch)/.test(t)) return 'Ricerca';
  if (/\b(safety|ehs|environment|health\s*&?\s*safety|umwelt|sicherheit)/.test(t)) return 'EHS';
  if (/\b(supply\s*chain|logist|warehous|lager|magazz|procurement|purchas|rangier)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm|digital|automat|cloud|data|cyber)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account|specialist|sachbearbeit)/.test(t)) return 'Amministrazione';
  if (/\b(sales|commercial|verkauf|vendita|business\s*develop)/.test(t)) return 'Commerciale';
  if (/\b(project|programme|program|projekt)/.test(t)) return 'Project Management';
  if (/\b(mainten|instandhalt|wartung)/.test(t)) return 'Manutenzione';
  if (/\b(hr|human|recruit|people|talent|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finanz|finance|financ|controller|audit)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|compliance|regulator|recht)/.test(t)) return 'Legale';
  if (/\b(manag|director|head|lead|chief|vp\b|leiter|supervisor|supv|chef|verantwort)/.test(t)) return 'Management';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|principal|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full') || t.includes('vollzeit') || t.includes('100%')) return 'FULL_TIME';
  if (t.includes('part') || t.includes('teilzeit') || /\d{2,3}\s*%/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
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
        'Accept-Language': 'en,de-CH;q=0.9',
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
 * Arxada's Workday tenant (LSI) doesn't support server-side country
 * filtering, so we fetch all listings and filter client-side.
 */
function isSwissLocation(locationsText = '') {
  const loc = normalize(locationsText);
  return (
    loc.startsWith('ch ') ||
    loc.startsWith('ch-') ||
    loc.includes('switzerland') ||
    loc.includes('schweiz') ||
    loc.includes('suisse') ||
    loc.includes('visp') ||
    loc.includes('basel') ||
    loc.includes('zürich') ||
    loc.includes('zurich') ||
    loc.includes('bern') ||
    loc.includes('genev') ||
    loc.includes('lausanne')
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

  // Client-side filter: only Swiss locations
  const swissPostings = allPostings.filter((p) => isSwissLocation(p.locationsText));
  console.log(`  \ud83c\udfaf Filtered ${allPostings.length} total → ${swissPostings.length} Swiss jobs`);
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
 * Parse city name from Workday location text like "CH - Visp".
 */
function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  // Workday format: "CH - Visp" or "CH - Basel"
  const match = cleaned.match(/-\s*(.+)$/);
  return match ? match[1].trim() : cleaned;
}

function inferCanton(location = '') {
  const canton = inferSwissTargetCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('visp') || loc.includes('viège') || loc.includes('viege')) return 'VS';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  return 'VS'; // Default to Valais — Arxada's main Swiss site is Visp
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Arxada Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllArxadaJobs() {
  console.log(`\ud83d\udd0d Fetching Arxada jobs from Workday API`);
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
      console.log(`  \u23ed\ufe0f  Skipped — empty title`);
      continue;
    }

    // Extract city from Workday location text
    const locationRaw = info.location || listing.locationsText || '';
    let city = parseWorkdayLocation(locationRaw);
    if (!city) city = 'Visp';

    const canton = inferCanton(city);
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}${externalPath}`;

    // Build source-locale description with company context
    const descText = descriptionText
      ? `${descriptionText}\n\nArxada is a global specialty chemicals company with major production facilities in Visp (Valais), Switzerland. The company develops innovative solutions for microbial control, nutrition, care, and environmental applications.`.trim()
      : `${title} position at Arxada in ${city}, Switzerland.\n\nArxada is a global specialty chemicals company with major production facilities in Visp (Valais), Switzerland. The company develops innovative solutions for microbial control, nutrition, care, and environmental applications.`.trim();

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} arxada ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || listing.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    // ParsedJob contract: only set source-locale fields.
    // Other locales are filled by mergePreserveLocaleData (preserves previous runs)
    // and translate-pending pipeline (AI translation for missing locales).
    const job = {
      id: `arxada-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ARXADA_COMPANY_NAME,
      companyKey: ARXADA_KEY,
      companyDomain: ARXADA_COMPANY_DOMAIN,
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
      sector: 'Chimica / Specialty Chemicals',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      url: publicUrl,
      applyUrl: publicUrl,
      source: 'Arxada Dedicated Parser (Workday)',
      sourceLang,
      crawledAt: new Date().toISOString(),
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n\ud83d\udccb Total unique Arxada jobs discovered: ${jobs.length}`);
  return jobs;
}
