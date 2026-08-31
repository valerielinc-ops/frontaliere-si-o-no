#!/usr/bin/env node
/**
 * Dedicated IBSA (Ticino) crawler runner.
 *
 * Source:
 *   https://career.ibsagroup.com/search/?createNewAlert=false&q=&locationsearch=TI%2C+CH&optionsFacetsDD_location=&optionsFacetsDD_customfield1=
 *
 * This script:
 *   1. Fetches IBSA tile-search-results pages for TI, CH.
 *   2. Extracts canonical IBSA detail URLs under /job/.../:jobId/.
 *   3. Updates the IBSA adapter seed URLs + seedMetaByUrl.
 *   4. Runs shared crawler core scoped to IBSA company key.
 *   5. Post-processes rows for canonical consistency + dedupe by IBSA job id.
 *   6. Enforces locale coverage in strict mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError, restoreExistingSlugIdentity } from './lib/crawler-template.mjs';
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
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const IBSA_KEY = 'ibsa-institut-biochimique';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(IBSA_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const DEFAULT_CANTON = getCompanyDefaults(IBSA_KEY)?.canton || 'TI';
const IBSA_COMPANY_NAME = 'IBSA Institut Biochimique';
const IBSA_COMPANY_DOMAIN = 'ibsa.ch';
const IBSA_HOST = 'career.ibsagroup.com';
const IBSA_LISTING_URL =
  'https://career.ibsagroup.com/search/?createNewAlert=false&q=&locationsearch=TI%2C+CH&optionsFacetsDD_location=&optionsFacetsDD_customfield1=';
const IBSA_TILE_ENDPOINT = 'https://career.ibsagroup.com/search/tile-search-results';
const IBSA_LOCALES = ['it', 'en', 'de', 'fr'];

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function toAbsoluteIbsaUrl(rawUrl = '') {
  const decoded = decodeHtmlEntities(rawUrl);
  if (!decoded) return '';
  if (/^https?:\/\//i.test(decoded)) {
    try {
      const url = new URL(decoded);
      url.hash = '';
      return url.href;
    } catch {
      return decoded;
    }
  }
  const pathname = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return `https://${IBSA_HOST}${pathname}`;
}

function canonicalizeIbsaUrl(rawUrl = '') {
  const absolute = toAbsoluteIbsaUrl(rawUrl);
  if (!absolute) return '';
  try {
    const url = new URL(absolute);
    url.hash = '';
    url.search = '';
    if (url.pathname.includes('/job/') && !url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.href;
  } catch {
    return absolute;
  }
}

function extractIbsaJobId(rawUrl = '') {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  const m = url.match(/\/(\d{6,})\/?$/);
  return m ? m[1] : '';
}

function parseListingSearchParams() {
  const url = new URL(IBSA_LISTING_URL);
  const params = new URLSearchParams(url.search || '');
  if (!params.get('q')) params.set('q', '');
  if (!params.get('locationsearch')) params.set('locationsearch', 'TI, CH');
  if (!params.has('optionsFacetsDD_location')) params.set('optionsFacetsDD_location', '');
  if (!params.has('optionsFacetsDD_customfield1')) params.set('optionsFacetsDD_customfield1', '');
  return params;
}

function parsePerPage(html = '') {
  const fromData = html.match(/data-per-page="(\d+)"/i);
  if (fromData) return Math.max(1, Number(fromData[1]));
  const fromScript = html.match(/jobRecordsPerPage:\s*parseInt\("(\d+)"\)/i);
  if (fromScript) return Math.max(1, Number(fromScript[1]));
  return 25;
}

function parseReturnedCount(html = '') {
  const m = html.match(/data-record-returned="(-?\d+)"/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseTotalFound(html = '') {
  const matches = [...String(html || '').matchAll(/of\s+(\d+)\s+Jobs/gi)];
  if (!matches.length) return null;
  const values = matches
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!values.length) return null;
  return Math.max(...values);
}

function extractJobLinksFromTileHtml(html = '') {
  const source = String(html || '');
  const byKey = new Map();
  // Match each quote style separately: IBSA paths legitimately contain an
  // apostrophe in "Collina d'Oro", even when the HTML attribute is double-
  // quoted. A shared [^"'] class silently truncated those URLs.
  const linkPatterns = [
    /(?:data-url|href)="(\/job\/[^"]+)"/gi,
    /(?:data-url|href)='(\/job\/[^']+)'/gi,
  ];
  for (const linkRe of linkPatterns) {
    let match = null;
    while ((match = linkRe.exec(source)) !== null) {
      const raw = decodeHtmlEntities(match[1] || '');
      if (!raw) continue;
      const canonical = canonicalizeIbsaUrl(raw);
      if (!canonical) continue;
      const id = extractIbsaJobId(canonical);
      const key = id ? `id:${id}` : `url:${canonical.toLowerCase()}`;
      if (!byKey.has(key)) {
        byKey.set(key, canonical);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Parse the stable SuccessFactors tile location field together with each
 * canonical detail URL. The tile is the listing source of truth and avoids a
 * second detail request solely to recover PostalAddress metadata.
 */
export function extractIbsaListingsFromTileHtml(html = '') {
  return extractJobLinksFromTileHtml(html).map((url) => {
    const jobId = extractIbsaJobId(url);
    const valueMatch = jobId
      ? String(html || '').match(new RegExp(
        `id=["']job-${jobId}-(?:desktop|tablet)-section-location-value["'][^>]*>([\\s\\S]*?)<\\/div>`,
        'i',
      ))
      : null;
    const rawLocation = decodeHtmlEntities(
      String(valueMatch?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    );
    const parts = rawLocation.split(',').map((part) => part.trim()).filter(Boolean);
    const countryIndex = parts.findIndex((part) => /^[A-Z]{2}$/.test(part) && part === 'CH');
    const city = countryIndex >= 2 ? parts.slice(0, countryIndex - 1).join(', ') : (parts[0] || '');
    const canton = countryIndex >= 1 ? parts[countryIndex - 1] : '';
    const postalCode = countryIndex >= 0 ? (parts[countryIndex + 1] || '') : '';
    return { url, location: city, canton, country: countryIndex >= 0 ? 'CH' : '', postalCode };
  });
}

async function fetchTilePage({ startrow, baseParams, timeoutMs, userAgent }) {
  const params = new URLSearchParams(baseParams);
  params.set('startrow', String(startrow));
  const url = `${IBSA_TILE_ENDPOINT}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html, */*;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: IBSA_LISTING_URL,
        'User-Agent': userAgent,
      },
    });
    const html = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return { url, html };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIbsaJobDetailUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  const baseParams = parseListingSearchParams();
  const detailByKey = new Map();
  const seedMetaByUrl = {};
  const maxPages = 80;
  let perPage = 25;
  let totalFound = null;
  let startrow = 0;

  console.log('🔍 Fetching IBSA jobs from tile-search-results...');

  for (let page = 1; page <= maxPages; page += 1) {
    let html = '';
    let requestUrl = '';
    try {
      const out = await fetchTilePage({ startrow, baseParams, timeoutMs, userAgent });
      html = out.html;
      requestUrl = out.url;
    } catch (err) {
      console.warn(`⚠️ IBSA tile fetch failed at page ${page}: ${err?.message || err}`);
      if (page === 1) throw err;
      break;
    }

    const currentPerPage = parsePerPage(html);
    if (Number.isFinite(currentPerPage) && currentPerPage > 0) {
      perPage = currentPerPage;
    }

    const returned = parseReturnedCount(html);
    const currentTotal = parseTotalFound(html);
    if (Number.isFinite(currentTotal) && currentTotal >= 0) {
      totalFound = currentTotal;
    }

    const listings = extractIbsaListingsFromTileHtml(html);
    const links = listings.map((listing) => listing.url);
    let pageNew = 0;
    for (const listing of listings) {
      const link = listing.url;
      const id = extractIbsaJobId(link);
      const key = id ? `id:${id}` : `url:${link.toLowerCase()}`;
      if (!detailByKey.has(key)) {
        detailByKey.set(key, listing);
        pageNew += 1;
      }
    }

    console.log(
      `  📄 page ${page} (startrow=${startrow}) -> ${links.length} link(s), ${pageNew} new, returned=${returned ?? 'n/a'}, total=${totalFound ?? 'n/a'}`
    );
    if (requestUrl) {
      console.log(`     ${requestUrl}`);
    }

    if (returned !== null && returned <= 0) break;
    if (pageNew === 0) break;
    if (returned !== null && returned < perPage) break;

    startrow += perPage;
    if (Number.isFinite(totalFound) && startrow >= totalFound) break;
  }

  const listings = [...detailByKey.values()];
  const seedUrls = listings.map((listing) => listing.url);
  for (const listing of listings) {
    const detailUrl = listing.url;
    seedMetaByUrl[detailUrl] = {
      location: listing.location || 'Ticino',
      canton: listing.canton || DEFAULT_CANTON,
      country: listing.country || 'CH',
      ...(listing.postalCode ? { postalCode: listing.postalCode } : {}),
      company: IBSA_COMPANY_NAME,
      companyDomain: IBSA_COMPANY_DOMAIN,
    };
  }

  console.log(`✅ Found ${seedUrls.length} unique IBSA detail URL(s).`);
  return { seedUrls, seedMetaByUrl };
}

function updateIbsaAdapter({ seedUrls, seedMetaByUrl }) {
  const adapterPath = path.resolve(ADAPTERS_DIR, `${IBSA_KEY}.json`);
  const fallbackSeeds = [IBSA_LISTING_URL];
  const nextSeedUrls = Array.isArray(seedUrls) && seedUrls.length > 0 ? seedUrls : fallbackSeeds;

  let current = {};
  if (fs.existsSync(adapterPath)) {
    try {
      current = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) || {};
    } catch {
      current = {};
    }
  }

  const next = {
    ...current,
    companyKey: IBSA_KEY,
    companyName: IBSA_COMPANY_NAME,
    companyHost: IBSA_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['generic_ats', 'html', 'jsonld'],
    seedUrls: nextSeedUrls,
    seedMetaByUrl,
    notes:
      'Dedicated IBSA crawler seeds from career.ibsagroup.com TI search and canonicalizes detail URLs under /job/.../:jobId/.',
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(adapterPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  console.log(`🧩 Adapter updated: ${adapterPath}`);
}

function isIbsaJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === IBSA_KEY ||
    key.includes('ibsa') ||
    company.includes('ibsa') ||
    host.endsWith('career.ibsagroup.com') ||
    host.endsWith('ibsagroup.com') ||
    host.endsWith('ibsa.ch')
  );
}

function isTrustedIbsaDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('career.ibsagroup.com') ||
      host.endsWith('ibsagroup.com') ||
      host.endsWith('ibsa.ch')
    );
  } catch {
    return false;
  }
}

function scoreIbsaCandidate(job) {
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const lang = detectLang(`${job?.title || ''} ${job?.description || ''}`, 'it');
  const descLen = String(job?.description || '').trim().length;
  const titleLen = String(job?.title || '').trim().length;

  let score = 0;
  if (host.endsWith('career.ibsagroup.com')) score += 20000;
  else if (host.endsWith('ibsagroup.com') || host.endsWith('ibsa.ch')) score += 12000;
  if (lang === 'it') score += 4000;
  else if (lang === 'en') score += 1500;
  else if (lang === 'de') score += 1100;
  else if (lang === 'fr') score += 900;
  score += Math.min(8000, descLen);
  score += Math.min(2000, titleLen * 20);
  if (job?.titleByLocale?.it) score += 500;
  if (job?.descriptionByLocale?.it) score += 500;
  if (job?.slugByLocale?.it) score += 500;
  return score;
}

function buildIbsaDedupeKey(job) {
  const canonical = canonicalizeIbsaUrl(job?.url || '');
  const id = extractIbsaJobId(canonical);
  if (id) return `id:${id}`;
  const urlKey = canonical ? `url:${canonical.toLowerCase()}` : '';
  if (urlKey) return urlKey;
  const slug = String(job?.slug || '').trim().toLowerCase();
  if (slug) return `slug:${slug}`;
  return `title:${normalize(job?.title || '')}`;
}

function ensureLocaleFields(job) {
  const title = String(job?.title || '').trim();
  const description = String(job?.description || '').trim();
  const titleByLocale = { ...(job?.titleByLocale || {}) };
  const descriptionByLocale = { ...(job?.descriptionByLocale || {}) };
  const slugByLocale = { ...(job?.slugByLocale || {}) };

  for (const locale of IBSA_LOCALES) {
    if (!String(titleByLocale[locale] || '').trim() && title) {
      titleByLocale[locale] = title;
    }
    if (!String(descriptionByLocale[locale] || '').trim() && description) {
      descriptionByLocale[locale] = description;
    }
    if (!String(slugByLocale[locale] || '').trim()) {
      const candidate = deriveLocalizedSlug(job, locale) || job?.slug || '';
      if (candidate) slugByLocale[locale] = candidate;
    }
  }
  return { titleByLocale, descriptionByLocale, slugByLocale };
}

export function normalizeIbsaRow(job, seedMetaByUrl = {}) {
  const canonicalUrl = canonicalizeIbsaUrl(job?.url || '');
  const localeFields = ensureLocaleFields(job);
  const sourceMeta = seedMetaByUrl[canonicalUrl]
    || seedMetaByUrl[canonicalUrl.toLowerCase()]
    || null;
  const sourceLocation = String(sourceMeta?.location || '').trim();
  const sourceCanton = String(sourceMeta?.canton || '').trim();
  const sourcePostalCode = String(sourceMeta?.postalCode || '').trim();
  return {
    ...job,
    url: canonicalUrl || job?.url || '',
    company: IBSA_COMPANY_NAME,
    companyKey: IBSA_KEY,
    companyDomain: IBSA_COMPANY_DOMAIN,
    source: 'Company Careers Crawler',
    sourceLang: detectLang((job?.description || job?.title || ''), 'it'),
    location: sourceLocation || String(job?.location || '').trim() || 'Ticino',
    addressLocality: sourceLocation || String(job?.addressLocality || job?.location || '').trim() || 'Ticino',
    canton: sourceCanton || String(job?.canton || '').trim() || DEFAULT_CANTON,
    addressRegion: sourceCanton || String(job?.addressRegion || job?.canton || '').trim() || DEFAULT_CANTON,
    ...(sourcePostalCode ? { postalCode: sourcePostalCode } : {}),
    country: String(job?.country || '').trim() || 'CH',
    ...localeFields,
  };
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function postProcessIbsaJobs(seedMetaByUrl = {}) {
  if (!fs.existsSync(DATA_JOBS)) return { total: 0, ibsa: 0, deduped: 0 };
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return { total: 0, ibsa: 0, deduped: 0 };

  const bestByKey = new Map();
  for (const job of raw) {
    if (!isIbsaJob(job)) continue;
    const normalizedRow = normalizeIbsaRow(job, seedMetaByUrl);
    const dedupeKey = buildIbsaDedupeKey(normalizedRow);
    const current = bestByKey.get(dedupeKey);
    if (!current || scoreIbsaCandidate(normalizedRow) > scoreIbsaCandidate(current)) {
      bestByKey.set(dedupeKey, normalizedRow);
    }
  }

  const seen = new Set();
  const next = [];
  let ibsaCount = 0;
  let droppedDuplicates = 0;

  for (const job of raw) {
    if (!isIbsaJob(job)) {
      next.push(job);
      continue;
    }
    const normalizedRow = normalizeIbsaRow(job, seedMetaByUrl);
    const dedupeKey = buildIbsaDedupeKey(normalizedRow);
    if (seen.has(dedupeKey)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(dedupeKey);
    const best = bestByKey.get(dedupeKey) || normalizedRow;
    next.push(best);
    ibsaCount += 1;
  }

  writeJobsFiles(next);
  return {
    total: next.length,
    ibsa: ibsaCount,
    deduped: droppedDuplicates,
  };
}

function loadIbsaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return [];
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isIbsaJob);
}

async function runDedicatedIbsaCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: [IBSA_KEY],
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(IBSA_KEY, 'IBSA');
  console.log('🚀 IBSA dedicated crawler start');
  const existingJobs = readExistingCrawlerJobs(IBSA_KEY, DATA_JOBS).filter(isIbsaJob);
  const beforeSnapshot = snapshotJobSlugs(existingJobs);

  const { seedUrls, seedMetaByUrl } = await fetchIbsaJobDetailUrls();
  updateIbsaAdapter({ seedUrls, seedMetaByUrl });

  await runDedicatedIbsaCrawler();
  const post = postProcessIbsaJobs(seedMetaByUrl);
  console.log(`🧹 Post-process IBSA: ${post.ibsa} active, ${post.deduped} duplicate(s) removed.`);

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_IBSA_STRICT',
    label: 'IBSA',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isIbsaJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedIbsaDomain,
    untrustedDomainReason: 'untrusted_ibsa_domain',
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No IBSA jobs found after crawl.',
  });

  // Location corrections are display-data fixes and must not rename already
  // published vacancy paths. Validation performs slug hardening, so re-pin the
  // existing identity at this final boundary; newly discovered jobs remain
  // untouched.
  const validatedJobs = loadIbsaJobs();
  const restored = restoreExistingSlugIdentity(existingJobs, validatedJobs);
  if (restored.restored > 0) {
    writeJsonAtomic(DATA_JOBS, restored.jobs);
    console.log(`  Re-pinned ${restored.restored} existing IBSA slug slot(s) after validation.`);
  }

  const afterSnapshot = snapshotJobSlugs(loadIbsaJobs());
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'IBSA');
  writeCrawlChangeSummaryToGH(diff, 'IBSA');

  console.log('✅ IBSA dedicated crawler completed');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isIbsaJob) : [];
  writeJobsCrawlerSlice(IBSA_KEY, _sliceJobs, { preserveExistingSlugs: true });
  writeSummaryCrawlerSlice({
    key: IBSA_KEY,
    label: 'IBSA',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((err) => exitCrawlerOnError(err, 'IBSA'));
