#!/usr/bin/env node
/**
 * Dedicated ABB Svizzera (Ticino + Grigioni) crawler runner.
 *
 * Source:
 *   https://careers.abb/global/en/search-results
 *   Keywords: ticino, graubünden, grisons, chur, davos, engadin
 *
 * This script:
 *   1. Reads ABB search pages for multiple TI/GR keywords and extracts
 *      jobs from embedded phApp.ddo JSON.
 *   2. Keeps only CH jobs in Ticino / Grigioni.
 *   3. Builds canonical ABB detail URLs (careers.abb/.../job/:jobSeqNo/:title).
 *   4. Updates ABB adapter seed URLs + seedMetaByUrl.
 *   5. Runs base crawler for detail parsing/localization.
 *   6. Post-processes ABB rows for canonical consistency + dedupe.
 */
import fs from 'node:fs';
import path from 'node:path';
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
import { inferSwissTargetCanton, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const ABB_KEY = 'abb-svizzera-sede-ticino';
const DEFAULT_CANTON = getCompanyDefaults(ABB_KEY)?.canton || 'TI';
const ABB_COMPANY_NAME = 'ABB Svizzera (sede Ticino)';
const ABB_HOST = 'careers.abb';
const ABB_COMPANY_DOMAIN = 'abb.ch';
// Search queries covering both Ticino and Grigioni ABB locations
const ABB_SEARCH_KEYWORDS = ['ticino', 'graubünden', 'grisons', 'chur', 'davos', 'engadin'];

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

function extractPhAppDdo(html = '') {
  const source = String(html || '');
  const startMarker = 'phApp.ddo = ';
  const start = source.indexOf(startMarker);
  if (start === -1) return null;

  const endCandidates = [
    '; phApp.experimentData',
    ';phApp.experimentData',
    'phApp.experimentData =',
  ];
  let end = -1;
  for (const marker of endCandidates) {
    end = source.indexOf(marker, start);
    if (end !== -1) break;
  }
  if (end === -1) return null;

  try {
    const json = source.slice(start + startMarker.length, end).trim();
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isSwissCountry(raw = '') {
  const value = normalize(String(raw || ''));
  return value.includes('switzerland') || value === 'ch' || value.includes('schweiz');
}

function inferCantonFromJob(job) {
  const bucket = [
    job?.state,
    job?.location,
    job?.cityState,
    job?.cityStateCountry,
    job?.address,
    Array.isArray(job?.multi_location) ? job.multi_location.join(' ') : '',
    Array.isArray(job?.multi_location_array)
      ? job.multi_location_array.map((entry) => entry?.location || '').join(' ')
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return inferAnyCanton(bucket);
}

function normalizeAbbContract(raw = '') {
  const value = normalize(String(raw || ''));
  if (!value) return '';
  if (value.includes('apprend') || value.includes('lehre') || value.includes('apprent')) return 'Apprendistato';
  if (value.includes('part-time') || value.includes('part time') || value.includes('teilzeit')) return 'Part-time';
  if (value.includes('full-time') || value.includes('full time') || value.includes('vollzeit')) return 'Full-time';
  if (value.includes('stage') || value.includes('intern') || value.includes('praktikum')) return 'Stage';
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

  return String(job?.title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
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
    (canton === 'GR' ? 'Grigioni' : 'Ticino');

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

async function fetchAbbSearchPage(pageUrl, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      },
    });
    const html = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const ddo = extractPhAppDdo(html);
    if (!ddo) {
      throw new Error('phApp.ddo not found');
    }

    const refine = ddo?.eagerLoadRefineSearch || {};
    const data = refine?.data || {};
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const hits = Number(refine?.hits || jobs.length || 0);
    const totalHits = Number(refine?.totalHits || jobs.length || 0);
    return { jobs, hits, totalHits };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAbbJobDetailUrls() {
  const selectedByKey = new Map();
  const seedMetaByUrl = {};

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
  const maxPages = Math.max(1, Number(process.env.JOBS_ABB_MAX_PAGES || 10));

  console.log('🔍 Fetching ABB jobs from careers.abb search-results...');
  console.log(`   Keywords: ${ABB_SEARCH_KEYWORDS.join(', ')}`);

  for (const keyword of ABB_SEARCH_KEYWORDS) {
    console.log(`\n🔎 Searching keyword: "${keyword}"`);
    const baseUrl = new URL('https://careers.abb/global/en/search-results');
    baseUrl.searchParams.set('keywords', keyword);

    let totalHits = null;
    let offset = 0;

    for (let page = 0; page < maxPages; page += 1) {
      if (totalHits !== null && offset >= totalHits) break;

      const pageUrl = new URL(baseUrl.toString());
      if (offset > 0) pageUrl.searchParams.set('from', String(offset));

      console.log(`  📡 Page ${page + 1}: ${pageUrl.toString()}`);

      let payload;
      try {
        payload = await fetchAbbSearchPage(pageUrl.toString(), timeoutMs, userAgent);
      } catch (err) {
        console.warn(`    ⚠️ ABB page fetch failed: ${err?.message || err}`);
        break;
      }

      const jobs = payload.jobs;
      if (!Array.isArray(jobs) || jobs.length === 0) break;
      totalHits = Number.isFinite(payload.totalHits) ? payload.totalHits : totalHits;
      const stepSize = Number(payload.hits || jobs.length || 0);
      if (stepSize <= 0) break;

      console.log(`    📦 jobs: ${jobs.length} (totalHits=${totalHits ?? '?'})`);

      for (const job of jobs) {
        if (!isSwissCountry(job?.country || '')) continue;

        const canton = inferCantonFromJob(job);
        if (!isTargetCanton(canton)) continue;

        const detailUrl = toAbsoluteAbbUrl(buildAbbDetailUrl(job));
        if (!detailUrl || !detailUrl.includes('/global/en/job/')) continue;

        const reqId = extractReqId(job);
        const seq = String(job?.jobSeqNo || '').trim();
        const key = reqId ? `req:${reqId}` : (seq ? `seq:${seq}` : `url:${detailUrl.toLowerCase()}`);
        const score =
          String(job?.descriptionTeaser || '').length +
          (canton === 'TI' ? 400 : 200) +
          String(job?.title || '').length;

        const prev = selectedByKey.get(key);
        if (!prev || score > prev.score) {
          selectedByKey.set(key, { score, detailUrl, job, canton });
        }
      }

      offset += stepSize;
    }
  }

  const urls = [];
  for (const entry of selectedByKey.values()) {
    urls.push(entry.detailUrl);
    seedMetaByUrl[entry.detailUrl] = buildSeedMetaFromJob(entry.job, entry.canton);
  }
  urls.sort((a, b) => a.localeCompare(b));

  console.log(`\n✅ Total unique ABB detail URLs discovered (TI/GR): ${urls.length}`);
  return { urls, seedMetaByUrl };
}

function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${ABB_KEY}.json`);
  const notes =
    'Dedicated ABB crawler seeds from careers.abb search-results (keywords: ticino, graubünden, grisons, chur, davos, engadin), then resolves canonical careers.abb job detail URLs.';

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${ABB_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: ABB_KEY,
      companyName: ABB_COMPANY_NAME,
      companyHost: ABB_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      seedMetaByUrl,
      notes,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.companyName = ABB_COMPANY_NAME;
    adapter.companyHost = ABB_HOST;
    adapter.seedUrls = seedUrls;
    adapter.seedMetaByUrl = seedMetaByUrl;
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.crawlerModes = Array.isArray(adapter.crawlerModes) ? adapter.crawlerModes : [];
    if (!adapter.crawlerModes.includes('generic_ats')) adapter.crawlerModes.unshift('generic_ats');
    if (!adapter.crawlerModes.includes('html')) adapter.crawlerModes.push('html');
    if (!adapter.crawlerModes.includes('jsonld')) adapter.crawlerModes.push('jsonld');
    adapter.notes = notes;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${ABB_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err?.message || err}`);
  }
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ABB_KEY,
    localizeOnlyCompanyKeys: ABB_KEY,
    forceLocalizeKeys: ABB_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '250',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '250',
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

    const inferredCanton = inferAnyCanton(
      [job?.canton, job?.location, job?.region, job?.title].filter(Boolean).join(' ')
    );
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
    fs.writeFileSync(DATA_JOBS, JSON.stringify(deduped, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(deduped, null, 2) + '\n');
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
  const grJobs = abbJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = abbJobs.length - ticinoJobs.length - grJobs.length;

  console.log('\n📊 === ABB Svizzera Job Stats ===');
  console.log(`  ⚡ Job totali trovati (ABB): ${abbJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
  }
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
  console.log(`   Source: careers.abb search-results`);
  console.log(`   Keywords: ${ABB_SEARCH_KEYWORDS.join(', ')}`);
  console.log('   Scope: CH jobs in Ticino + Grigioni');
  console.log('');

  const discovery = await fetchAbbJobDetailUrls();
  if (discovery.urls.length === 0) {
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

main().catch((err) => {
  console.error(`❌ ABB crawler failed: ${err?.message || err}`);
  process.exit(1);
});
