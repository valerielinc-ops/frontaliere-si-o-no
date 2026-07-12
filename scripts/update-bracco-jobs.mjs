#!/usr/bin/env node
/**
 * Dedicated Bracco Suisse S.A. crawler runner.
 *
 * Bracco Group is an Italian multinational in healthcare/diagnostic imaging.
 * Bracco Suisse S.A. has offices in Cadempino (Ticino) and Plan-les-Ouates (Geneva).
 *
 * The Bracco careers site uses Workday (myworkdayjobs.com) with a REST API:
 *   - Listing: POST /wday/cxs/bracco/BraccoCareers/jobs
 *   - Detail:  GET  /wday/cxs/bracco/BraccoCareers/job/{externalPath}
 *
 * Discovery flow:
 *   1. Query Workday API for Swiss-location jobs (Cadempino + Plan-les-Ouates)
 *   2. Fetch full job detail for each listing
 *   3. Build job objects with canonical Workday URLs
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { isSwissLocationText } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRACCO_KEY = 'bracco';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(BRACCO_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const BRACCO_COMPANY_NAME = 'Bracco Suisse S.A.';
const BRACCO_COMPANY_HOST = 'bracco.wd103.myworkdayjobs.com';
const BRACCO_API_BASE = 'https://bracco.wd103.myworkdayjobs.com/wday/cxs/bracco/BraccoCareers';
const BRACCO_PUBLIC_BASE = 'https://bracco.wd103.myworkdayjobs.com/it-IT/BraccoCareers';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Switzerland detection — text-based via the authoritative shared helper
// (isSwissLocationText: country tokens + all-26-canton BFS municipality data),
// NOT brittle Workday location UUIDs. Workday recycles/renames location facet
// IDs whenever Bracco restructures sites (the old Cadempino/Plan-les-Ouates
// UUIDs would vanish from the facet list → 0 jobs). We instead fetch all Bracco
// postings and keep the ones whose location text resolves to Switzerland, so the
// crawler self-heals when Bracco adds/renames CH locations.

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
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
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isBraccoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === BRACCO_KEY ||
    key === 'bracco-suisse-s-a' ||
    key.startsWith('bracco') ||
    company.includes('bracco') ||
    url.includes('bracco.wd103.myworkdayjobs.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BRACCO_COMPANY_HOST || host.endsWith('.myworkdayjobs.com');
  } catch {
    return false;
  }
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
        'Accept-Language': 'en,it-CH;q=0.9',
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
 * List candidate Swiss Bracco postings via Workday API.
 *
 * We do NOT filter by Workday location facet IDs (they go stale whenever Bracco
 * restructures sites). Instead we page through ALL postings and keep:
 *   - single-location postings whose locationsText resolves to Switzerland;
 *   - multi-location postings (e.g. "2 Locations") whose Swiss membership can
 *     only be confirmed from the detail page → handed downstream for resolution.
 * Pagination uses limit/offset and stops on a short/empty page (the genuine end
 * of results). The first page's `total` is used only as a positive upper bound:
 * an unfiltered Workday query can echo total:0 alongside a full page of postings,
 * so we never break on `offset >= total` when total is 0 (that would drop every
 * posting on pages 2+). A page cap bounds the loop if a tenant never shortens.
 */
async function listSwissJobs() {
  const candidates = [];
  let offset = 0;
  let total = null;
  let pages = 0;
  const limit = 20;
  const MAX_PAGES = 100;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: {},
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${BRACCO_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    if (total === null) total = data.total || 0;
    pages += 1;

    for (const posting of data.jobPostings) {
      const locText = posting.locationsText || '';
      // Multi-location postings ("N Locations") hide individual sites — keep as
      // candidate and let fetchBraccoJobs() confirm via the detail page.
      if (/^\s*\d+\s+location/i.test(locText) || isSwissLocationText(locText)) {
        candidates.push(posting);
      }
    }

    offset += data.jobPostings.length;
    // Stop on a short/empty page. Trust `total` as an upper bound ONLY when
    // positive: an unfiltered query echoing total:0 with a full page must not
    // break here, or every posting on pages 2+ is silently dropped.
    if (data.jobPostings.length < limit) break;
    if (total > 0 && offset >= total) break;
    if (pages >= MAX_PAGES) {
      console.warn(`⚠️ Reached pagination safety cap (${MAX_PAGES} pages); stopping.`);
      break;
    }
  }

  return candidates;
}

/**
 * Fetch full detail for a single job via Workday API.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${BRACCO_API_BASE}${externalPath}`);
}

// ─────────────────────────────────────────────────────────────
// Location & canton mapping
// ─────────────────────────────────────────────────────────────

function parseWorkdayLocation(locText = '') {
  // Format: "CHE - Cadempino" or "CHE - Plan-les-Ouates"
  const cleaned = String(locText || '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  // last part is the city
  const city = parts.length > 1 ? parts.slice(1).join('-').trim() : cleaned;
  return city || cleaned;
}

function inferCanton(location = '') {
  const loc = normalize(location);
  if (loc.includes('cadempino')) return 'TI';
  if (loc.includes('plan-les-ouates') || loc.includes('plan les ouates')) return 'GE';
  if (loc.includes('lugano')) return 'TI';
  if (loc.includes('manno')) return 'TI';
  if (loc.includes('bellinzona')) return 'TI';
  if (loc.includes('locarno')) return 'TI';
  if (loc.includes('mendrisio')) return 'TI';
  if (loc.includes('chiasso')) return 'TI';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  return '';
}

// ─────────────────────────────────────────────────────────────
// Job building
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|it\b|system|data|devops|cyber|network/i.test(t)) return 'technology';
  if (/qa|quality|validation|compliance|regulator/i.test(t)) return 'quality';
  if (/scientist|research|r&d|laboratory|lab\b|clinical/i.test(t)) return 'science';
  if (/produc|manufactur|operator|technic/i.test(t)) return 'production';
  if (/sales|commercial|marketing|brand|communication/i.test(t)) return 'sales';
  if (/legal|counsel|lawyer/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse|procurement|buyer/i.test(t)) return 'logistics';
  if (/field\s*service|service\s*tech|maintenance|install/i.test(t)) return 'service';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/improv|lean|continuous|optimi/i.test(t)) return 'operations';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

function buildDescription(title, descriptionText, location) {
  const base = descriptionText || `${title} position at Bracco Suisse S.A. in ${location}, Switzerland.`;
  return `${base}\n\nBracco Suisse S.A. is part of the Bracco Group, an international leader in diagnostic imaging and healthcare. The company operates in Switzerland with offices in Cadempino (Ticino) and Plan-les-Ouates (Geneva).`.trim();
}

function buildDescriptionIt(title, location) {
  return `Posizione aperta presso Bracco Suisse S.A. a ${location}.\nRuolo: ${title}.\n\nBracco Suisse S.A. fa parte del Gruppo Bracco, leader internazionale nell'imaging diagnostico e nella sanità. L'azienda opera in Svizzera con sedi a Cadempino (Ticino) e Plan-les-Ouates (Ginevra).`.trim();
}

/**
 * Build a canonical public URL for a Workday job.
 * Format: https://bracco.wd103.myworkdayjobs.com/it-IT/BraccoCareers/job/{path}
 */
function buildPublicUrl(externalPath) {
  // externalPath is like "/job/CHE---Cadempino/FIELD-SERVICE-TECHNICIAN_"
  return `${BRACCO_PUBLIC_BASE}${externalPath}`;
}

// ─────────────────────────────────────────────────────────────
// Fetch and build all Bracco Swiss jobs
// ─────────────────────────────────────────────────────────────

async function fetchBraccoJobs() {
  console.log(`🔍 Fetching Bracco Suisse S.A. jobs from Workday API`);
  console.log(`   API: ${BRACCO_API_BASE}/jobs`);
  console.log(`   Keeping Swiss locations (Cadempino TI / Plan-les-Ouates GE / other CH) by location text\n`);

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

    // Resolve the Swiss city. Multi-location postings ("N Locations") only
    // reveal their real sites here, so we must confirm Switzerland membership
    // from the detail page rather than assuming a Swiss fallback.
    const additionalLocations = Array.isArray(info.additionalLocations)
      ? info.additionalLocations.map((l) => (typeof l === 'string' ? l : l?.descriptor || ''))
      : [];
    const locationCandidates = [
      info.location || '',
      ...additionalLocations,
      listing.locationsText || '',
    ];

    const swissLoc = locationCandidates.find((l) => isSwissLocationText(l));
    if (!swissLoc) {
      console.log(`  ⏭️  Skipped — not a Swiss location (${parseWorkdayLocation(info.location || listing.locationsText || '') || 'unknown'})`);
      continue;
    }

    let city = parseWorkdayLocation(swissLoc);
    // Bare country descriptor ("Switzerland") or empty → default to primary office.
    if (!city || /switzerland|schweiz|suisse|svizzera/i.test(city)) city = 'Cadempino';
    const canton = inferCanton(city);
    const country = 'CH';

    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);

    const descEn = buildDescription(title, descriptionText, city);
    const descIt = buildDescriptionIt(title, city);

    const slug = slugify(title, 'bracco-suisse');
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: BRACCO_COMPANY_NAME,
      companyKey: BRACCO_KEY,
      location: city,
      canton,
      country,
      description: descEn,
      descriptionByLocale: {
        en: descEn,
        it: descIt,
      },
      titleByLocale: {
        en: title,
      },
      slug,
      slugByLocale: {
        en: slug,
        it: slugify(title, 'bracco-suisse'),
      },
      category: detectCategory(title),
      datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'bracco-workday-crawler',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sourceLang: detectLang(descEn || title, 'en'),
      sector: 'Healthcare / Imaging diagnostico',
      _targetScope: { canton, location: city },
    };

    if (jobReqId) {
      job.jobReqId = jobReqId;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total unique Bracco jobs discovered: ${jobs.length}`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeBraccoJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(BRACCO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonBraccoJobs = allJobs.filter((j) => !isBraccoJob(j));
  const existingBraccoJobs = allJobs.filter(isBraccoJob);

  const existingKeys = new Set(
    existingBraccoJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingBraccoJobs, discoveredJobs).map((job) => ({
    ...job,
    company: BRACCO_COMPANY_NAME,
    companyKey: BRACCO_KEY,
    country: 'CH',
    source: 'bracco-workday-crawler',
  }));

  const final = [...nonBraccoJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${BRACCO_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = BRACCO_KEY;
  adapter.companyName = BRACCO_COMPANY_NAME;
  adapter.companyHost = BRACCO_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  // No location facet UUIDs in the seed: those go stale when Bracco restructures
  // sites. The runner fetches all postings and keeps Swiss ones by location text.
  adapter.seedUrls = [BRACCO_PUBLIC_BASE];
  adapter.notes = 'Workday REST API at bracco.wd103.myworkdayjobs.com — all postings fetched, Swiss ones (Cadempino TI / Plan-les-Ouates GE / other CH) kept by location text (no brittle location UUIDs).';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${BRACCO_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: BRACCO_KEY,
    localizeOnlyCompanyKeys: BRACCO_KEY,
    forceLocalizeKeys: BRACCO_KEY,
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

function postProcessBraccoJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isBraccoJob(job)) continue;

    if (job.company !== BRACCO_COMPANY_NAME) {
      job.company = BRACCO_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== BRACCO_KEY) {
      job.companyKey = BRACCO_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Cadempino';
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} Bracco jobs (fixed company/location/canton).`);
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
  const braccoJobs = allJobs.filter(isBraccoJob);

  console.log(`\n📊 === Bracco Suisse S.A. Job Stats ===`);
  console.log(`  🏢 Total Bracco jobs: ${braccoJobs.length}`);

  if (braccoJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of braccoJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(braccoJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Bracco Suisse');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Bracco Suisse');
  return { total: braccoJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BRACCO_STRICT',
    label: 'Bracco Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBraccoJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_bracco_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Bracco Suisse jobs found — the company may not have active Swiss openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(BRACCO_KEY, 'Bracco Suisse');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Bracco Suisse S.A. — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Workday API: ${BRACCO_API_BASE}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(BRACCO_KEY, DATA_JOBS).filter(isBraccoJob))

  // Phase 1: Fetch jobs from Workday API
  const discoveredJobs = await fetchBraccoJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Bracco jobs discovered.');
    console.log('   The Workday API may be unreachable or have no Swiss openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeBraccoJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Bracco jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessBraccoJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Bracco jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Bracco Suisse S.A. crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBraccoJob) : [];
  writeJobsCrawlerSlice(BRACCO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: BRACCO_KEY,
    label: 'Bracco Suisse',
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

main().catch((err) => exitCrawlerOnError(err, 'Bracco Suisse'));
