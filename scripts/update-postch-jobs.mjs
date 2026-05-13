#!/usr/bin/env node
/**
 * Dedicated Swiss Post (La Posta Svizzera) crawler runner.
 * Crawls the Post.ch careers portal for Ticino/Grigioni positions
 * (apprenticeships + professionals) and enforces full locale coverage.
 *
 * Listing URLs:
 *   Apprenticeships: https://www.post.ch/en/jobs/jobs?jobsCategory=apprenticeships
 *   Professionals: https://www.post.ch/en/jobs/jobs?jobsCategory=professionals&workload-maximum=1&workload-minimum=0
 *
 * Individual job detail pages are on a separate subdomain:
 *   https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 *
 * Discovery flow:
 *   1. Fetch both listing pages
 *   2. Parse job links (job.post.ch/v2/job-vacancies/{slug}/{uuid})
 *   3. Fetch each job detail page to extract data from JSON-LD (JobPosting schema)
 *   4. Filter to only keep target-region jobs (Ticino/Grigioni)
 *   5. Build job objects; merge into data/jobs.json
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parsePostJobDetail, extractPostJobIdFromUrl } from './lib/postch-job-parser.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const POST_KEY = 'posta-svizzera-centro-regionale';
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Listing source — SuccessFactors NES JSON API on job.post.ch.
 *
 * The legacy `www.post.ch/en/jobs/jobs?jobsCategory=…` pages are now an
 * SPA shell that loads jobs via XHR; scraping the HTML returns zero `<a>`
 * elements. The widget calls `POST /services/recruiting/v1/jobs`, which
 * returns the full job list with pipe-separated location strings. We
 * paginate the German locale (the largest superset — Italian/French/English
 * only return jobs explicitly translated to that locale, missing most TI/GR
 * positions) and filter for the target cantons here.
 */
const JOBS_API_URL = 'https://job.post.ch/services/recruiting/v1/jobs';
// We paginate every locale because the API only returns jobs that have a
// translation in the requested locale. de_DE is the largest superset (≈100
// jobs) but Italian-only postings (e.g. AutoPostale Bellinzona) are missing
// from it — we'd silently drop them without scanning it_IT separately.
const JOBS_API_LISTING_LOCALES = ['de_DE', 'it_IT', 'fr_FR', 'en_US'];
const JOBS_API_MAX_PAGES = 60;     // hard ceiling — protects against runaway pagination
const JOBS_DETAIL_LOCALES = ['it_IT', 'de_DE', 'fr_FR', 'en_US']; // priority for description language

// Kept for adapter seedUrls / external references only.
const LISTING_URLS = [
  'https://job.post.ch/search/?locale=it_IT',
  'https://job.post.ch/search/?locale=de_DE',
];

const POST_COMPANY_NAME = 'La Posta Svizzera';
const POST_COMPANY_HOST = 'post.ch';
const DETAIL_HOST = 'job.post.ch';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

/**
 * Match a job object as belonging to the Post.ch crawl.
 */
function isPostJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === POST_KEY ||
    key.includes('posta-svizzera') ||
    key.includes('swiss-post') ||
    host === 'job.post.ch' ||
    host === 'www.post.ch'
  );
}

// ──────────────────────────────────────────────────────────────
// HTML fetching
// ──────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Parsing — extract job listings from the SuccessFactors JSON API
// ──────────────────────────────────────────────────────────────

/**
 * POST one page against the SuccessFactors NES jobs search endpoint.
 *
 * @returns {Promise<{totalJobs:number, jobs:object[]}>}  always returns an
 *   object so callers can break the pagination loop on `jobs.length === 0`.
 */
async function fetchJobsApiPage(locale, pageNumber, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(JOBS_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8,de;q=0.7',
        Origin: 'https://job.post.ch',
        Referer: 'https://job.post.ch/search/',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify({ locale, pageNumber, sortBy: 'date' }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for jobs API (${locale} page ${pageNumber})`);
      return { totalJobs: 0, jobs: [] };
    }
    const data = await res.json();
    const jobs = Array.isArray(data?.jobSearchResult)
      ? data.jobSearchResult.map(r => r?.response).filter(Boolean)
      : [];
    return { totalJobs: Number(data?.totalJobs ?? 0), jobs };
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ Jobs API fetch failed (${locale} page ${pageNumber}): ${err.message}`);
    return { totalJobs: 0, jobs: [] };
  }
}

/**
 * Decode an HTML-encoded URL segment (the API returns `&apos;` etc.).
 */
function decodeUrlSegment(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Build the canonical SuccessFactors detail URL from a single API record.
 */
function buildDetailUrl(record, locale = 'it_IT') {
  const brand = String(record?.brandUrl || 'default').trim() || 'default';
  const slug = decodeUrlSegment(record?.unifiedUrlTitle || record?.urlTitle || '');
  const id = String(record?.id || '').trim();
  if (!slug || !id) return '';
  return `https://job.post.ch/${brand}/job/${slug}/${id}-${locale}`;
}

/**
 * Test whether any `jobLocationShort` entry on a record lies in our target
 * cantons (TI / GR). Pipe-separated form: "City|Canton|CC|Country|CCC ".
 */
function recordIsInTargetCanton(record) {
  const locs = Array.isArray(record?.jobLocationShort) ? record.jobLocationShort : [];
  for (const loc of locs) {
    const parts = String(loc || '').split('|').map(p => p.trim());
    // Index 2 is the 2-letter canton code in the standard CH form.
    if (parts.length >= 5 && (parts[2] === 'TI' || parts[2] === 'GR')) return true;
    // Italian/French locales render the canton name in their language; the
    // canton code (parts[2]) is canonical, but as a safety net we also scan
    // textually for known target localities + canton names.
    const lc = String(loc || '').toLowerCase();
    if (lc.includes('|ti|') || lc.includes('|gr|')) return true;
    if (/(ticino|tessin|grigioni|grisons|graub[üu]nden)/i.test(loc || '')) return true;
  }
  return false;
}

/**
 * Locality of the first target-canton entry on a record (used as a tiebreaker
 * when the detail-page location parsing is unavailable).
 */
function recordTargetCity(record) {
  const locs = Array.isArray(record?.jobLocationShort) ? record.jobLocationShort : [];
  for (const loc of locs) {
    const parts = String(loc || '').split('|').map(p => p.trim());
    if (parts.length >= 5 && (parts[2] === 'TI' || parts[2] === 'GR')) return parts[0];
  }
  return '';
}

/**
 * Check whether a job's region indicates it's in the TI/GR target area.
 */
function isTicinoJob(detail) {
  const region = normalize(detail.region);
  const city = normalize(detail.city);
  const location = normalize(detail.location);
  return (
    isTargetSwissLocation(region) ||
    isTargetSwissLocation(city) ||
    isTargetSwissLocation(location)
  );
}

/**
 * Detect the city from the location/region fields.
 */
function detectCity(detail) {
  const city = detail.city || '';
  // Remove " / Homeoffice" suffix
  const clean = city.replace(/\s*\/\s*homeoffice/i, '').trim();
  if (clean) return clean;
  if (detail.region && detail.region.toLowerCase().includes('tessin')) return 'Bellinzona';
  return 'Bellinzona';
}

function detectCanton(city = '') {
  return inferAnyCanton(city) || 'TI';
}

function detectEmploymentType(detail) {
  const et = detail.employmentType || '';
  if (et === 'PART_TIME') return 'PART_TIME';
  if (et === 'INTERN' || et === 'INTERNSHIP') return 'INTERN';
  return 'FULL_TIME';
}

function detectSector(detail) {
  const industry = normalize(detail.industry);
  const title = normalize(detail.title);
  if (industry.includes('bank') || industry.includes('finanz') || industry.includes('finance')) return 'Finanza';
  if (industry.includes('logist') || title.includes('logist')) return 'Logistica';
  if (industry.includes('inform') || title.includes('inform') || title.includes('it ') || title.includes('ict')) return 'IT';
  if (industry.includes('consult') || industry.includes('berat')) return 'Consulenza';
  if (title.includes('apprendist') || title.includes('lehre') || title.includes('apprenti')) return 'Formazione';
  if (industry.includes('telekom') || industry.includes('kommunik')) return 'Telecomunicazioni';
  return 'Servizi Postali';
}

// ──────────────────────────────────────────────────────────────
// Main discovery flow
// ──────────────────────────────────────────────────────────────

async function fetchPostJobs() {
  console.log('📮 Fetching Swiss Post (La Posta Svizzera) job listings...');
  console.log(`  🌐 Listing API: ${JOBS_API_URL} (locales=${JOBS_API_LISTING_LOCALES.join(',')})`);

  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // 1. Paginate the API once per locale, then deduplicate by job id —
  //    locales return disjoint sets of jobs (a job is only visible in
  //    locales it has been translated to).
  const byId = new Map();
  for (const apiLocale of JOBS_API_LISTING_LOCALES) {
    let pageNumber = 0;
    let totalJobs = Infinity;
    let seen = 0;
    while (seen < totalJobs && pageNumber < JOBS_API_MAX_PAGES) {
      const { totalJobs: total, jobs } = await fetchJobsApiPage(apiLocale, pageNumber);
      if (jobs.length === 0) break;
      for (const j of jobs) {
        const id = String(j?.id || '').trim();
        if (!id) continue;
        if (!byId.has(id)) byId.set(id, j);
      }
      seen += jobs.length;
      totalJobs = total;
      pageNumber += 1;
      await delay(250);
    }
    console.log(`     ${apiLocale}: ${seen} record(s) (claimed total: ${Number.isFinite(totalJobs) ? totalJobs : 'unknown'})`);
  }
  const apiRecords = [...byId.values()];
  console.log(`  📋 Merged unique records across locales: ${apiRecords.length}`);

  if (apiRecords.length === 0) {
    console.warn('⚠️ Jobs API returned no records — endpoint may have changed.');
    return [];
  }

  // 2. Filter to TI/GR via the pipe-separated jobLocationShort field.
  const targetRecords = apiRecords.filter(recordIsInTargetCanton);
  console.log(`  🎯 ${targetRecords.length} record(s) in target cantons (TI/GR)`);

  if (targetRecords.length === 0) {
    return [];
  }

  // 3. Fetch each detail page. Prefer Italian; fall back to French / German /
  //    English only if the job is actually translated to those locales
  //    (jobs that aren't translated render a German "Stellendetails"
  //    placeholder with no tokens — `parsePostJobDetail` returns no title,
  //    which we use as the signal to try the next locale).
  const jobs = [];
  for (const record of targetRecords) {
    // `supportedLocales` tells us which detail pages will actually render —
    // request order = our preference order intersected with what the record
    // supports, then any remaining preferred locales as a last resort.
    const supported = new Set(
      (Array.isArray(record.supportedLocales) ? record.supportedLocales : [])
        .map(l => String(l || '').trim())
    );
    const orderedLocales = [
      ...JOBS_DETAIL_LOCALES.filter(l => supported.has(l)),
      ...JOBS_DETAIL_LOCALES.filter(l => !supported.has(l)),
    ];

    let detail = null;
    let sourceUrl = '';
    for (const locale of orderedLocales) {
      const url = buildDetailUrl(record, locale);
      if (!url) continue;
      console.log(`  📄 Fetching detail (${locale}): ${url}`);
      const html = await fetchPage(url, 20000);
      await delay(400);
      if (!html) continue;
      const parsed = parsePostJobDetail(html, url);
      // Require a meaningful title (locale-untranslated jobs render the
      // generic "Stellendetails" placeholder — discard it) AND a non-trivial
      // description.
      const looksLikePlaceholder = /^stellendetails$/i.test(String(parsed?.title || '').trim());
      const hasBody = (parsed?.description || '').length > 80;
      if (parsed?.title && !looksLikePlaceholder && hasBody) {
        detail = parsed;
        sourceUrl = url;
        break;
      }
    }

    if (!detail || !detail.title) {
      console.warn(`  ⚠️ Could not parse detail for job ${record.id}`);
      continue;
    }

    // Sanity check: detail page location must still resolve to TI/GR.
    // (Listing API can lag; if the underlying job moved we re-filter.)
    if (!isTicinoJob(detail)) {
      const apiFallbackCity = recordTargetCity(record);
      if (!apiFallbackCity) {
        console.log(`     ↳ Skipping (detail no longer TI/GR): ${detail.title}`);
        continue;
      }
      detail.city = detail.city || apiFallbackCity;
      detail.location = detail.location || apiFallbackCity;
    }

    const title = detail.title || '';
    // Multi-location job: prefer the place that lies in our target cantons
    // over the detail page's "first" city (which depends on SF's display
    // order and may be a SG/ZH co-location for a TI/GR opening).
    const targetPlace = (detail.places || []).find(p => p.region === 'TI' || p.region === 'GR');
    const city = (targetPlace && targetPlace.city)
      || detectCity(detail)
      || recordTargetCity(record)
      || 'Bellinzona';
    const canton = (targetPlace && targetPlace.region) || detectCanton(city);
    const slug = slugify(title, 'post');
    const brandCompany = Array.isArray(record.cust_brandCompanyJobSearch)
      ? record.cust_brandCompanyJobSearch[0]
      : '';

    const descriptionIt = detail.description && detail.description.length > 30
      ? detail.description
      : `Posizione aperta presso ${brandCompany || POST_COMPANY_NAME}. Ruolo: ${title}. Sede: ${city}, Svizzera.`;

    const job = {
      url: sourceUrl,
      applyUrl: sourceUrl,
      title,
      company: brandCompany || detail.hiringOrg || POST_COMPANY_NAME,
      companyKey: POST_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descriptionIt,
      descriptionByLocale: { it: descriptionIt },
      titleByLocale: { it: title },
      slug,
      slugByLocale: { it: slug },
      sourceLang: detectLang(descriptionIt || title, 'it'),
      department: detail.industry || '',
      category: detail.industry || 'servizi-postali',
      datePosted: detail.datePosted || new Date().toISOString().split('T')[0],
      validThrough: detail.validThrough || '',
      source: 'postch-careers-crawler',
      employmentType: detectEmploymentType(detail),
      experienceLevel: '',
      sector: detectSector(detail),
      workload: detail.workload || '',
      _targetScope: { canton, location: city },
    };

    jobs.push(job);
    console.log(`     ✅ ${title} — ${city} (${canton})`);
  }

  console.log(`\n📋 Total Post.ch Ticino/Grigioni jobs discovered: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ──────────────────────────────────────────────────────────────

/**
 * Stable Post.ch job identifier — accepts both the legacy `/v2/job-vacancies/{slug}/{uuid}`
 * URL family (UUID) and the current SuccessFactors NES format
 * (`/{brand}/job/{slug}/{id}-{locale}`, numeric ID). Routes through the
 * parser-side helper so additions to the URL family stay in one place.
 */
function extractUuid(url = '') {
  return extractPostJobIdFromUrl(url);
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergePostJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(POST_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonPostJobs = allJobs.filter((j) => !isPostJob(j));
  const existingPostJobs = allJobs.filter(isPostJob);

  // Build lookup by UUID
  const existingByUuid = new Map();
  for (const job of existingPostJobs) {
    const uuid = extractUuid(job.url);
    if (uuid) existingByUuid.set(uuid, job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const uuid = extractUuid(discovered.url);
    const existing = uuid ? existingByUuid.get(uuid) : null;

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        description: discovered.description || existing.description,
        company: discovered.company || existing.company,
        companyKey: POST_KEY,
        location: discovered.location || existing.location,
        canton: discovered.canton || existing.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        url: discovered.url || existing.url,
        department: discovered.department || existing.department,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'postch-careers-crawler',
        workload: discovered.workload || existing.workload,
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      };

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  // Count removed (existing Post jobs not in discovery)
  const discoveredUuids = new Set(discoveredJobs.map(j => extractUuid(j.url)).filter(Boolean));
  for (const [uuid] of existingByUuid) {
    if (!discoveredUuids.has(uuid)) removed++;
  }

  const final = [...nonPostJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ──────────────────────────────────────────────────────────────
// Adapter configuration
// ──────────────────────────────────────────────────────────────

function updateAdapterConfig(seedUrls = []) {
  const adapterPath = path.join(ADAPTERS_DIR, `${POST_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = POST_KEY;
  adapter.companyName = POST_COMPANY_NAME;
  adapter.companyHost = POST_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'jsonld'];
  adapter.seedUrls = [...LISTING_URLS, ...seedUrls];
  adapter.notes = 'Swiss Post careers portal — Ticino/Grigioni jobs discovered via the SuccessFactors NES jobs search API (POST job.post.ch/services/recruiting/v1/jobs) and detail HTML scraped from job.post.ch.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${POST_KEY} updated.`);
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation (for AI localization only)
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: POST_KEY,
    localizeOnlyCompanyKeys: POST_KEY,
    forceLocalizeKeys: POST_KEY,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────

function postProcessPostJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isPostJob(job)) continue;

    if (job.companyKey !== POST_KEY) {
      job.companyKey = POST_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Bellinzona';
      fixed++;
    }
    if (!job.descriptionByLocale || job.descriptionByLocale.it !== job.description) {
      job.descriptionByLocale = { ...(job.descriptionByLocale || {}), it: job.description };
      fixed++;
    }
    if (!job.titleByLocale || job.titleByLocale.it !== job.title) {
      job.titleByLocale = { ...(job.titleByLocale || {}), it: job.title };
      fixed++;
    }
    if (!job.slugByLocale || job.slugByLocale.it !== job.slug) {
      job.slugByLocale = { ...(job.slugByLocale || {}), it: job.slug };
      fixed++;
    }
    if (!job.canton) {
      job.canton = detectCanton(job.location);
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Post.ch jobs (fixed company/location/canton).`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logPostJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const postJobs = allJobs.filter(isPostJob);

  const locations = {};
  for (const job of postJobs) {
    const loc = job.location || 'unknown';
    locations[loc] = (locations[loc] || 0) + 1;
  }

  const sectors = {};
  for (const job of postJobs) {
    const sec = job.sector || 'unknown';
    sectors[sec] = (sectors[sec] || 0) + 1;
  }

  console.log(`\n📊 === La Posta Svizzera Job Stats ===`);
  console.log(`  📮 Job totali trovati (Post.ch): ${postJobs.length}`);

  if (Object.keys(locations).length > 0) {
    console.log(`  📍 Per sede:`);
    for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${loc}: ${count}`);
    }
  }

  if (Object.keys(sectors).length > 0) {
    console.log(`  🏢 Per settore:`);
    for (const [sec, count] of Object.entries(sectors).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${sec}: ${count}`);
    }
  }

  console.log('');

  const afterSnapshot = snapshotJobSlugs(postJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Post.ch');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Post.ch');
  return { total: postJobs.length, crawlDiff };
}

function validatePostLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_POSTCH_STRICT',
    label: 'Post.ch',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isPostJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    minDescriptionChars: 80,
    noJobsMessage: 'No Post.ch jobs found after crawl.',
    failWhenNoJobs: true,
    sampleLimit: 25,
    maxToleratedMissingDescriptions: 8,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(POST_KEY, 'Post.ch');
  console.log('📮 Running dedicated Swiss Post (La Posta) jobs crawler...');
  console.log(`   Listing URLs:`);
  for (const url of LISTING_URLS) console.log(`     ${url}`);
  console.log('');

  // 1. Fetch and parse job listings
  const discoveredJobs = await fetchPostJobs();

  if (discoveredJobs.length === 0) {
    console.log('⚠️ No Post.ch Ticino jobs discovered from the careers portal.');
    console.log('   The page structure may have changed or be temporarily unavailable.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logPostJobStats();
    return;
  }

  // 2. Update the adapter config with discovered job URLs as seeds
  const seedUrls = discoveredJobs.map(j => j.url);
  updateAdapterConfig(seedUrls);

  // 3. Merge discovered jobs into data/jobs.json
  await mergePostJobs(discoveredJobs);

  // Snapshot for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(POST_KEY, DATA_JOBS).filter(isPostJob))

  // 4. Run base crawler for AI localization (IT/DE/FR/EN translations)
  console.log('\n🌐 Running base crawler for AI localization of Post.ch jobs...');
  await runBaseCrawler();

  // 5. Post-process: ensure consistency
  postProcessPostJobs();

  // 6. Log stats
  const stats = logPostJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Post.ch jobs found. Exiting OK.');
    return;
  }

  // 7. Validate locale coverage
  validatePostLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isPostJob) : [];
  writeJobsCrawlerSlice(POST_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: POST_KEY,
    label: 'Post.ch',
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

main().catch((err) => {
  console.error(`❌ Post.ch crawler failed: ${err?.message || err}`);
  process.exit(1);
});
