#!/usr/bin/env node
/**
 * Dedicated Swisscom crawler runner (CH-wide; legacy key 'swisscom-sede-ticino').
 *
 * Swisscom is the leading Swiss telecom company with offices across Switzerland,
 * including several locations in Ticino (Bellinzona, Grancia, Balerna, S. Antonino).
 *
 * The Swisscom careers site uses Workday (myworkdayjobs.com) with a REST API:
 *   - Listing: POST /wday/cxs/swisscom/SwisscomExternalCareers/jobs
 *   - Detail:  GET  /wday/cxs/swisscom/SwisscomExternalCareers/job/{externalPath}
 *
 * Discovery flow:
 *   1. Paginate all Swiss jobs from Workday API (max 20 per page)
 *   2. Filter for target-area jobs (listing-level location check)
 *   3. Fetch full job detail for each target-area listing
 *   4. Build job objects with canonical Workday URLs
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
  stableSlugHash,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseSwisscomJobDescription } from './lib/swisscom-job-parser.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const SWISSCOM_KEY = 'swisscom-sede-ticino';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(SWISSCOM_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const SWISSCOM_COMPANY_NAME = 'Swisscom (sede Ticino)';
const SWISSCOM_COMPANY_HOST = 'swisscom.wd103.myworkdayjobs.com';
const SWISSCOM_API_BASE = 'https://swisscom.wd103.myworkdayjobs.com/wday/cxs/swisscom/SwisscomExternalCareers';
const SWISSCOM_PUBLIC_BASE = 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#64;/g, '@')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSwisscomJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === SWISSCOM_KEY ||
    key === 'swisscom' ||
    key.startsWith('swisscom') ||
    company.includes('swisscom') ||
    url.includes('swisscom.wd103.myworkdayjobs.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === SWISSCOM_COMPANY_HOST || host.endsWith('.myworkdayjobs.com');
  } catch {
    return false;
  }
}

function isSwissLocation(locText = '') {
  return isTargetSwissLocation(locText);
}

// ─────────────────────────────────────────────────────────────
// Workday API
// ─────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...options.headers,
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List all Swiss Swisscom jobs via Workday API, then keep CH-wide (all 26 cantons).
 * Workday caps limit at 20, so we paginate with offset. We stop on a short/empty
 * page (the genuine end of results) and use the first page's `total` only as a
 * positive upper bound: an unfiltered Workday query (appliedFacets:{}) can echo
 * total:0 alongside a full page of postings, so we never break on
 * `length >= total` when total is 0 (that would drop every posting on pages 2+).
 * A page cap bounds the loop if a tenant never shortens.
 */
async function listTicinoJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;
  let total = 0;
  let pages = 0;
  const MAX_PAGES = 100;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: {},
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${SWISSCOM_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    if (offset === 0) {
      total = data.total || 0;
      console.log(`  📊 Total Swiss jobs in portal: ${total}`);
    }

    allPostings.push(...data.jobPostings);
    pages += 1;

    // Stop on a short/empty page. Trust `total` as an upper bound ONLY when
    // positive: an unfiltered query echoing total:0 with a full page must not
    // break here, or every posting on pages 2+ is silently dropped.
    if (data.jobPostings.length < limit) break;
    if (total > 0 && allPostings.length >= total) break;
    if (pages >= MAX_PAGES) {
      console.warn(`⚠️ Reached pagination safety cap (${MAX_PAGES} pages); stopping.`);
      break;
    }
    offset += limit;
    // Small delay between pages to be polite
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`  📋 Fetched ${allPostings.length} job listings across all pages`);

  // Filter TI/GR-based jobs
  const relevantPostings = allPostings.filter(p =>
    isSwissLocation(p.locationsText || '')
  );

  const tiCount = relevantPostings.filter(p => inferCanton(p.locationsText || '') === 'TI').length;
  const grCount = relevantPostings.filter(p => inferCanton(p.locationsText || '') === 'GR').length;
  console.log(`  🎯 CH jobs kept: ${relevantPostings.length} (TI: ${tiCount}, GR: ${grCount}, others: ${relevantPostings.length - tiCount - grCount})`);
  for (const p of relevantPostings) {
    console.log(`     - ${p.title} (${p.locationsText}) [${inferCanton(p.locationsText || '')}]`);
  }

  return relevantPostings;
}

/**
 * Fetch full detail for a single job via Workday API.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${SWISSCOM_API_BASE}${externalPath}`);
}

// ─────────────────────────────────────────────────────────────
// Location & canton mapping
// ─────────────────────────────────────────────────────────────

function parseWorkdayLocation(locText = '') {
  // Swisscom location format is just the city name (e.g. "Bellinzona", "S. Antonino")
  return String(locText || '').trim();
}

function inferCanton(location = '') {
  const inferred = inferAnyCanton(location);
  if (inferred) return inferred;
  const loc = normalize(location);
  // Non-Ticino fallbacks
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('lausanne')) return 'VD';
  return 'TI'; // Default to TI for unrecognized locations
}

// ─────────────────────────────────────────────────────────────
// Job building
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|sviluppat|it\b|system|data|devops|cyber|network|informatico|mediamatico|digitale/i.test(t)) return 'technology';
  if (/qa|quality|validation|compliance|regulator/i.test(t)) return 'quality';
  if (/scientist|research|r&d|laboratory|lab\b|clinical/i.test(t)) return 'science';
  if (/produc|manufactur|operator|technic|tecnico/i.test(t)) return 'production';
  if (/sales|commercial|commercio|marketing|brand|communication|comunicazione/i.test(t)) return 'sales';
  if (/legal|counsel|lawyer|giuridico/i.test(t)) return 'legal';
  if (/account|financ|controller|audit|contabil/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent|personale/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse|procurement|buyer|magazzin/i.test(t)) return 'logistics';
  if (/field\s*service|service\s*tech|maintenance|install|manutenzione/i.test(t)) return 'service';
  if (/manag|director|head|lead|chief|vp\b|responsabil/i.test(t)) return 'management';
  if (/\b(apprendist|apprenti|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagist|lehrstelle)/i.test(t)) return 'internship';
  if (/impiegat|clerk|office|ufficio/i.test(t)) return 'administration';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(junior|jr\.?|entry|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagist|apprendist|apprenti|afc|efc)/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

function buildFallbackDescription(title, descriptionText, location) {
  const base = descriptionText || `Posizione aperta presso Swisscom a ${location}.`;
  if (!base) return '';
  if (base.startsWith('# ')) return base;
  if (!title) return base;
  return `# ${title}\n\n${base}`.trim();
}

/**
 * Build a canonical public URL for a Workday job.
 * Format: https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/{path}
 */
function buildPublicUrl(externalPath) {
  return `${SWISSCOM_PUBLIC_BASE}${externalPath}`;
}

/**
 * Build a regenerated Swisscom slug with a stable per-vacancy disambiguator
 * suffix.
 *
 * Swisscom publishes the same apprenticeship/role across multiple Ticino
 * cities (e.g. R-0002524 Bellinzona, R-0002525 Grancia, R-0002527 Balerna for
 * the same "Apprendistato Impiegato/a del commercio al dettaglio AFC"). The
 * previous formula `slugify(title, swisscom-{city})` did include the city,
 * but the crawler did not set per-job `addressLocality`, so
 * `applyCompanyDefaults` filled it with the hardcoded HQ city `Bellinzona`
 * and `hardenJobLocaleFields` re-derived the slug from
 * `[title, company, addressLocality]` collapsing every per-city slug to one.
 *
 * The audit at /tmp/housekeeping-audit-2026-04-07.md identified 4 silent
 * losses in swisscom-sede-ticino over 30 days from this exact pattern.
 *
 * `stableSlugHash(job)` derives a 6-char hash from `fingerprintJob(job)`,
 * which on Swisscom Workday URLs returns
 * `id|myworkdayjobs.com|{title-and-jobreqid}` so each vacancy gets a unique
 * deterministic suffix that survives across crawl runs and across
 * `hardenJobLocaleFields` slug refresh cycles.
 *
 * Pure function: no I/O, no module-level state. Exported for tests.
 *
 * @param {object} job - Job-like object with at least { title, url } populated
 * @param {string} city - Resolved Swisscom city (e.g. "Bellinzona")
 * @returns {string} Regenerated slug, length-capped at 90 chars
 */
export function buildSwisscomRegeneratedSlug(job, city) {
  const suffix = stableSlugHash(job) || '';
  const baseInput = `${job?.title || ''}-swisscom-${city || ''}`;
  const baseSlug = baseInput
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!baseSlug) return '';
  if (!suffix) return truncateSlugAtWordBoundary(baseSlug, 200);
  const baseMaxLen = Math.max(0, 90 - (suffix.length + 1));
  const trimmedBase = truncateSlugAtWordBoundary(baseSlug, baseMaxLen).replace(/-+$/, '');
  return trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
}

/**
 * Build a normalized Swisscom job from a Workday listing + detail pair.
 *
 * Pure function: no I/O, no network. Exported for tests so the slug
 * disambiguation behaviour can be exercised end-to-end without hitting the
 * Workday API.
 *
 * Critical: ALWAYS sets `addressLocality` to the per-job city. Without this,
 * `applyCompanyDefaults` overwrites it with the hardcoded
 * `COMPANY_DEFAULTS['swisscom-sede-ticino'].addressLocality = 'Bellinzona'`,
 * triggering the `hardenJobLocaleFields` slug-collision regression.
 *
 * @param {object} listing - Workday job posting summary (title, externalPath, locationsText)
 * @param {object} detail - Workday job detail payload (jobPostingInfo)
 * @returns {object} Normalized job object ready for the merge step
 */
export function buildSwisscomJob(listing = {}, detail = {}) {
  const info = detail?.jobPostingInfo || {};
  const title = normalizeSpace(info.title || listing.title || '');
  const externalPath = listing.externalPath || '';
  const locationRaw = info.location || listing.locationsText || '';
  const city = parseWorkdayLocation(locationRaw);
  const canton = inferCanton(city);

  const descriptionHtml = info.jobDescription || '';
  const descriptionText = stripHtml(descriptionHtml);
  const parsedDescription = parseSwisscomJobDescription(descriptionHtml, title);
  const publicUrl = buildPublicUrl(externalPath);

  const descIt = parsedDescription.description || buildFallbackDescription(title, descriptionText, city);
  const reqIt = Array.isArray(parsedDescription.requirements) ? parsedDescription.requirements : [];

  const slug = buildSwisscomRegeneratedSlug({ title, url: publicUrl }, city);
  const employmentType = detectEmploymentType(info.timeType || '');
  const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

  const job = {
    url: publicUrl,
    applyUrl: publicUrl,
    title,
    company: SWISSCOM_COMPANY_NAME,
    companyKey: SWISSCOM_KEY,
    location: city,
    addressLocality: city,
    canton,
    country: 'CH',
    description: descIt,
    descriptionByLocale: {
      it: descIt,
    },
    requirements: reqIt,
    requirementsByLocale: {
      it: reqIt,
    },
    titleByLocale: {
      it: title,
    },
    slug,
    slugByLocale: {
      it: slug,
      en: slug,
    },
    category: detectCategory(title),
    datePosted: info.startDate || new Date().toISOString().split('T')[0],
    source: 'swisscom-workday-crawler',
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Tecnologia & IT',
    _targetScope: { canton, location: city },
    sourceLang: detectLang(descIt || title, 'it'),
  };

  if (jobReqId) {
    job.jobReqId = jobReqId;
  }

  return job;
}

// ─────────────────────────────────────────────────────────────
// Fetch and build all Swisscom Ticino jobs
// ─────────────────────────────────────────────────────────────

async function fetchSwisscomJobs() {
  console.log(`🔍 Fetching Swisscom jobs from Workday API`);
  console.log(`   API: ${SWISSCOM_API_BASE}/jobs`);

  const listings = await listTicinoJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No TI/GR job listings found.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);
    // Small delay between detail fetches
    await new Promise(r => setTimeout(r, 200));

    const job = buildSwisscomJob(listing, detail);
    if (!job.title || job.title.length < 3) {
      console.log(`  ⏭️  Skipped — empty title`);
      continue;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total Swisscom TI/GR jobs discovered: ${jobs.length}`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

async function mergeSwisscomJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(SWISSCOM_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonSwisscomJobs = allJobs.filter((j) => !isSwisscomJob(j));
  const existingSwisscomJobs = allJobs.filter(isSwisscomJob);

  const existingKeys = new Set(existingSwisscomJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a Workday title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699). It also already
  // merges requirementsByLocale/titleByLocale/descriptionByLocale/
  // slugByLocale generically, so the bespoke per-field merges below are
  // superseded.
  const merged = mergePreserveLocaleData(existingSwisscomJobs, discoveredJobs).map((job) => ({
    ...job,
    company: SWISSCOM_COMPANY_NAME,
    companyKey: SWISSCOM_KEY,
    country: 'CH',
    source: 'swisscom-workday-crawler',
  }));

  const final = [...nonSwisscomJobs, ...merged];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${SWISSCOM_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = SWISSCOM_KEY;
  adapter.companyName = SWISSCOM_COMPANY_NAME;
  adapter.companyHost = SWISSCOM_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  adapter.seedUrls = [`${SWISSCOM_PUBLIC_BASE}`];
  adapter.notes = 'Workday REST API at swisscom.wd103.myworkdayjobs.com — all Swiss jobs paginated, then filtered for TI + GR cities.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${SWISSCOM_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: SWISSCOM_KEY,
    localizeOnlyCompanyKeys: SWISSCOM_KEY,
    forceLocalizeKeys: SWISSCOM_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessSwisscomJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isSwisscomJob(job)) continue;

    if (job.company !== SWISSCOM_COMPANY_NAME) {
      job.company = SWISSCOM_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== SWISSCOM_KEY) {
      job.companyKey = SWISSCOM_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Bellinzona';
      fixed++;
    }
    // Mirror per-job city onto addressLocality so applyCompanyDefaults does
    // not overwrite it with the hardcoded HQ city — that overwrite is what
    // triggers hardenJobLocaleFields to collapse per-city slugs and silently
    // dedup losers in cleanup-jobs.mjs.
    if (!job.addressLocality && job.location) {
      job.addressLocality = job.location;
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} Swisscom jobs (fixed company/location/canton).`);
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const swisscomJobs = allJobs.filter(isSwisscomJob);

  console.log(`\n📊 === Swisscom (sede Ticino) Job Stats ===`);
  const tiJobs = swisscomJobs.filter(j => (j.canton || '').toUpperCase() === 'TI').length;
  const grJobs = swisscomJobs.filter(j => (j.canton || '').toUpperCase() === 'GR').length;
  console.log(`  🏢 Total Swisscom TI+GR jobs: ${swisscomJobs.length} (TI: ${tiJobs}, GR: ${grJobs})`);

  if (swisscomJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of swisscomJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(swisscomJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Swisscom Ticino');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Swisscom Ticino');
  return { total: swisscomJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SWISSCOM_STRICT',
    label: 'Swisscom Ticino',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isSwisscomJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_swisscom_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Swisscom TI/GR jobs found — the company may not have active TI/GR openings.',
    maxToleratedMissingDescriptions: 3,
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(SWISSCOM_KEY, 'Swisscom Ticino');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Swisscom (sede Ticino) — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Workday API: ${SWISSCOM_API_BASE}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(SWISSCOM_KEY, DATA_JOBS).filter(isSwisscomJob))

  // Phase 1: Fetch Ticino jobs from Workday API
  const discoveredJobs = await fetchSwisscomJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Swisscom TI/GR jobs discovered.');
    console.log('   The Workday API may be unreachable or have no TI/GR openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeSwisscomJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Swisscom jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessSwisscomJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Swisscom jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Swisscom (sede Ticino) crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isSwisscomJob) : [];
  writeJobsCrawlerSlice(SWISSCOM_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: SWISSCOM_KEY,
    label: 'Swisscom Ticino',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Only run main() when invoked as a script, not when imported by tests.
const isInvokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isInvokedDirectly) {
  main().catch((err) => exitCrawlerOnError(err, 'Swisscom'));
}
