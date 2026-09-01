#!/usr/bin/env node
/**
 * Dedicated ABB Svizzera (CH-wide) crawler runner.
 *
 * Source:
 *   POST https://careers.abb/widgets (Phenom refineSearch API)
 *   Filter: selected_fields.country = ["Switzerland"] (all 26 cantons)
 *
 * This script:
 *   1. Pages the ABB Phenom search API filtered to country=Switzerland and
 *      extracts jobs from the refineSearch JSON payload.
 *   2. Keeps only jobs that resolve to a Swiss canton (inferAnyCanton, CH-wide);
 *      drops non-CH / foreign-only rows. Never defaults unresolved jobs to TI.
 *   3. Builds canonical ABB detail URLs (careers.abb/.../job/:jobSeqNo/:title).
 *   4. Updates ABB adapter seed URLs + seedMetaByUrl.
 *   5. Runs base crawler for detail parsing/localization.
 *   6. Post-processes ABB rows for canonical consistency + dedupe.
 *
 * Note: the crawler key/company-name keep the legacy '-sede-ticino' suffix
 * intentionally (SEO URL/slug stability) — only the fetch scope is CH-wide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  normalize,
} from './lib/dedicated-crawler-common.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ABB_KEY = 'abb-svizzera-sede-ticino';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(ABB_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const DEFAULT_CANTON = getCompanyDefaults(ABB_KEY)?.canton || 'TI';
const ABB_COMPANY_NAME = 'ABB Svizzera (sede Ticino)';
const ABB_HOST = 'careers.abb';
const ABB_COMPANY_DOMAIN = 'abb.ch';
// Phenom refineSearch widget API + country facet covering ALL of Switzerland
// (CH-wide: every canton, not just TI/GR). The Phenom careers SSR page ignores
// URL facet params, so we POST the widgets endpoint with the country facet.
const ABB_SEARCH_API = 'https://careers.abb/widgets';
const ABB_SEARCH_COUNTRY = 'Switzerland';

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toAbsoluteAbbUrl(rawUrl = '') {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  }
  const normalizedPath = value.startsWith('/') ? value : `/${value}`;
  return `https://${ABB_HOST}${normalizedPath}`;
}

function isTrustedAbbDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('careers.abb') ||
      host.endsWith('abb.ch') ||
      host.endsWith('abb.wd3.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

function isAbbJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim().toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === ABB_KEY ||
    key.includes('abb') ||
    host.includes('careers.abb') ||
    host.includes('abb.wd3.myworkdayjobs.com') ||
    host.endsWith('abb.ch') ||
    company.includes('abb')
  );
}

function inferCantonFromJob(job) {
  // Resolve from the cleanest SINGLE signal in priority order — NEVER a combined
  // multi-field string. inferAnyCanton scans TARGET_CANTONS in array order, so a
  // concatenation of a multi-site job ("Genève + Zürich") returns the canton
  // highest in the array (GE), not the primary site. Use the primary location.
  const primaryMulti = Array.isArray(job?.multi_location_array) && job.multi_location_array[0]?.location
    ? job.multi_location_array[0].location
    : (Array.isArray(job?.multi_location) ? job.multi_location[0] : '');
  const signals = [job?.cityState, job?.location, primaryMulti, job?.state, job?.cityStateCountry, job?.address];
  for (const sig of signals) {
    if (!sig) continue;
    const c = inferAnyCanton(String(sig));
    if (c) return c;
  }
  return '';
}

function normalizeAbbContract(raw = '') {
  const value = normalize(String(raw || ''));
  if (!value) return '';
  if (value.includes('apprend') || value.includes('lehre') || value.includes('apprent')) return 'Apprendistato';
  if (value.includes('part-time') || value.includes('part time') || value.includes('teilzeit')) return 'Part-time';
  if (value.includes('full-time') || value.includes('full time') || value.includes('vollzeit')) return 'Full-time';
  if (/\bstages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(value) || /\bintern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(value) || value.includes('praktikum')) return 'Stage';
  return String(raw || '').trim();
}

function deriveAbbDetailSlug(job) {
  const applyUrl = String(job?.applyUrl || '').trim();
  if (applyUrl) {
    try {
      const pathname = new URL(applyUrl).pathname;
      const segments = pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      const beforeApply = normalize(last) === 'apply'
        ? segments[segments.length - 2]
        : last;
      const cleaned = decodeURIComponent(String(beforeApply || ''))
        .replace(/_[A-Z]{1,5}\d{4,}$/i, '')
        .replace(/^-+|-+$/g, '');
      if (cleaned) return cleaned;
    } catch {
      // noop
    }
  }

  return truncateSlugAtWordBoundary(String(job?.title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''), 140);
}

function buildAbbDetailUrl(job) {
  const seq = String(job?.jobSeqNo || '').trim();
  if (!seq) return '';
  const slug = deriveAbbDetailSlug(job);
  if (!slug) return '';
  return `https://${ABB_HOST}/global/en/job/${encodeURIComponent(seq)}/${encodeURIComponent(slug)}`;
}

function extractReqId(job) {
  return String(job?.reqId || job?.jobId || '').trim();
}

function buildSeedMetaFromJob(job, canton) {
  const location =
    String(job?.location || '').trim() ||
    String(job?.cityStateCountry || '').trim() ||
    String(job?.cityState || '').trim() ||
    String(job?.city || '').trim() ||
    'Svizzera';

  const contract = normalizeAbbContract(job?.jobType || job?.type || job?.contractType || '');
  return {
    location,
    canton: canton || DEFAULT_CANTON,
    country: 'CH',
    company: ABB_COMPANY_NAME,
    companyDomain: ABB_COMPANY_DOMAIN,
    ...(contract ? { contract } : {}),
  };
}

async function fetchAbbSearchPage(from, size, timeoutMs, userAgent, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Phenom refineSearch widget API: filter by the country facet (CH-wide).
    // The SSR search-results page ignores URL facet params, so we POST here.
    const body = {
      lang: 'en_global',
      deviceType: 'desktop',
      country: 'global',
      pageName: 'search-results',
      ddoKey: 'refineSearch',
      stateInfo: {
        sortBy: '',
        cmsTypeOverride: 'ExternalJobSearch',
        pageType: 'search-results',
        keywords: '',
        jobs: true,
        showFacets: true,
        location: [],
      },
      jobs: true,
      all_fields: ['country', 'state', 'city'],
      from,
      size,
      clientName: 'undefined',
      locationData: {},
      keywords: '',
      global: true,
      selected_fields: { country: [ABB_SEARCH_COUNTRY] },
      locationType: '',
    };

    const res = await fetchImpl(ABB_SEARCH_API, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();

    const refine = payload?.refineSearch || payload?.eagerLoadRefineSearch || {};
    const data = refine?.data || {};
    const jobs = assertJsonListShape(data, { key: 'jobs', source: 'abb' });
    const hits = Number(refine?.hits ?? data?.hits);
    const totalHits = Number(refine?.totalHits ?? data?.totalHits);
    return { jobs, hits, totalHits };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAbbJobDetailUrls(options = {}) {
  const selectedByKey = new Map();
  const seedMetaByUrl = {};

  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
  const maxPages = Math.max(1, Number(options.maxPages || process.env.JOBS_ABB_MAX_PAGES || 100000));
  const pageSize = Math.max(1, Number(options.pageSize || process.env.JOBS_ABB_PAGE_SIZE || 50));

  console.log('🔍 Fetching ABB jobs from careers.abb Phenom refineSearch API...');
  console.log(`   Filter: country=${ABB_SEARCH_COUNTRY} (CH-wide, all cantons)`);

  let totalHits = null;
  let offset = 0;
  let droppedNonTarget = 0;
  let droppedMalformed = 0;
  let duplicateIdentity = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (totalHits !== null && offset >= totalHits) break;

    console.log(`  📡 Page ${page + 1}: from=${offset} size=${pageSize}`);

    const payload = await fetchAbbSearchPage(offset, pageSize, timeoutMs, userAgent, fetchImpl);

    const jobs = payload.jobs;
    if (!Number.isInteger(payload.hits) || payload.hits !== jobs.length
        || !Number.isInteger(payload.totalHits) || payload.totalHits < 0
        || (totalHits !== null && payload.totalHits !== totalHits)) {
      throw new Error(`ABB discovery envelope invalid: hits=${payload.hits}, jobs=${jobs.length}, total=${payload.totalHits}, expectedTotal=${totalHits ?? payload.totalHits}.`);
    }
    totalHits = payload.totalHits;
    if (jobs.length === 0) {
      if (offset !== totalHits) throw new Error(`ABB discovery incomplete: fetched ${offset}/${totalHits} jobs.`);
      break;
    }

    console.log(`    📦 jobs: ${jobs.length} (totalHits=${totalHits ?? '?'})`);

    for (const job of jobs) {
      // Canton resolution is CH-wide via inferAnyCanton; foreign-only rows
      // (no Swiss location in their signal) resolve to '' and are dropped.
      // We do NOT gate on job.country here because multi-location CH jobs may
      // carry a foreign primary country while still having a Swiss location.
      const canton = inferCantonFromJob(job);
      if (!isTargetCanton(canton)) {
        droppedNonTarget += 1;
        continue;
      }

      const detailUrl = toAbsoluteAbbUrl(buildAbbDetailUrl(job));
      let canonical = '';
      try {
        const parsed = new URL(detailUrl);
        if (parsed.protocol === 'https:' && parsed.hostname === ABB_HOST
            && /^\/global\/en\/job\/[^/]+\/[^/]+$/.test(parsed.pathname)
            && !parsed.search && !parsed.hash) canonical = parsed.href;
      } catch {}
      if (!canonical) {
        droppedMalformed += 1;
        continue;
      }

      const reqId = extractReqId(job);
      const seq = String(job?.jobSeqNo || '').trim();
      const key = reqId ? `req:${reqId}` : (seq ? `seq:${seq}` : '');
      if (!key) {
        droppedMalformed += 1;
        continue;
      }
      const score =
        String(job?.descriptionTeaser || '').length +
        String(job?.title || '').length;

      const prev = selectedByKey.get(key);
      if (prev) duplicateIdentity += 1;
      if (!prev || score > prev.score) {
        selectedByKey.set(key, { score, detailUrl: canonical, job, canton });
      }
    }

    offset += jobs.length;
  }

  const accounted = selectedByKey.size + duplicateIdentity + droppedNonTarget + droppedMalformed;
  if (totalHits === null || offset !== totalHits || accounted !== offset || droppedMalformed !== 0) {
    throw new Error(`ABB discovery invariant failed: fetched=${offset}/${totalHits ?? '?'}, canonical=${selectedByKey.size}, duplicates=${duplicateIdentity}, non-target=${droppedNonTarget}, malformed=${droppedMalformed}.`);
  }

  const urls = [];
  for (const entry of selectedByKey.values()) {
    urls.push(entry.detailUrl);
    seedMetaByUrl[entry.detailUrl] = buildSeedMetaFromJob(entry.job, entry.canton);
  }
  urls.sort((a, b) => a.localeCompare(b));

  console.log(`\n✅ Total unique ABB detail URLs discovered (CH-wide): ${urls.length}`);
  return {
    urls,
    seedMetaByUrl,
    totalHits,
    fetched: offset,
    duplicateIdentity,
    droppedNonTarget,
    droppedMalformed,
    sourceZero: totalHits === 0,
  };
}

export function buildAbbAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl = {}, updatedAt = new Date().toISOString()) {
  const notes =
    'Dedicated ABB crawler seeds from the careers.abb Phenom refineSearch API (country=Switzerland, CH-wide / all cantons), then resolves canonical careers.abb job detail URLs.';
  return {
    ...(baseAdapter || {}),
    companyName: ABB_COMPANY_NAME,
    companyHost: ABB_HOST,
    seedUrls,
    seedMetaByUrl,
    priority: Math.max(baseAdapter?.priority || 0, 10),
    crawlerModes: Array.from(new Set(['generic_ats', ...(baseAdapter?.crawlerModes || []), 'html', 'jsonld'])),
    notes,
    updatedAt,
  };
}

export function assertAbbAdapterParity(adapter, seedUrls, seedMetaByUrl = {}) {
  if (!isDeepStrictEqual(adapter?.seedUrls, seedUrls)
      || !isDeepStrictEqual(adapter?.seedMetaByUrl, seedMetaByUrl)) {
    throw new Error('ABB adapter parity failed: persisted seeds differ from the complete Phenom feed.');
  }
  return true;
}

export function ensureAdapterSeedUrls(
  seedUrls,
  seedMetaByUrl = {},
  adapterPath = path.join(ADAPTERS_DIR, `${ABB_KEY}.json`),
  updatedAt = new Date().toISOString(),
) {
  const baseAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: ABB_KEY,
      companyName: ABB_COMPANY_NAME,
      companyHost: ABB_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
    };
  const adapter = buildAbbAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl, updatedAt);
  writeJsonAtomic(adapterPath, adapter);
  const persisted = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  assertAbbAdapterParity(persisted, seedUrls, seedMetaByUrl);
  console.log(`📝 Adapter ${ABB_KEY} updated with ${seedUrls.length} seed URLs (Phenom parity verified).`);
  return persisted;
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ABB_KEY,
    localizeOnlyCompanyKeys: ABB_KEY,
    forceLocalizeKeys: ABB_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

function abbJobQualityScore(job) {
  const descriptionLength = String(job?.description || '').trim().length;
  const trusted = isTrustedAbbDomain(job?.url || '') ? 700 : 0;
  const hasTI = inferSwissTargetCanton([job?.location, job?.canton, job?.region].filter(Boolean).join(' ')) === 'TI'
    ? 250
    : 0;
  return Math.min(7000, descriptionLength) + trusted + hasTI;
}

function abbDedupKey(job) {
  const url = String(job?.url || '');
  const reqFromUrl = (() => {
    const m = url.match(/JR\d{5,}/i);
    return m ? m[0].toUpperCase() : '';
  })();
  if (reqFromUrl) return `req:${reqFromUrl}`;
  if (job?.jobId) return `job:${String(job.jobId).toUpperCase()}`;
  if (job?.jobSeqNo) return `seq:${String(job.jobSeqNo).toUpperCase()}`;
  return `url:${url.toLowerCase()}`;
}

function postProcessAbbJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of allJobs) {
    if (!isAbbJob(job)) continue;

    if (job.company !== ABB_COMPANY_NAME) {
      job.company = ABB_COMPANY_NAME;
      fixed += 1;
    }
    if (job.companyKey !== ABB_KEY) {
      job.companyKey = ABB_KEY;
      fixed += 1;
    }
    if (job.companyDomain !== ABB_COMPANY_DOMAIN) {
      job.companyDomain = ABB_COMPANY_DOMAIN;
      fixed += 1;
    }
    if (job.country !== 'CH') {
      job.country = 'CH';
      fixed += 1;
    }
    if (!String(job?.source || '').trim()) {
      job.source = 'ABB careers search-results + JSON-LD';
      fixed += 1;
    }
    if (!job.sourceLang) {
      job.sourceLang = detectLang(job.description || job.title, 'en');
      fixed += 1;
    }
    if (String(job?.url || '').startsWith('/')) {
      job.url = toAbsoluteAbbUrl(job.url);
      fixed += 1;
    }

    // Precedence-first: resolve each field alone in priority order (explicit
    // canton, then location, region, title) rather than joining them into one
    // string, where inferAnyCanton's TARGET_CANTONS array order — not field
    // priority — would decide which canton wins.
    const inferredCanton = inferAnyCanton(job?.canton || '')
      || inferAnyCanton(job?.location || '')
      || inferAnyCanton(job?.region || '')
      || inferAnyCanton(job?.title || '');
    if (inferredCanton && inferredCanton !== job.canton) {
      job.canton = inferredCanton;
      fixed += 1;
    }
  }

  const bestByKey = new Map();
  const toDrop = new Set();

  for (let idx = 0; idx < allJobs.length; idx += 1) {
    const job = allJobs[idx];
    if (!isAbbJob(job)) continue;

    const key = abbDedupKey(job);
    const score = abbJobQualityScore(job);
    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, { idx, score });
      continue;
    }
    if (score > prev.score) {
      toDrop.add(prev.idx);
      bestByKey.set(key, { idx, score });
    } else {
      toDrop.add(idx);
    }
  }

  const deduped = toDrop.size > 0
    ? allJobs.filter((_, idx) => !toDrop.has(idx))
    : allJobs;

  if (fixed > 0 || toDrop.size > 0) {
    writeJsonAtomic(DATA_JOBS, deduped);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      writeJsonAtomic(PUBLIC_DATA_JOBS, deduped);
    }
    console.log(`🧹 Post-processed ${fixed} ABB fields.`);
    if (toDrop.size > 0) {
      console.log(`🧯 Deduped ${toDrop.size} ABB duplicate rows.`);
    }
  }
}

function logAbbJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const abbJobs = allJobs.filter(isAbbJob);
  const ticinoJobs = abbJobs.filter((job) => normalize(job?.canton) === 'ti');

  const byCanton = new Map();
  for (const job of abbJobs) {
    const c = String(job?.canton || '').trim().toUpperCase() || '??';
    byCanton.set(c, (byCanton.get(c) || 0) + 1);
  }
  const cantonBreakdown = [...byCanton.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}:${n}`)
    .join(', ');

  console.log('\n📊 === ABB Svizzera Job Stats (CH-wide) ===');
  console.log(`  ⚡ Job totali trovati (ABB): ${abbJobs.length}`);
  console.log(`  🗺️ Distribuzione per cantone: ${cantonBreakdown || '—'}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(abbJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'ABB');
  writeCrawlChangeSummaryToGH(crawlDiff, 'ABB');
  return { total: abbJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateAbbLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ABB_STRICT',
    label: 'ABB',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAbbJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedAbbDomain,
    untrustedDomainReason: 'untrusted_domain_for_abb_job',
    noJobsMessage: 'Nessun job ABB trovato dopo il crawl — niente da validare.',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(ABB_KEY, 'ABB');
  console.log('⚡ Running dedicated ABB Svizzera jobs crawler...');
  console.log(`   Source: careers.abb Phenom refineSearch API`);
  console.log(`   Filter: country=${ABB_SEARCH_COUNTRY}`);
  console.log('   Scope: CH jobs in all cantons (CH-wide)');
  console.log('');

  const discovery = await fetchAbbJobDetailUrls();
  if (discovery.sourceZero) {
    console.log('ℹ️ Nessun URL di dettaglio ABB trovato. Uscita OK.');
    return;
  }

  ensureAdapterSeedUrls(discovery.urls, discovery.seedMetaByUrl);

  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(ABB_KEY, DATA_JOBS).filter(isAbbJob))

  await runBaseCrawler();
  postProcessAbbJobs();

  const stats = logAbbJobStats(beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job ABB trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }
  validateAbbLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isAbbJob) : [];
  writeJobsCrawlerSlice(ABB_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: ABB_KEY,
    label: 'ABB',
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'ABB'));
}
