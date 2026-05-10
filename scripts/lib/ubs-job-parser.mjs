#!/usr/bin/env node
/**
 * UBS job parser — Taleo ATS API (jobs.ubs.com).
 *
 * UBS uses Oracle Taleo for recruitment. The public-facing career portal
 * at jobs.ubs.com exposes an Angular app backed by REST-like AJAX endpoints.
 *
 * Flow:
 *   1. GET the search page to obtain session cookies + CSRF token (RFT)
 *   2. POST /TgNewUI/Search/Ajax/MatchedJobs with city facet filter
 *      for Valais-area cities (Brig, Visp, Sion, Martigny, etc.)
 *   3. Parse the Jobs.Job[] array from the response
 *
 * Each job in the search results includes: reqid, jobtitle, jobdescription,
 * formtext23 (region), formtext2 (city), department, formtext21 (category),
 * lastupdated, jobreqlanguage, formtext22 (job type).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllUbsJobs()  — Fetch and parse all jobs
 *   - isUbsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UBS_KEY = 'ubs';
export const UBS_COMPANY_NAME = 'UBS';
export const UBS_COMPANY_DOMAIN = 'ubs.com';

/** Taleo search page — used to bootstrap session + CSRF token */
const SEARCH_PAGE_URL =
  'https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5012&PageType=searchResults';

/** Taleo MatchedJobs endpoint */
const MATCHED_JOBS_URL = 'https://jobs.ubs.com/TgNewUI/Search/Ajax/MatchedJobs';

/** Taleo partner/site identifiers */
const PARTNER_ID = '25008';
const SITE_ID = '5012';

/**
 * Cathedral CH-wide expansion (2026-05-10):
 * The parser no longer applies a Taleo `formtext2` city facet — instead we
 * fetch ALL Swiss UBS jobs (the Taleo result set is naturally Swiss because
 * jobs.ubs.com siteid 5012 IS UBS Switzerland) and let the downstream
 * `canton-quorum-gate` (BFS-strict + 2-of-3) tag each job's canton. This
 * unlocks per-canton URLs for ZH, GE, BS, BE, … without hard-coding a city
 * list.
 */

/** Taleo language code → ISO 639-1 */
const TALEO_LANG_MAP = { 1: 'en', 23: 'de', 34: 'fr', 6: 'it' };

/** Postal codes for Valais cities */
const VS_POSTAL_CODES = {
  brig: '3900',
  crans: '3963',
  gstaad: '3780',
  martigny: '1920',
  naters: '3904',
  sion: '1950',
  sierre: '3960',
  susten: '3952',
  'susten-leuk': '3952',
  visp: '3930',
  zermatt: '3920',
  monthey: '1870',
  verbier: '1936',
  'saas-fee': '3906',
  leuk: '3952',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract a named field from the Taleo Questions array.
 * Each job in the Taleo response has a Questions[] array where
 * each entry has { QuestionName, Value }.
 */
function getField(questions = [], name = '') {
  const q = questions.find((q) => q.QuestionName === name);
  return q?.Value || '';
}

/**
 * Parse Taleo date format "DD-MMM-YYYY" → "YYYY-MM-DD".
 * e.g. "08-Apr-2026" → "2026-04-08"
 */
function parseTaleoDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Build public job detail URL on the Taleo portal.
 */
function buildJobUrl(reqId) {
  return `https://jobs.ubs.com/TGnewUI/Search/Home/HomeWithPreLoad?partnerid=${PARTNER_ID}&siteid=${SITE_ID}&jobid=${encodeURIComponent(reqId)}&PageType=jobdetails`;
}

/**
 * Infer postal code from city name. Returns '' when the city is not a
 * Valais branch we know about; the crawler normalisation step uses
 * COMPANY_HQ defaults (UBS HQ = Zürich 8001 post-Cathedral) instead.
 */
function inferPostalCode(city = '') {
  return VS_POSTAL_CODES[normalize(city)] || '';
}

/**
 * Extract the first/primary city from a potentially multi-city string.
 * e.g. "Brig, Naters, Susten, Susten-Leuk, Visp, Zermatt" → "Brig".
 * Returns '' when the source field is empty (canton-quorum-gate handles
 * blank locations downstream).
 */
function primaryCity(cityStr = '') {
  return normalizeSpace(cityStr.split(',')[0]);
}

/**
 * Infer canton from the city + region string.
 * Taleo formtext23 uses patterns like "Schweiz - Zürich", "Suisse - Genève",
 * "Schweiz - Valais". CH-wide post-Cathedral: detect all 26 cantons via
 * canton names (DE/FR/IT/EN aliases) before falling back to the shared
 * inference helper. Returns '' when undetermined — canton-quorum-gate
 * downstream handles blank canton tags.
 */
function inferCanton(city = '', region = '') {
  const lower = normalize(`${city} ${region}`);
  // Region-string canton heuristics — Taleo uses "Schweiz - {Canton}".
  if (lower.includes('valais') || lower.includes('wallis')) return 'VS';
  if (lower.includes('zurich') || lower.includes('zürich') || lower.includes('zuerich')) return 'ZH';
  if (lower.includes('geneva') || lower.includes('geneve') || lower.includes('genève') || lower.includes('genf')) return 'GE';
  if (lower.includes('basel-stadt') || lower.includes('bâle-ville')) return 'BS';
  if (lower.includes('basel-land') || lower.includes('bâle-campagne')) return 'BL';
  if (lower.includes('vaud') || lower.includes('waadt')) return 'VD';
  if (lower.includes('ticino') || lower.includes('tessin')) return 'TI';
  if (lower.includes('graub') || lower.includes('grigion') || lower.includes('grisons')) return 'GR';
  if (lower.includes('bern') || lower.includes('berne')) return 'BE';
  if (lower.includes('lucerne') || lower.includes('luzern')) return 'LU';
  if (lower.includes('aargau') || lower.includes('argovi')) return 'AG';
  if (lower.includes('st.gall') || lower.includes('saint-gall') || lower.includes('san gallo')) return 'SG';
  if (lower.includes('fribourg') || lower.includes('freiburg') || lower.includes('friburgo')) return 'FR';
  if (lower.includes('neuchât') || lower.includes('neuchat') || lower.includes('neuenburg')) return 'NE';
  if (lower.includes('jura')) return 'JU';
  if (lower.includes('schaffhaus')) return 'SH';
  if (lower.includes('thurgau') || lower.includes('thurgovie')) return 'TG';
  if (lower.includes('solothurn') || lower.includes('soleure')) return 'SO';
  if (lower.includes('schwyz')) return 'SZ';
  if (lower.includes('zug') || lower.includes('zoug')) return 'ZG';
  if (lower.includes('uri')) return 'UR';
  if (lower.includes('glarus') || lower.includes('glaris')) return 'GL';
  if (lower.includes('appenzell-ausserrhoden') || lower.includes('appenzell ar')) return 'AR';
  if (lower.includes('appenzell-innerrhoden') || lower.includes('appenzell ai')) return 'AI';
  if (lower.includes('obwalden')) return 'OW';
  if (lower.includes('nidwalden')) return 'NW';
  // Gstaad is in Berne (BE).
  if (lower.includes('gstaad')) return 'BE';
  // Try the shared inference function (returns a canton code or null).
  return inferAnyCanton(city) || inferAnyCanton(region) || '';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to UBS.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isUbsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === UBS_KEY ||
    key.startsWith('ubs') ||
    company.includes('ubs') ||
    url.includes('ubs.com')
  );
}

/**
 * Validate that a URL belongs to UBS's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ubs.com' || host.endsWith('.ubs.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(categoryStr = '', title = '') {
  const t = normalize(`${categoryStr} ${title}`);
  if (/\b(kundenberatung|client\s*advis|relationship\s*manag|conseil.*client)/.test(t)) return 'Commerciale';
  if (/\b(geschäftsstelle|branch|filial)/.test(t)) return 'Commerciale';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|verwaltung|administrat)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm|data|digital)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|wealth|asset|invest|trading|portfolio)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|compliance)/.test(t)) return 'Legale';
  if (/\b(audit|risk|control)/.test(t)) return 'Finanza';
  return 'Finanza'; // Default for a bank
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|talent\s*program)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(jobTypeStr = '', title = '') {
  const t = normalize(`${jobTypeStr} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(tempor|contract|befristet|cdd)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── Taleo Session Bootstrap ──────────────────────────────── */

/**
 * Fetch the Taleo search page to obtain session cookies and the
 * CSRF token (__RequestVerificationToken / RFT).
 *
 * Returns { cookies, rft } or throws on failure.
 */
async function bootstrapSession() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(SEARCH_PAGE_URL, {
      method: 'GET',
      headers: {
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        Accept: 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Failed to load Taleo search page: HTTP ${res.status}`);
    }

    // Extract cookies from response headers
    const setCookieHeaders = res.headers.getSetCookie?.() || [];
    const cookieStr = setCookieHeaders
      .map((h) => h.split(';')[0])
      .join('; ');

    // Extract RFT from HTML
    const html = await res.text();
    const rftMatch = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
    if (!rftMatch) {
      throw new Error('Could not extract CSRF token (RFT) from Taleo page');
    }

    return { cookies: cookieStr, rft: rftMatch[1] };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── API Client ────────────────────────────────────────────── */

/**
 * Call the Taleo MatchedJobs endpoint with optional pagination.
 *
 * Cathedral CH-wide expansion (2026-05-10): no city facet is applied —
 * the unfiltered result on jobs.ubs.com siteid=5012 is the full Swiss
 * UBS tenant across 26 cantons.
 *
 * @param {string} cookies - Session cookies from bootstrapSession
 * @param {string} rft - CSRF token from bootstrapSession
 * @param {object} [options]
 * @param {number} [options.startRow=0] First (0-indexed) row to return
 * @param {number} [options.endRow=25]  Last (exclusive) row to return
 * @returns {Promise<{jobs: object[], totalCount: number}>}
 */
async function searchJobs(cookies, rft, { startRow = 0, endRow = 25 } = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    PartnerId: PARTNER_ID,
    SiteId: SITE_ID,
    Keyword: '',
    Location: '',
    KeywordCustomSolrFields: '',
    LocationCustomSolrFields: '',
    // No facet filter — fetch the full Swiss tenant result set.
    FacetFilterFields: { Facet: [] },
    TurnOffHttps: false,
    Latitude: 0,
    Longitude: 0,
    PowerSearchOptions: { PowerSearchOption: [] },
    encryptedsessionvalue: '',
    StartRow: startRow,
    EndRow: endRow,
  };

  try {
    const res = await fetch(MATCHED_JOBS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Cookie: cookies,
        RFT: rft,
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Taleo MatchedJobs API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const jobList = data?.Jobs?.Job || [];
    const totalCount = data?.JobsCount || 0;

    return { jobs: jobList, totalCount };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Job Builder ──────────────────────────────────────────── */

/**
 * Build a ParsedJob from a Taleo search result entry.
 */
function buildJobFromTaleo(taleoJob) {
  const questions = taleoJob?.Questions || [];

  const reqId = getField(questions, 'reqid');
  const title = normalizeSpace(stripHtml(getField(questions, 'jobtitle')));
  const descriptionHtml = getField(questions, 'jobdescription');
  const region = normalizeSpace(getField(questions, 'formtext23'));
  const cityStr = normalizeSpace(getField(questions, 'formtext2') || '');
  const department = normalizeSpace(getField(questions, 'department'));
  const categoryStr = normalizeSpace(getField(questions, 'formtext21'));
  const jobType = normalizeSpace(getField(questions, 'formtext22'));
  const lastUpdated = getField(questions, 'lastupdated');
  const langCode = getField(questions, 'jobreqlanguage');

  if (!title || title.length < 3) return null;
  if (!reqId) return null;

  const city = primaryCity(cityStr);
  const canton = inferCanton(city, region);
  const descriptionText = normalizeSpace(stripHtml(descriptionHtml));
  const publicUrl = buildJobUrl(reqId);

  // Detect source language: use Taleo's language code, fallback to content detection
  const taleoLang = TALEO_LANG_MAP[Number(langCode)];
  const sourceLang = taleoLang || detectLang(descriptionText || title, 'de');

  const jobSlug = slugify(`${title} ubs ${city}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const postedDate = parseTaleoDate(lastUpdated) || new Date().toISOString().slice(0, 10);

  return {
    // ── Required fields ──
    id: `ubs-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: UBS_COMPANY_NAME,
    companyKey: UBS_KEY,
    companyDomain: UBS_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — UBS`,
    descriptionByLocale: { [sourceLang]: descriptionText || `${title} — UBS` },
    location: city,
    canton,
    url: publicUrl,
    source: 'UBS Dedicated Parser (Taleo API)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: city,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: inferPostalCode(city),
    category: detectCategory(categoryStr, title),
    contract: 'full-time',
    employmentType: detectEmploymentType(jobType, title),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Finanza / Banca',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },

    // ── Internal metadata ──
    _ubsMeta: {
      reqId,
      department,
      region,
      cities: cityStr,
      categoryRaw: categoryStr,
      jobType,
    },
  };
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all UBS jobs across Switzerland (26 cantons, no city facet).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Cathedral CH-wide expansion (2026-05-10): the city facet was removed —
 * we paginate the full tenant result set in 25-row windows. The
 * canton-quorum-gate (BFS-strict + 2-of-3) downstream classifies each
 * job's canton for per-canton URL routing.
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllUbsJobs() {
  console.log(`🔍 Fetching UBS jobs from Taleo API (CH-wide, all 26 cantons)`);
  console.log(`   Portal: ${SEARCH_PAGE_URL}\n`);

  // Step 1: Bootstrap session (cookies + CSRF token)
  console.log('  🔐 Bootstrapping Taleo session...');
  const { cookies, rft } = await bootstrapSession();
  console.log('  ✅ Session established\n');

  // Step 2: Paginated walk of the whole Swiss tenant.
  console.log('  📄 Searching for all Swiss UBS jobs (paginated)...');
  const PAGE_SIZE = 25;
  const MAX_PAGES = 100; // Hard cap = 2,500 jobs (UBS Switzerland posts ~700-1,200 simultaneously).
  const allTaleoJobs = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const startRow = page * PAGE_SIZE;
    const endRow = startRow + PAGE_SIZE;
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await searchJobs(cookies, rft, { startRow, endRow });
    } catch (err) {
      console.warn(`  ⚠️ Page ${page} (rows ${startRow}-${endRow}) failed: ${err?.message || err}`);
      break;
    }
    const { jobs: pageJobs, totalCount } = res;
    if (page === 0) total = totalCount;
    if (!pageJobs.length) break;
    allTaleoJobs.push(...pageJobs);
    console.log(`    page ${page + 1}: +${pageJobs.length} (running total ${allTaleoJobs.length}/${total || '?'})`);
    if (allTaleoJobs.length >= total && total > 0) break;
    // Polite delay between pages.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  📋 Taleo returned ${allTaleoJobs.length} jobs (reported total: ${total})\n`);

  if (!allTaleoJobs.length) {
    console.warn('⚠️ No job listings returned from Taleo.');
    return [];
  }

  // Step 3: Build ParsedJob objects
  const jobs = [];
  for (const taleoJob of allTaleoJobs) {
    const job = buildJobFromTaleo(taleoJob);
    if (job) {
      jobs.push(job);
    }
  }

  console.log(`\n📋 Total UBS Swiss jobs: ${jobs.length}`);
  return jobs;
}
