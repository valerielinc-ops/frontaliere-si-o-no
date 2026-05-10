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
import { hasListContent, MIN_LIDL_FULL_DESC } from './lib/lidl-job-parser.mjs';
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

function stripHtmlToPlain(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#13;/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildJobFromApiHit(hit, detailUrl, sourceCanton) {
  const title = String(hit?.title || '').trim();
  if (!title) return null;

  const desc = stripHtmlToPlain(hit?.descResponsibilities || '');
  const offer = stripHtmlToPlain(hit?.descOffer || '');
  const body = [desc, offer].filter(Boolean).join('\n\n');
  if (!body || body.length < 50) return null;

  const meta = buildSeedMetaFromHit(hit, sourceCanton);
  const lang = inferHitLanguage(hit, detailUrl);
  const slug = normalizeKey(`${title}-${LIDL_KEY}-${meta.location}`);

  return {
    id: '',
    slug,
    slugByLocale: lang ? { [lang]: slug } : { it: slug },
    company: LIDL_COMPANY_NAME,
    companyKey: LIDL_KEY,
    companyDomain: LIDL_COMPANY_DOMAIN,
    title,
    titleByLocale: lang ? { [lang]: title } : { it: title },
    description: body,
    descriptionByLocale: lang ? { [lang]: body } : {},
    location: meta.location,
    canton: meta.canton,
    country: 'CH',
    addressLocality: meta.addressLocality,
    addressRegion: meta.canton,
    addressCountry: 'CH',
    postalCode: String(hit?.location?.postcode || '').trim(),
    streetAddress: String(hit?.location?.address || '').trim(),
    category: '',
    contract: meta.contract || normalizeLidlContract(hit?.contractType || ''),
    datePosted: new Date().toISOString().split('T')[0],
    url: detailUrl,
    applyUrl: hit?.easyApply?.easyApplyUrl || detailUrl,
    source: 'Lidl team.lidl.ch search_api',
    sourceLang: lang || 'it',
    sector: 'Vendita al dettaglio',
    _targetScope: { canton: meta.canton, location: meta.location },
  };
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
  const jobsFromApi = [];
  for (const item of selectedByKey.values()) {
    detailUrls.push(item.detailUrl);
    seedMetaByUrl[item.detailUrl] = buildSeedMetaFromHit(item.hit, item.sourceCanton);
    // Build job directly from API hit (rich description available)
    const apiJob = buildJobFromApiHit(item.hit, item.detailUrl, item.sourceCanton);
    if (apiJob) jobsFromApi.push(apiJob);
  }

  detailUrls.sort((a, b) => a.localeCompare(b));
  console.log(`✅ Total unique Lidl detail URLs discovered: ${detailUrls.length}`);
  console.log(`✅ Jobs built from API data: ${jobsFromApi.length}`);
  return { urls: detailUrls, seedMetaByUrl, jobsFromApi };
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

/**
 * Merge rich descriptions from API hits into existing Lidl jobs in data/jobs.json.
 * The search API returns `descResponsibilities` and `descOffer` with full HTML
 * content, which buildJobFromApiHit() converts to clean plain text. This replaces
 * the old enrichLidlJobDescriptions() which fetched detail pages with broken selectors.
 */
function mergeApiDescriptions(jobsFromApi) {
  if (!jobsFromApi.length || !fs.existsSync(DATA_JOBS)) return 0;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];

  // Index API jobs by URL path and reqId for fast lookup
  const apiByPath = new Map();
  const apiByReqId = new Map();
  for (const apiJob of jobsFromApi) {
    const path = normalizeLidlDetailPath(apiJob.url);
    if (path) apiByPath.set(path, apiJob);
    const reqId = extractReqId(apiJob.url);
    if (reqId) apiByReqId.set(reqId, apiJob);
  }

  let enriched = 0;
  const MAX_SANE_DESC = 8000; // Descriptions >8k chars are likely full-page HTML garbage
  for (const job of jobs) {
    if (!isLidlJob(job)) continue;
    const currentDesc = String(job.description || '').trim();
    const isSaneLength = currentDesc.length >= MIN_LIDL_FULL_DESC && currentDesc.length <= MAX_SANE_DESC;
    // Skip jobs that already have a real, well-sized description with structure
    if (isSaneLength && hasListContent(currentDesc)) continue;

    // Match by reqId first, then by URL path
    const reqId = extractReqId(job.url);
    const apiJob = (reqId && apiByReqId.get(reqId)) || apiByPath.get(normalizeLidlDetailPath(job.url));
    if (!apiJob) continue;

    const apiDesc = String(apiJob.description || '').trim();
    // Only skip if current desc is sane AND longer than API (bloated descs always lose)
    if (isSaneLength && apiDesc.length <= currentDesc.length) continue;

    console.log(`  ✨ Enriched "${job.slug || job.url}" from API (${currentDesc.length} → ${apiDesc.length} chars)`);
    job.description = apiDesc;
    if (!job.descriptionByLocale) job.descriptionByLocale = {};
    const lang = apiJob.sourceLang || 'it';
    if (!job.descriptionByLocale[lang] || apiDesc.length > String(job.descriptionByLocale[lang] || '').length) {
      job.descriptionByLocale[lang] = apiDesc;
    }
    // Backfill location data from API if missing
    if (!job.postalCode && apiJob.postalCode) job.postalCode = apiJob.postalCode;
    if (!job.streetAddress && apiJob.streetAddress) job.streetAddress = apiJob.streetAddress;
    enriched++;
  }

  if (enriched > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    }
    console.log(`✨ Enriched ${enriched} Lidl jobs with API descriptions.`);
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

  // Second-pass dedup keyed on (normalized title, normalized location).
  // The reqId-based key above lets through Lidl's multilingual re-publications
  // of the same opening (same role + same filiale, two different reqIds —
  // e.g. an Apprendistato in Locarno listed once in DE and once in IT). The
  // audit's title-aware fingerprint flags those as duplicate listings, so
  // collapse them here keeping the highest-scoring copy.
  const bestByTitleCity = new Map();
  for (let idx = 0; idx < allJobs.length; idx += 1) {
    if (toDrop.has(idx)) continue;
    const job = allJobs[idx];
    if (!isLidlJob(job)) continue;
    const titleKey = normalizeKey(job?.title || '');
    const locKey = normalizeKey(job?.addressLocality || job?.location || '');
    if (!titleKey || !locKey) continue;
    const key = `tc:${titleKey}@${locKey}`;
    const score = lidlJobQualityScore(job);
    const prev = bestByTitleCity.get(key);
    if (!prev) {
      bestByTitleCity.set(key, { idx, score });
      continue;
    }
    if (score > prev.score) {
      toDrop.add(prev.idx);
      bestByTitleCity.set(key, { idx, score });
    } else {
      toDrop.add(idx);
    }
  }

  // Third pass: when the same source title is published across multiple
  // distinct cities (Lidl ships every per-filiale apprendistato with the
  // same generic title), append the city to disambiguate. This keeps each
  // per-city listing visible while resolving the title-aware fingerprint
  // collision the audit flags as DUPLICATE LISTINGS.
  const titleGroups = new Map();
  for (let idx = 0; idx < allJobs.length; idx += 1) {
    if (toDrop.has(idx)) continue;
    const job = allJobs[idx];
    if (!isLidlJob(job)) continue;
    const titleKey = normalizeKey(job?.title || '');
    const locKey = normalizeKey(job?.addressLocality || job?.location || '');
    if (!titleKey || !locKey) continue;
    const cities = titleGroups.get(titleKey) || new Set();
    cities.add(locKey);
    titleGroups.set(titleKey, cities);
  }
  let disambiguated = 0;
  for (const job of allJobs) {
    if (!isLidlJob(job)) continue;
    const titleKey = normalizeKey(job?.title || '');
    if (!titleKey) continue;
    const cities = titleGroups.get(titleKey);
    if (!cities || cities.size <= 1) continue;
    const city = String(job?.addressLocality || job?.location || '').trim();
    if (!city) continue;
    const titleStr = String(job?.title || '').trim();
    if (!titleStr) continue;
    const suffix = ` — ${city}`;
    if (titleStr.toLowerCase().includes(city.toLowerCase())) continue;
    job.title = `${titleStr}${suffix}`;
    if (job.titleByLocale && typeof job.titleByLocale === 'object') {
      for (const lang of Object.keys(job.titleByLocale)) {
        const localized = String(job.titleByLocale[lang] || '').trim();
        if (!localized || localized.toLowerCase().includes(city.toLowerCase())) continue;
        job.titleByLocale[lang] = `${localized}${suffix}`;
      }
    }
    disambiguated += 1;
    fixed += 1;
  }
  if (disambiguated > 0) {
    console.log(`🔤 Disambiguated ${disambiguated} Lidl titles with city suffix.`);
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

  // Merge rich descriptions from API hits into jobs created by base crawler
  console.log('\n🔍 Merging API descriptions into Lidl jobs...');
  mergeApiDescriptions(discovery.jobsFromApi);

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
