#!/usr/bin/env node
/**
 * Dedicated Lidl Svizzera crawler runner.
 * Runs only Lidl jobs relevant to Ticino + Grigioni italiano and enforces
 * full locale coverage for SEO-critical fields.
 *
 * Data source:
 *   team.lidl.ch search API (used by the public "Cerca opportunità" page):
 *   GET /it/search_api/jobsearch?...  -> JSON with result.hits[]
 *
 * This script:
 *   1. Calls Lidl search API with dedicated query seeds (Ticino / Grigioni italiano).
 *   2. Extracts unique job detail URLs from API hits.
 *   3. Updates the Lidl adapter seed URLs + seedMetaByUrl.
 *   4. Runs base crawler for detail parsing/localization.
 *   5. Post-processes and deduplicates Lidl jobs for canonical consistency.
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
import { parseLidlDetailPage, hasListContent, MIN_LIDL_FULL_DESC } from './lib/lidl-job-parser.mjs';
import { TARGET_CANTONS } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LIDL_KEY = 'lidl-svizzera';
const LIDL_COMPANY_NAME = 'Lidl Svizzera';
const LIDL_TEAM_HOST = 'team.lidl.ch';
const LIDL_COMPANY_DOMAIN = 'lidl.ch';
const LIDL_SEARCH_API_BASE = 'https://team.lidl.ch/it/search_api/jobsearch';

const LIDL_SEARCH_SOURCES = [
  {
    name: 'Ticino',
    canton: TARGET_CANTONS[0],
    listingUrl:
      'https://team.lidl.ch/it/cerca-opportunita?page=1&midpoint_name=Canton%20Ticino,%20Canton%20Ticino&midpoint_lat=null&midpoint_lon=null&radius=null&filter=%7B%22contract_type%22:%5B%5D,%22employment_area%22:%5B%5D,%22entry_level%22:%5B%5D,%22language%22:%5B%5D%7D&min_lat=46.632568359375&min_lon=8.382412910461426&max_lat=45.81787872314453&max_lon=9.160479545593262&with_event=true&hash=',
  },
  {
    name: 'Grigioni italiano',
    canton: 'GR',
    listingUrl:
      'https://team.lidl.ch/it/cerca-opportunita?page=1&midpoint_name=Grigioni%20italiano,%20Grigioni&midpoint_lat=46.3434&midpoint_lon=9.5906&radius=null&filter=%7B%22contract_type%22:%5B%5D,%22employment_area%22:%5B%5D,%22entry_level%22:%5B%5D,%22language%22:%5B%5D%7D&with_event=true&hash=',
  },
];

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isLidlJob(job) {
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
    key === LIDL_KEY ||
    key.includes('lidl') ||
    host.includes('team.lidl.ch') ||
    host.includes('lidl.ch') ||
    company.includes('lidl')
  );
}

function isTrustedLidlDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('team.lidl.ch') ||
      host.endsWith('lidl.ch') ||
      host.includes('ea-lidl.cfapps.eu20.hana.ondemand.com')
    );
  } catch {
    return false;
  }
}

function toAbsoluteLidlUrl(rawUrl = '') {
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
  return `https://${LIDL_TEAM_HOST}${normalizedPath}`;
}

function normalizeLidlDetailPath(rawUrl = '') {
  try {
    const url = new URL(toAbsoluteLidlUrl(rawUrl));
    return url.pathname.replace(/^\/(it|de|fr|en)\//i, '/_lang_/').replace(/\/+$/, '');
  } catch {
    return String(rawUrl || '').trim();
  }
}

function extractReqId(raw = '') {
  const txt = String(raw || '').trim();
  if (!txt) return '';
  const match = txt.match(/(\d{5,})/);
  return match ? match[1] : '';
}

function extractReqIdFromHit(hit, detailUrl = '') {
  const fromReference = extractReqId(hit?.reference || '');
  if (fromReference) return fromReference;
  const easyApply = String(hit?.easyApply?.easyApplyUrl || '').trim();
  if (easyApply) {
    try {
      const req = extractReqId(new URL(easyApply).searchParams.get('ReqId') || '');
      if (req) return req;
    } catch {
      // noop
    }
  }
  const fromUrl = String(detailUrl || '').match(/-(\d{5,})(?:$|[/?#])/);
  return fromUrl ? fromUrl[1] : '';
}

function inferHitLanguage(hit, detailUrl = '') {
  const lang = normalize(String(hit?.jobLanguage || ''));
  if (lang === 'it' || lang === 'de' || lang === 'fr' || lang === 'en') return lang;
  const m = String(detailUrl || '').match(/https?:\/\/[^/]+\/(it|de|fr|en)\//i);
  return m ? m[1].toLowerCase() : '';
}

function languageScore(lang = '') {
  if (lang === 'it') return 4000;
  if (lang === 'de') return 1200;
  if (lang === 'fr') return 600;
  if (lang === 'en') return 300;
  return 0;
}

function inferCantonFromCoordinates(lat, lon, fallback = '') {
  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return fallback;

  // Approximate bbox for Ticino.
  if (nLat >= 45.78 && nLat <= 46.65 && nLon >= 8.37 && nLon <= 9.22) return 'TI';
  // Approximate bbox for Grigioni.
  if (nLat >= 46.00 && nLat <= 47.25 && nLon >= 8.70 && nLon <= 10.70) return 'GR';
  return fallback;
}

function normalizeLidlContract(raw = '') {
  const value = normalize(String(raw || ''));
  if (!value) return '';
  if (value.includes('apprend') || value.includes('lehre') || value.includes('apprent')) return 'Apprendistato';
  if (value.includes('teilzeit') || value.includes('part-time') || value.includes('part time')) return 'Part-time';
  if (value.includes('vollzeit') || value.includes('full-time') || value.includes('full time')) return 'Full-time';
  if (value.includes('stage') || value.includes('praktikum') || value.includes('intern')) return 'Stage';
  return String(raw || '').trim();
}

function buildSeedMetaFromHit(hit, sourceCanton) {
  const lat = hit?.location?.latitude;
  const lon = hit?.location?.longitude;
  const inferredCanton = inferCantonFromCoordinates(lat, lon, sourceCanton);
  const city = String(hit?.location?.city || '').trim();
  const locationTitle = String(hit?.location?.title || '').trim();
  const address = String(hit?.location?.address || '').trim();
  const location = city || locationTitle || address || (sourceCanton === 'GR' ? 'Grigioni' : 'Ticino');
  const contract = normalizeLidlContract(hit?.contractType || '');
  return {
    location,
    addressLocality: location,
    canton: inferredCanton || sourceCanton,
    country: 'CH',
    company: LIDL_COMPANY_NAME,
    companyDomain: LIDL_COMPANY_DOMAIN,
    ...(contract ? { contract } : {}),
  };
}

function parseSearchParamsFromListingUrl(rawUrl = '') {
  const url = new URL(String(rawUrl || ''));
  const params = new URLSearchParams(url.search || '');
  if (!params.get('page')) params.set('page', '1');
  if (!params.get('with_event')) params.set('with_event', 'true');
  return params;
}

async function fetchLidlJobDetailUrls() {
  const selectedByKey = new Map();
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log('🔍 Fetching Lidl jobs from team.lidl.ch search API...');

  for (const source of LIDL_SEARCH_SOURCES) {
    let apiUrl = '';
    try {
      const params = parseSearchParamsFromListingUrl(source.listingUrl);
      apiUrl = `${LIDL_SEARCH_API_BASE}?${params.toString()}`;
    } catch (err) {
      console.warn(`⚠️ Invalid Lidl listing URL (${source.name}): ${err?.message || err}`);
      continue;
    }

    console.log(`  📡 ${source.name}: ${apiUrl}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: source.listingUrl,
          'User-Agent': userAgent,
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`    ⚠️ API returned ${res.status} for ${source.name}`);
        continue;
      }

      const payload = await res.json();
      const hits = Array.isArray(payload?.result?.hits) ? payload.result.hits : [];
      console.log(`    📦 ${source.name}: ${hits.length} hit(s)`);

      for (const hit of hits) {
        const detailUrl = toAbsoluteLidlUrl(hit?.url || '');
        if (!detailUrl || !/\/jobs\//i.test(detailUrl)) continue;

        const reqId = extractReqIdFromHit(hit, detailUrl);
        const pathKey = normalizeLidlDetailPath(detailUrl);
        const key = reqId ? `req:${reqId}` : `path:${pathKey}`;
        const lang = inferHitLanguage(hit, detailUrl);
        const descLen = String(hit?.descResponsibilities || '').length;
        const score = languageScore(lang) + Math.min(8000, descLen) + (hit?.highlight ? 120 : 0);

        const prev = selectedByKey.get(key);
        if (!prev || score > prev.score) {
          selectedByKey.set(key, {
            score,
            detailUrl,
            sourceName: source.name,
            sourceCanton: source.canton,
            reqId,
            hit,
          });
        }
      }
    } catch (err) {
      console.warn(`    ⚠️ Failed to fetch Lidl ${source.name}: ${err?.message || err}`);
    }
  }

  const detailUrls = [];
  for (const item of selectedByKey.values()) {
    detailUrls.push(item.detailUrl);
    seedMetaByUrl[item.detailUrl] = buildSeedMetaFromHit(item.hit, item.sourceCanton);
  }

  detailUrls.sort((a, b) => a.localeCompare(b));
  console.log(`✅ Total unique Lidl detail URLs discovered: ${detailUrls.length}`);
  return { urls: detailUrls, seedMetaByUrl };
}

function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${LIDL_KEY}.json`);
  const notes =
    'Dedicated Lidl crawler seeds from team.lidl.ch search API (/it/search_api/jobsearch) using Ticino and Grigioni italiano geo queries.';

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${LIDL_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: LIDL_KEY,
      companyName: LIDL_COMPANY_NAME,
      companyHost: LIDL_TEAM_HOST,
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
    adapter.companyName = LIDL_COMPANY_NAME;
    adapter.companyHost = LIDL_TEAM_HOST;
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
    console.log(`📝 Adapter ${LIDL_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err?.message || err}`);
  }
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LIDL_KEY,
    localizeOnlyCompanyKeys: LIDL_KEY,
    forceLocalizationWhenAiEnabledOnly: true,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '350',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '350',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

function lidlJobQualityScore(job) {
  const descriptionLength = String(job?.description || '').trim().length;
  const byLocale = job?.descriptionByLocale || {};
  const localeCoverage = ['it', 'en', 'de', 'fr'].reduce((acc, locale) => {
    const txt = String(byLocale?.[locale] || '').trim();
    return acc + (txt.length >= 120 ? 1 : 0);
  }, 0);
  const languageFromUrl = (() => {
    try {
      const match = new URL(String(job?.url || '')).pathname.match(/^\/(it|de|fr|en)\//i);
      return match ? match[1].toLowerCase() : '';
    } catch {
      return '';
    }
  })();
  const trusted = isTrustedLidlDomain(job?.url || '') ? 600 : 0;
  return (
    Math.min(6000, descriptionLength) +
    localeCoverage * 900 +
    languageScore(languageFromUrl) +
    trusted
  );
}

function lidlDedupKey(job) {
  const reqId = extractReqId(String(job?.url || ''));
  if (reqId) return `req:${reqId}`;
  const path = normalizeLidlDetailPath(job?.url || '');
  return path ? `path:${path}` : `fallback:${normalizeKey(job?.title || '')}`;
}

async function fetchLidlPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,it;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`  ⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  }
}

/**
 * For each Lidl job whose description is missing list content or is too short,
 * fetch the detail page and extract the full structured body using
 * parseLidlDetailPage. Updates data/jobs.json with the enriched descriptions.
 *
 * Guards (both must pass for an update):
 *   1. extracted body length >= MIN_LIDL_FULL_DESC (400 chars)
 *   2. extracted body contains at least one "- " bullet line (hasLists)
 */
async function enrichLidlJobDescriptions() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let enriched = 0;

  for (const job of jobs) {
    if (!isLidlJob(job)) continue;
    const currentDesc = String(job.description || '').trim();
    // Skip jobs that already have a full structured description
    if (currentDesc.length >= MIN_LIDL_FULL_DESC && hasListContent(currentDesc)) continue;

    const detailUrl = String(job.url || '').trim();
    if (!detailUrl || !isTrustedLidlDomain(detailUrl)) continue;

    const html = await fetchLidlPage(detailUrl);
    if (!html) continue;

    const extracted = parseLidlDetailPage(html);

    // Both guards must pass
    if (!extracted.meetsMinLength || !extracted.hasLists) {
      console.warn(`  ⚠️ Lidl detail page body too short or lacks lists for "${job.slug || detailUrl}" — skipping.`);
      continue;
    }

    // Only update if the new body is richer than what we have
    if (extracted.body.length <= currentDesc.length && hasListContent(currentDesc)) continue;

    console.log(`  ✨ Enriched "${job.slug || detailUrl}" (${currentDesc.length} → ${extracted.body.length} chars)`);
    job.description = extracted.body;
    if (!job.descriptionByLocale) job.descriptionByLocale = {};
    // Determine locale from URL path (e.g. /de/, /it/)
    const urlLocale = (() => {
      try { const m = new URL(detailUrl).pathname.match(/^\/(it|de|fr|en)\//i); return m ? m[1].toLowerCase() : 'de'; }
      catch { return 'de'; }
    })();
    // Store extracted body under the source locale; other locales get re-derived on next localization run
    if (!job.descriptionByLocale[urlLocale] || extracted.body.length > String(job.descriptionByLocale[urlLocale] || '').length) {
      job.descriptionByLocale[urlLocale] = extracted.body;
    }
    enriched++;
  }

  if (enriched > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    }
    console.log(`✨ Enriched ${enriched} Lidl jobs with full detail-page body.`);
  }
  return enriched;
}

function postProcessLidlJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of allJobs) {
    if (!isLidlJob(job)) continue;

    if (job.company !== LIDL_COMPANY_NAME) {
      job.company = LIDL_COMPANY_NAME;
      fixed += 1;
    }
    if (job.companyKey !== LIDL_KEY) {
      job.companyKey = LIDL_KEY;
      fixed += 1;
    }
    if (job.companyDomain !== LIDL_COMPANY_DOMAIN) {
      job.companyDomain = LIDL_COMPANY_DOMAIN;
      fixed += 1;
    }
    if (job.country !== 'CH') {
      job.country = 'CH';
      fixed += 1;
    }
    if (!String(job?.source || '').trim()) {
      job.source = 'Lidl team.lidl.ch search_api + JSON-LD';
      fixed += 1;
    }
    if (String(job?.url || '').startsWith('/')) {
      job.url = toAbsoluteLidlUrl(job.url);
      fixed += 1;
    }

    if (!job.sourceLang) {
      job.sourceLang = detectLang(job.description || job.title, 'it');
      fixed += 1;
    }

    const lat = Number(job?.latitude || job?.addressLatitude || job?.jobLocation?.latitude);
    const lon = Number(job?.longitude || job?.addressLongitude || job?.jobLocation?.longitude);
    const inferred = inferCantonFromCoordinates(lat, lon, normalize(String(job?.canton || '').toUpperCase()));
    if (inferred && inferred !== job.canton) {
      job.canton = inferred;
      fixed += 1;
    }
  }

  const bestByKey = new Map();
  const toDrop = new Set();
  for (let idx = 0; idx < allJobs.length; idx += 1) {
    const job = allJobs[idx];
    if (!isLidlJob(job)) continue;
    const key = lidlDedupKey(job);
    const score = lidlJobQualityScore(job);
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
    console.log(`🧹 Post-processed ${fixed} Lidl fields.`);
    if (toDrop.size > 0) {
      console.log(`🧯 Deduped ${toDrop.size} Lidl duplicate rows.`);
    }
  }
}

function logLidlJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const lidlJobs = allJobs.filter(isLidlJob);
  const ticinoJobs = lidlJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grJobs = lidlJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = lidlJobs.length - ticinoJobs.length - grJobs.length;

  console.log('\n📊 === Lidl Svizzera Job Stats ===');
  console.log(`  🛒 Job totali trovati (Lidl): ${lidlJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
  }
  console.log('');

  const afterSnapshot = snapshotJobSlugs(lidlJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Lidl');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Lidl');
  return { total: lidlJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateLidlLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LIDL_STRICT',
    label: 'Lidl',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLidlJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedLidlDomain,
    untrustedDomainReason: 'untrusted_domain_for_lidl_job',
    noJobsMessage: 'Nessun job Lidl trovato dopo il crawl — niente da validare.',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LIDL_KEY, 'Lidl');
  console.log('🛒 Running dedicated Lidl Svizzera jobs crawler...');
  console.log('   Source: team.lidl.ch search_api/jobsearch');
  console.log('   Scope: Ticino + Grigioni italiano');
  console.log('');

  const discovery = await fetchLidlJobDetailUrls();
  if (discovery.urls.length === 0) {
    console.log('ℹ️ Nessun URL di dettaglio Lidl trovato dalla search API. Uscita OK.');
    return;
  }

  ensureAdapterSeedUrls(discovery.urls, discovery.seedMetaByUrl);

  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(LIDL_KEY, DATA_JOBS).filter(isLidlJob))

  await runBaseCrawler();
  postProcessLidlJobs();

  // Enrich jobs whose descriptions lack structured list content (full detail body).
  console.log('\n🔍 Checking Lidl jobs for missing full-body descriptions...');
  await enrichLidlJobDescriptions();

  const stats = logLidlJobStats(beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Lidl trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }
  validateLidlLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLidlJob) : [];
  writeJobsCrawlerSlice(LIDL_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LIDL_KEY,
    label: 'Lidl',
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
  console.error(`❌ Lidl crawler failed: ${err?.message || err}`);
  process.exit(1);
});
