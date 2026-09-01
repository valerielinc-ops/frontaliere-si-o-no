#!/usr/bin/env node
/**
 * Dedicated Fust crawler runner.
 *
 * Fust is a national household-electronics retailer (subsidiary of the Coop
 * Group) with stores throughout all of Switzerland, so this crawler collects
 * Fust jobs CH-wide across all 26 cantons (Cathedral). It uses the same
 * Prospective.ch JobBooster platform as Coop (Career Center 1000103).
 *
 * This script:
 *   1. Fetches the Prospective.ch JSON API server-side filtered to the Fust
 *      subsidiary alone (attribute 70 = company, filter id 1114045 — see
 *      "Company filter" below), no canton facet, paginating through the full
 *      national result set.
 *   2. Client-side company-text check as a defensive second layer only (the
 *      server-side filter above is what actually keeps other Coop-group
 *      subsidiaries out — see #5975).
 *   3. Drops any Fust job whose canton label doesn't resolve to a Swiss
 *      canton (CH-only gate — foreign/unresolved postings are dropped, never
 *      defaulted to TI).
 *   4. Declares those verified pages as adapter seedDetailUrls.
 *   5. Runs the base crawler to fetch JSON-LD JobPosting data from each page.
 *   6. Re-tags discovered jobs with companyKey "fust".
 *   7. Translates missing locales and validates coverage.
 *
 * Attribute 30 provides the API canton used by the CH-only gate. The final
 * canton is derived from the real detail-page workplace; the API value may
 * only disambiguate a known homonym or act as a telemetered fallback when the
 * shared CH resolver has no candidate at all.
 *
 * Detail pages live at jobs.fust.ch and contain JSON-LD JobPosting. Their
 * structured location is the Oberbüren headquarters, so the real workplace
 * is read from the visible/analytics detail-page fields instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exitCrawlerOnError, slugify } from './lib/crawler-template.mjs';
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
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  replaceActiveSlug,
  detectLang,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { inferAnyCanton, isKnownSwissMunicipality } from './lib/target-swiss-locations.mjs';
import { SWISS_CANTONS } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const FUST_KEY = 'fust';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(FUST_KEY);
const FUST_SUMMARY_SLICE = path.resolve(ROOT, 'data', 'jobs-crawler-summaries', 'by-crawler', `${FUST_KEY}.json`);
const FUST_SUMMARY_SLICE_REL = path.relative(ROOT, FUST_SUMMARY_SLICE).split(path.sep).join('/');
const FUST_COMPANY_NAME = 'Fust';
const FUST_SLUG_MAX_LENGTH = 90;

/**
 * Prospective.ch API — same medium as Coop (1000103), shared by Fust, Jumbo,
 * Interdiscount and other Coop-group subsidiaries.
 *
 * CH-wide fetch: no canton facet (`f=30:{cantonId}`), so the API returns every
 * Fust job across all 26 cantons. Company scoping IS server-side, via the
 * `f=70:{FUST_COMPANY_FILTER_ID}` attribute filter (mirrors the pattern in
 * jumbo-job-parser.mjs / interdiscount-job-parser.mjs) — the medium's
 * `/attributes` endpoint lists attribute 70 ("Azienda") value 1114045 as
 * "Fust". Before #5975 this query had NO company filter at all: it fetched
 * every subsidiary unfiltered and relied on a client-side substring check
 * against `attributes['70'][0]`, which does not reliably identify the true
 * per-job employer on this shared multi-brand medium — 78% of the resulting
 * fust.json entries turned out to belong to Jumbo/Interdiscount/Coop/etc.
 * Verified live: `f=70:1114045` returns exactly the Fust subsidiary's jobs,
 * all tagged `company: "Fust"`.
 *
 *   https://ohws.prospective.ch/public/v1/medium/1000103/jobs?lang=it&offset=0&limit=500&f=70:1114045
 *
 * Per-job canton comes from attribute 30 (a localized canton label such as
 * "Zurigo", "Vallese", "San Gallo", "Ticino"), resolved CH-wide by
 * inferAnyCanton.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';
const API_LIMIT = 500; // max jobs per request
const API_MAX_PAGES = 20; // hard ceiling: 20 * 500 = 10000 jobs (safety stop)
// Attribute 70 ("Azienda") value id for "Fust" on medium 1000103 (Coop Group
// career center) — confirmed against /public/v1/medium/1000103/attributes.
const FUST_COMPANY_FILTER_ID = '1114045';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const FUST_DETAIL_HOST = 'jobs.fust.ch';
const FUST_DETAIL_CONCURRENCY = 8;
const FUST_DETAIL_FETCH_ATTEMPTS = 2;

/** @typedef {{ fetchImpl?: typeof globalThis.fetch, enrichDetails?: boolean }} FustDiscoveryOptions */
/** @typedef {{ workplace: string, canton: string }} FustCantonFallback */
/**
 * @typedef {Object} FustSeedMeta
 * @property {string} location
 * @property {string} canton
 * @property {string} title
 * @property {string} sourceId
 * @property {string} [company]
 * @property {string} [contract]
 * @property {string} [postedDate]
 */
/**
 * @typedef {Object} FustDiscoveryResult
 * @property {string[]} urls
 * @property {Record<string, FustSeedMeta>} seedMetaByUrl
 * @property {number} apiTotal
 * @property {number} droppedMalformedUrl
 * @property {number} droppedDuplicateIdentity
 * @property {number} workplaceCount
 * @property {FustCantonFallback[]} unknownCantonFallbacks
 */
/**
 * @typedef {Object} FustCrawlDiff
 * @property {object[]} newJobs
 * @property {object[]} updatedJobs
 * @property {object[]} removedJobs
 * @property {object[]} [unchangedJobs]
 * @property {number} unchangedCount
 */
/**
 * @typedef {Object} FustPublishSummary
 * @property {string} key
 * @property {string} label
 * @property {string} generatedAt
 * @property {number} total
 * @property {number} newCount
 * @property {number} updatedCount
 * @property {number} removedCount
 * @property {number} unchangedCount
 * @property {number} durationMs
 * @property {number} avgDurationMs
 * @property {number[]} durationHistory
 * @property {object[]} newJobs
 * @property {object[]} updatedJobs
 * @property {object[]} removedJobs
 * @property {object[]} unchangedJobs
 */
/**
 * @typedef {Object} FustPublishPlan
 * @property {object[]} sliceJobs
 * @property {FustCrawlDiff} crawlDiff
 * @property {FustPublishSummary} summary
 */
/** @typedef {void | Promise<void>} FustMaybePromise */
/**
 * @typedef {Object} FustPublishOptions
 * @property {boolean} [authoritativeEmpty]
 * @property {object[]} [priorJobs]
 * @property {(key: string, jobs: object[], options: {skipShrinkGuard: boolean}) => FustMaybePromise} [writeSlice]
 * @property {(key: string, jobs: object[], options: {isTargetJob: (job: object) => boolean}) => FustMaybePromise} [writeVerified]
 * @property {(jobs: object[], key: string) => number | Promise<number>} [archive]
 * @property {(summary: FustPublishSummary) => FustMaybePromise} [writeSummary]
 * @property {() => FustMaybePromise} [assemble]
 */
/**
 * @typedef {FustPublishOptions & {
 *   readSummary?: () => object | null | Promise<object | null>,
 *   writeScratch?: (discovery: FustDiscoveryResult, priorJobs: object[]) => object[],
 *   durationMs?: number,
 *   generatedAt?: string,
 * }} FustEmptyPublishOptions
 */

/* ── Matchers ──────────────────────────────────────────────── */
// A present `company` field is authoritative (it comes from the scraped
// JSON-LD detail page, i.e. the real employer): a job whose company text
// names another Coop-group subsidiary is NOT Fust even if its companyKey was
// mistakenly stamped 'fust' upstream (#5975 — companyKey alone used to be
// sufficient here, which is exactly how 259 Jumbo/Interdiscount/Coop jobs
// ended up counted as Fust). companyKey is only trusted as a fallback when
// company is missing.
export function isFustJob(job) {
  const company = normalize(job?.company || '');
  if (company) return company.includes('fust');
  const key = normalizeKey(job?.companyKey || '');
  return key === FUST_KEY || key.includes('fust');
}

/**
 * Resolve a Prospective.ch attribute-30 canton label (e.g. "Zurigo",
 * "Vallese", "San Gallo", "Ticino") to a 2-letter Swiss canton code, CH-wide.
 * Returns '' (never a TI default) when the label doesn't resolve to a Swiss
 * canton — the caller uses that to drop foreign/unresolved postings.
 */
function normalizeCantonCode(raw = '', fallback = '') {
  const label = String(raw || '').trim();
  if (!label) return fallback || '';
  return inferAnyCanton(label) || fallback || '';
}

function cantonLabel(canton = '') {
  return canton || '';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job, fallbackCanton = '') {
  const attr30 = String(job?.attributes?.['30']?.[0] || '').trim();
  // Canton inferred from the clean attribute-30 label ALONE (never a combined
  // "city + region" string, which would mislead inferAnyCanton).
  const canton = normalizeCantonCode(attr30, fallbackCanton);
  const apiCity = String(job?.location || job?.place || job?.city || job?.address?.city || '').trim();
  const location = apiCity || attr30 || cantonLabel(canton || fallbackCanton);
  const company = String(job?.attributes?.['70']?.[0] || job?.company || '').trim();
  const contract = String(job?.attributes?.['40']?.[0] || '').trim();
  return {
    location,
    canton: canton || fallbackCanton,
    title: String(job?.title || '').trim(),
    sourceId: String(job?.id || '').trim(),
    ...(company ? { company } : {}),
    ...(contract ? { contract } : {}),
    ...(job?.date || job?.datePosted
      ? { postedDate: dateOnly(job?.date || job?.datePosted) }
      : {}),
  };
}

function decodeCodePoint(raw, radix) {
  const codePoint = Number.parseInt(raw, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => decodeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => decodeCodePoint(code, 16))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeFustWorkplace(value = '') {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\([\\'"/])/g, '$1')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prospective's JSON-LD always stamps Fust's Oberbüren headquarters as the
 * job location. The visible detail page carries the real workplace in the
 * `job_arbeitsort` analytics field (and in a localized workplace section).
 */
export function extractFustWorkplaceFromHtml(html = '') {
  const source = String(html || '');
  const singleQuoted = source.match(/\bjob_arbeitsort\s*:\s*'((?:\\.|[^'\\])*)'/i);
  const doubleQuoted = source.match(/\bjob_arbeitsort\s*:\s*"((?:\\.|[^"\\])*)"/i);
  const analyticsValue = singleQuoted?.[1] || doubleQuoted?.[1] || '';
  const analyticsWorkplace = normalizeFustWorkplace(analyticsValue);
  if (analyticsWorkplace && analyticsWorkplace.toLowerCase() !== 'fust') return analyticsWorkplace;

  const section = source.match(
    /<h4[^>]*>\s*(?:<b[^>]*>)?\s*(?:arbeitsort|lieu\s+de\s+travail|luogo\s+di\s+lavoro)\s*(?:<\/b>)?\s*<\/h4>\s*<p[^>]*>([\s\S]{0,500}?)<\/p>/i
  );
  const addressLines = String(section?.[1] || '')
    .split(/<br\s*\/?\s*>/i)
    .map((line) => normalizeFustWorkplace(line))
    .filter((line) => line && line.toLowerCase() !== 'fust');
  const workplaceLine = addressLines.at(-1) || '';
  return normalizeFustWorkplace(workplaceLine.replace(/^\d{4}\s+/, ''));
}

/**
 * Resolve the canton from the verified detail-page workplace, never from the
 * pre-detail API region. `inferAnyCanton` handles unambiguous municipalities;
 * BFS entries stored as "<name> (XX)" need each canton as a hint. Exactly one
 * workplace match is authoritative. When several municipalities share the
 * name, the API canton may disambiguate only if the workplace helper validates
 * that exact pair; otherwise publishing would invent geography.
 *
 * @param {string} [workplace]
 * @param {string} [apiCanton]
 * @param {{onUnknownFallback?: (fallback: FustCantonFallback) => void}} [options]
 * @returns {string}
 */
export function deriveFustWorkplaceCanton(workplace = '', apiCanton = '', options = {}) {
  const location = normalizeFustWorkplace(workplace);
  const direct = inferAnyCanton(location);
  if (direct) return direct;

  const hinted = Object.keys(SWISS_CANTONS)
    .filter((canton) => isKnownSwissMunicipality(location, canton));
  if (hinted.length === 1) return hinted[0];
  const normalizedApiCanton = String(apiCanton || '').trim().toUpperCase();
  if (hinted.length > 1 && hinted.includes(normalizedApiCanton)) return normalizedApiCanton;
  if (hinted.length === 0 && SWISS_CANTONS[normalizedApiCanton]) {
    options.onUnknownFallback?.({ workplace: location, canton: normalizedApiCanton });
    return normalizedApiCanton;
  }

  const reason = hinted.length > 1
    ? `ambiguous across ${hinted.join(', ')}`
    : 'not resolvable to a Swiss municipality';
  throw new Error(`Fust workplace canton invariant failed: "${location || '(empty)'}" is ${reason}.`);
}

function canonicalizeFustDetailUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== FUST_DETAIL_HOST) return '';
    if (url.search || url.hash) return '';
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!/^\/(?:offene-stellen|postes-vacants|posti-vacanti)\//i.test(pathname)) return '';
    const canonicalUrl = `https://${FUST_DETAIL_HOST}${pathname}`;
    return extractStableJobId(canonicalUrl).startsWith('uuid:') ? canonicalUrl : '';
  } catch {
    return '';
  }
}

export function isCanonicalFustDetailUrl(rawUrl = '') {
  return Boolean(canonicalizeFustDetailUrl(rawUrl));
}

async function fetchFustWorkplace(rawUrl, { fetchImpl, timeoutMs }) {
  for (let attempt = 1; attempt <= FUST_DETAIL_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rawUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
      });
      if (!res.ok) continue;
      const workplace = extractFustWorkplaceFromHtml(await res.text());
      if (workplace) return workplace;
    } catch {
      // A bounded retry below keeps a transient detail failure from forging
      // Oberbüren as the workplace or aborting an otherwise coherent listing.
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

async function enrichFustSeedMetadata(urls, seedMetaByUrl, options) {
  const { fetchImpl, timeoutMs } = options;
  const concurrency = Math.max(1, Math.min(
    FUST_DETAIL_CONCURRENCY,
    Number(process.env.JOBS_FUST_DETAIL_CONCURRENCY) || FUST_DETAIL_CONCURRENCY
  ));
  let cursor = 0;
  let enriched = 0;
  const unknownCantonFallbacks = [];

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const url = urls[index];
      const workplace = await fetchFustWorkplace(url, { fetchImpl, timeoutMs });
      if (!workplace) continue;
      const canton = deriveFustWorkplaceCanton(workplace, seedMetaByUrl[url]?.canton, {
        onUnknownFallback: (fallback) => unknownCantonFallbacks.push(fallback),
      });
      seedMetaByUrl[url].location = workplace;
      seedMetaByUrl[url].canton = canton;
      enriched += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return { enriched, unknownCantonFallbacks };
}

/* ── API Discovery ─────────────────────────────────────────── */
/**
 * Fetch Fust job detail URLs from the Prospective.ch JSON API CH-wide.
 *
 * Uses a single UNFILTERED query (no canton facet) paginated over the full
 * national result set. Keeps only the Fust subsidiary (company attribute 70 =
 * "Fust"), and drops any Fust posting whose canton label doesn't resolve to a
 * Swiss canton (CH-only gate — never defaulted to TI).
 *
 * @param {FustDiscoveryOptions} [options]
 * @returns {Promise<FustDiscoveryResult>}
 */
export async function fetchFustJobUrls(options = {}) {
  /** @type {Set<string>} */
  const allUrls = new Set();
  /** @type {Record<string, Record<string, string>>} */
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const enrichDetails = options.enrichDetails !== false;

  /** Canton distribution for logging (2-letter code → count). */
  const cantonCounts = {};
  let apiTotal = null;
  let fetched = 0;
  let fustFound = 0;
  let droppedNonCh = 0;
  let droppedMalformedUrl = 0;
  let droppedDuplicateIdentity = 0;
  const stableIds = new Set();

  for (let page = 0; page < API_MAX_PAGES; page += 1) {
    const offset = page * API_LIMIT;
    const params = new URLSearchParams({
      lang: 'it',
      offset: String(offset),
      limit: String(API_LIMIT),
    });
    // Company filter: Fust (server-side — see FUST_COMPANY_FILTER_ID above).
    params.append('f', `70:${FUST_COMPANY_FILTER_ID}`);
    const apiUrl = `${API_BASE}/jobs?${params}`;
    console.log(`🔍 Fetching Coop Group feed CH-wide page ${page + 1} (offset ${offset})…`);

    let jobs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(apiUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) {
        console.warn(`⚠️ API returned ${res.status} at offset ${offset} — stopping pagination.`);
        break;
      }

      const data = await res.json();
      jobs = assertJsonListShape(data, { key: 'jobs', source: 'fust', lang: `offset:${offset}` });
      if (apiTotal === null && typeof data?.total === 'number') apiTotal = data.total;
    } catch (err) {
      console.warn(`⚠️ API fetch failed at offset ${offset}: ${err.message}`);
      break;
    } finally {
      clearTimeout(timer);
    }

    if (jobs.length === 0) break;
    fetched += jobs.length;

    for (const job of jobs) {
      const company = normalize(job?.attributes?.['70']?.[0] || job?.company || '');
      if (!company.includes('fust')) continue; // keep only the Fust subsidiary
      fustFound++;

      const directLink = canonicalizeFustDetailUrl(job?.links?.directlink || '');
      if (!directLink) {
        droppedMalformedUrl += 1;
        continue;
      }
      const stableId = extractStableJobId(directLink);
      if (stableIds.has(stableId)) {
        droppedDuplicateIdentity += 1;
        continue;
      }
      if (allUrls.has(directLink)) continue;

      const meta = buildSeedMetaFromApiJob(job);
      // CH-only gate: drop foreign/unresolved postings whose label doesn't
      // resolve to a Swiss canton (never defaulted to TI).
      if (!meta.canton) { droppedNonCh += 1; continue; }

      allUrls.add(directLink);
      stableIds.add(stableId);
      seedMetaByUrl[directLink] = meta;
    }

    console.log(`  📦 page ${page + 1}: ${jobs.length} jobs (cumulative ${fetched}${apiTotal !== null ? `/${apiTotal}` : ''})`);

    // Drained the full result set.
    if (apiTotal !== null && offset + jobs.length >= apiTotal) break;
    if (jobs.length < API_LIMIT) break;
  }

  // A partial listing must never become an authoritative destructive snapshot.
  if (apiTotal === null) {
    throw new Error('Fust discovery invariant failed: API response did not expose a numeric total.');
  }
  if (fetched < apiTotal) {
    throw new Error(`Fust discovery incomplete: fetched ${fetched}/${apiTotal} API jobs (API_MAX_PAGES=${API_MAX_PAGES}).`);
  }
  if (
    allUrls.size !== apiTotal
    || fustFound !== apiTotal
    || droppedNonCh > 0
    || droppedMalformedUrl > 0
    || droppedDuplicateIdentity > 0
  ) {
    throw new Error(
      `Fust discovery invariant failed: API=${apiTotal}, matched=${fustFound}, canonical=${allUrls.size}, non-CH=${droppedNonCh}, malformed=${droppedMalformedUrl}, duplicate identity=${droppedDuplicateIdentity}.`
    );
  }

  const urls = [...allUrls];
  let workplaceCount = 0;
  let unknownCantonFallbacks = [];
  if (enrichDetails && urls.length > 0) {
    ({ enriched: workplaceCount, unknownCantonFallbacks } = await enrichFustSeedMetadata(
      urls,
      seedMetaByUrl,
      { fetchImpl, timeoutMs },
    ));
    if (workplaceCount !== urls.length) {
      throw new Error(`Fust workplace invariant failed: enriched ${workplaceCount}/${urls.length} canonical details.`);
    }
  }
  for (const url of urls) {
    const canton = seedMetaByUrl[url]?.canton;
    if (canton) cantonCounts[canton] = (cantonCounts[canton] || 0) + 1;
  }

  console.log(`\n📋 Fust API Discovery Summary (CH-wide):`);
  console.log(`  API total: ${apiTotal ?? '?'} · Fust matched: ${fustFound} · dropped non-CH/unresolved: ${droppedNonCh} · dropped malformed/off-host URLs: ${droppedMalformedUrl} · duplicate identities: ${droppedDuplicateIdentity} · unique detail URLs: ${allUrls.size}`);
  if (enrichDetails) {
    console.log(`  Real workplace metadata: ${workplaceCount}/${urls.length} detail pages (canton derived from workplace)`);
    if (unknownCantonFallbacks.length > 0) {
      console.log(`  ⚠️ Unknown-place API canton fallback (${unknownCantonFallbacks.length}): ${unknownCantonFallbacks.map(({ workplace, canton }) => `${workplace}→${canton}`).join(', ')}`);
    }
  }
  const sortedCantons = Object.entries(cantonCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  Cantons seen (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log(`✅ Total unique Fust detail URLs discovered: ${allUrls.size}\n`);
  return {
    urls,
    seedMetaByUrl,
    apiTotal,
    droppedMalformedUrl,
    droppedDuplicateIdentity,
    workplaceCount,
    unknownCantonFallbacks,
  };
}

/* ── Adapter ───────────────────────────────────────────────── */
export function buildFustAdapterConfig(
  baseAdapter,
  seedDetailUrls,
  seedMetaByUrl = {},
  updatedAt = new Date().toISOString(),
) {
  const adapter = {
    ...(baseAdapter || {}),
    seedDetailUrls,
    seedMetaByUrl,
    updatedAt,
  };
  // The Prospective feed already proves that every canonical UUID is a Fust
  // vacancy detail. Keeping the same URLs as generic seeds makes non-DE/IT
  // routes pass through the listing heuristic before the explicit detail path.
  delete adapter.seedUrls;
  return adapter;
}

function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${FUST_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${FUST_KEY}.json not found — creating it.`);
    const adapter = buildFustAdapterConfig({
      companyKey: FUST_KEY,
      companyName: FUST_COMPANY_NAME,
      companyHost: 'fust.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      notes: 'Fust (Coop Group) — Prospective.ch JobBooster (Career Center 1000103, server-side filtered to attribute 70=1114045 "Fust"). Canonical detail pages on jobs.fust.ch; real workplace enriched from page analytics.',
    }, seedUrls, seedMetaByUrl);
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = buildFustAdapterConfig(
      JSON.parse(fs.readFileSync(adapterPath, 'utf-8')),
      seedUrls,
      seedMetaByUrl,
    );
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${FUST_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Re-tag existing Fust jobs ─────────────────────────────── */
function retagFustJobs() {
  if (!fs.existsSync(DATA_JOBS)) return 0;

  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return 0;

  let retagged = 0;
  for (const job of raw) {
    const company = normalize(job?.company || '');
    if (company.includes('fust') && job.companyKey !== FUST_KEY) {
      job.companyKey = FUST_KEY;
      retagged++;
    }
    if (isFustJob(job) && !job.sourceLang) {
      job.sourceLang = detectLang((job.description || job.title || ''), 'de');
    }
  }

  if (retagged > 0) {
    writeJsonAtomic(DATA_JOBS, raw);
    const publicPath = path.resolve(ROOT, 'public', 'data', 'jobs.json');
    if (fs.existsSync(publicPath)) {
      writeJsonAtomic(publicPath, raw);
    }
    console.log(`🔄 Re-tagged ${retagged} existing Fust jobs from coop-ticino → ${FUST_KEY}`);
  }
  return retagged;
}

function fustStableKey(jobOrUrl) {
  const rawUrl = typeof jobOrUrl === 'string' ? jobOrUrl : jobOrUrl?.url;
  return extractStableJobId(rawUrl || '');
}

function jobPayloadScore(job = {}) {
  return String(job.description || '').length
    + String(job.title || '').length
    + Object.keys(job.titleByLocale || {}).length * 100
    + Object.keys(job.descriptionByLocale || {}).length * 100;
}

function buildFustSlug(job, title, location, locale = '') {
  const localizedTitle = String(job?.titleByLocale?.[locale] || title || '').trim();
  const locationSlug = slugify(location, 32);
  const suffix = [slugify(FUST_COMPANY_NAME), locationSlug].filter(Boolean).join('-');
  const titleBudget = Math.max(24, 90 - suffix.length - 1);
  return [slugify(localizedTitle, titleBudget), suffix].filter(Boolean).join('-');
}

/**
 * Make the server-side Fust listing the authoritative allowlist after the
 * generic engine merge. This removes stale prior URLs and generic-discovery
 * noise, while preserving the stable id/slug/history of every still-listed
 * job matched by the UUID embedded in its canonical detail URL.
 */
export function reconcileFustJobsWithDiscovery(jobs, discovery, priorJobs = []) {
  const sourceByKey = new Map();
  for (const url of discovery?.urls || []) {
    if (!isCanonicalFustDetailUrl(url)) {
      throw new Error(`Fust discovery contains a non-canonical detail URL: ${url}`);
    }
    const key = fustStableKey(url);
    if (!key || sourceByKey.has(key)) {
      throw new Error(`Fust discovery contains a duplicate/unstable identity: ${url}`);
    }
    sourceByKey.set(key, { url, meta: discovery?.seedMetaByUrl?.[url] || {} });
  }

  const crawledByKey = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = fustStableKey(job);
    if (!sourceByKey.has(key)) continue;
    const previous = crawledByKey.get(key);
    if (!previous || jobPayloadScore(job) > jobPayloadScore(previous)) {
      crawledByKey.set(key, job);
    }
  }

  const missingKeys = [...sourceByKey.keys()].filter((key) => !crawledByKey.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Fust completeness invariant failed: ${missingKeys.length}/${sourceByKey.size} authoritative jobs were not parsed (${missingKeys.slice(0, 5).join(', ')})`
    );
  }

  const priorByKey = new Map();
  for (const job of Array.isArray(priorJobs) ? priorJobs : []) {
    const key = fustStableKey(job);
    if (sourceByKey.has(key) && !priorByKey.has(key)) priorByKey.set(key, job);
  }

  return [...sourceByKey.entries()].map(([key, source]) => {
    const job = crawledByKey.get(key);
    const prior = priorByKey.get(key);
    const meta = source.meta || {};
    const location = String(meta.location || job.location || '').trim();
    const canton = String(meta.canton || job.canton || '').trim().toUpperCase();
    const title = String(job.title || meta.title || '').trim();
    const isHeadquarters = normalize(location) === normalize('Oberbüren');
    const previousSlugs = [...new Set([
      ...(Array.isArray(job.previousSlugs) ? job.previousSlugs : []),
      ...(Array.isArray(prior?.previousSlugs) ? prior.previousSlugs : []),
    ].filter(Boolean))];
    const previousSlugsByLocale = {};
    for (const locale of new Set([
      ...Object.keys(job.previousSlugsByLocale || {}),
      ...Object.keys(prior?.previousSlugsByLocale || {}),
    ])) {
      previousSlugsByLocale[locale] = [...new Set([
        ...(Array.isArray(job.previousSlugsByLocale?.[locale]) ? job.previousSlugsByLocale[locale] : []),
        ...(Array.isArray(prior?.previousSlugsByLocale?.[locale]) ? prior.previousSlugsByLocale[locale] : []),
      ].filter(Boolean))];
    }
    const slug = prior?.slug || buildFustSlug(job, title, location);
    const slugByLocale = prior
      ? { ...(job.slugByLocale || {}), ...(prior.slugByLocale || {}) }
      : Object.fromEntries(Object.keys(job.slugByLocale || {}).map((locale) => [
        locale,
        buildFustSlug(job, title, location, locale),
      ]));
    return {
      ...job,
      ...(prior?.id ? { id: prior.id } : {}),
      slug,
      ...(Object.keys(slugByLocale).length > 0 ? { slugByLocale } : {}),
      ...(job.titleByLocale ? { titleByLocale: { ...job.titleByLocale } } : {}),
      ...(job.descriptionByLocale ? { descriptionByLocale: { ...job.descriptionByLocale } } : {}),
      ...(previousSlugs.length > 0 ? { previousSlugs } : {}),
      ...(Object.keys(previousSlugsByLocale).length > 0 ? { previousSlugsByLocale } : {}),
      url: source.url,
      company: FUST_COMPANY_NAME,
      companyKey: FUST_KEY,
      title,
      location,
      addressLocality: location,
      canton,
      addressRegion: canton,
      ...(!isHeadquarters ? { postalCode: '', streetAddress: '' } : {}),
      _targetScope: {
        type: 'adapter_seed_meta',
        location,
        canton,
      },
    };
  });
}

function stableSlugSuffix(job = {}) {
  const idSuffix = String(job.id || '').replace(/^company-/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (idSuffix.length >= 6) return idSuffix.slice(0, 10);
  // A UUID prefix alone is not an identity: two canonical jobs can share the
  // first 10 characters. This fallback is used only when the generated
  // company id is unavailable/too short, so keep the complete canonical UUID
  // to make the disambiguation deterministic and collision-free.
  return fustStableKey(job).replace(/^[^:]+:/, '').replace(/[^a-z0-9]/gi, '') || 'job';
}

function appendStableSlugSuffix(slug, job) {
  const suffix = stableSlugSuffix(job);
  const cleanSlug = String(slug || '').replace(/-+$/, '');
  if (cleanSlug.endsWith(`-${suffix}`)) return cleanSlug;
  const baseBudget = Math.max(1, FUST_SLUG_MAX_LENGTH - suffix.length - 1);
  const boundedBase = cleanSlug.slice(0, baseBudget).replace(/-+$/, '') || 'job';
  return `${boundedBase}-${suffix}`;
}

/**
 * Locale slugs are stable for already-published jobs. Only a newcomer that
 * collides with an existing/current slug receives its deterministic job-id
 * suffix; the shared colliding slug is not added to previousSlugs because it
 * belongs to the keeper and cannot be a redirect for two identities.
 */
export function ensureUniqueFustSlugs(jobs, priorJobs = []) {
  const result = (Array.isArray(jobs) ? jobs : []).map((job) => ({
    ...job,
    ...(job.slugByLocale ? { slugByLocale: { ...job.slugByLocale } } : {}),
  }));
  const priorKeys = new Set((Array.isArray(priorJobs) ? priorJobs : []).map(fustStableKey).filter(Boolean));
  const scopes = new Set(['slug']);
  for (const job of result) {
    for (const locale of Object.keys(job.slugByLocale || {})) scopes.add(locale);
  }

  for (const scope of scopes) {
    const bySlug = new Map();
    for (const job of result) {
      const slug = scope === 'slug' ? job.slug : job.slugByLocale?.[scope];
      if (!slug) continue;
      const normalized = String(slug).trim().toLowerCase();
      const bucket = bySlug.get(normalized) || [];
      bucket.push(job);
      bySlug.set(normalized, bucket);
    }

    for (const colliding of [...bySlug.values()].filter((bucket) => bucket.length > 1)) {
      const keeper = colliding.find((job) => priorKeys.has(fustStableKey(job)))
        || [...colliding].sort((a, b) => fustStableKey(a).localeCompare(fustStableKey(b)))[0];
      for (const job of colliding) {
        if (job === keeper) continue;
        if (scope === 'slug') {
          replaceActiveSlug(job, appendStableSlugSuffix(job.slug, job), {
            // The un-suffixed collision remains live on the keeper, so it is
            // not this job's redirect history.
            capturePrevious: false,
          });
        } else {
          replaceActiveSlug(job, appendStableSlugSuffix(job.slugByLocale[scope], job), {
            locale: scope,
            // See the canonical collision rationale above.
            capturePrevious: false,
          });
        }
      }
    }

    const stableValues = result
      .map((job) => scope === 'slug' ? job.slug : job.slugByLocale?.[scope])
      .filter(Boolean)
      .map((slug) => String(slug).trim().toLowerCase());
    if (new Set(stableValues).size !== stableValues.length) {
      throw new Error(`Fust slug invariant failed after deterministic disambiguation (${scope}).`);
    }
  }
  return result;
}

function readScratchJobs() {
  if (!fs.existsSync(DATA_JOBS)) return [];
  const parsed = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  return Array.isArray(parsed) ? parsed : [];
}

function writeReconciledFustScratch(discovery, priorJobs) {
  const scratchJobs = readScratchJobs();
  const reconciled = reconcileFustJobsWithDiscovery(scratchJobs, discovery, priorJobs);
  const stable = ensureUniqueFustSlugs(reconciled, priorJobs);
  writeJsonAtomic(DATA_JOBS, stable);
  console.log(`🧭 Fust authoritative reconciliation: ${scratchJobs.length} parsed/retained → ${stable.length} canonical identities, stable slugs enforced.`);
  return stable;
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: FUST_KEY,
    localizeOnlyCompanyKeys: FUST_KEY,
    forceLocalizeKeys: FUST_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

/* ── Stats & Validation ────────────────────────────────────── */
/**
 * @param {object[]} jobs
 * @param {Map<string, object>} [beforeSnapshot]
 * @param {{durationMs?: number, generatedAt?: string}} [options]
 * @returns {FustPublishPlan}
 */
export function buildFustPublishPlan(
  jobs,
  beforeSnapshot = new Map(),
  { durationMs = 0, generatedAt = new Date().toISOString() } = {},
) {
  const sliceJobs = (Array.isArray(jobs) ? jobs : []).filter(isFustJob);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, snapshotJobSlugs(sliceJobs));
  return {
    sliceJobs,
    crawlDiff,
    summary: {
      key: FUST_KEY,
      label: 'Fust',
      generatedAt,
      total: sliceJobs.length,
      newCount: crawlDiff.newJobs.length,
      updatedCount: crawlDiff.updatedJobs.length,
      removedCount: crawlDiff.removedJobs.length,
      unchangedCount: crawlDiff.unchangedCount,
      durationMs,
      avgDurationMs: durationMs,
      durationHistory: [durationMs],
      newJobs: crawlDiff.newJobs.slice(0, 30),
      updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
      removedJobs: crawlDiff.removedJobs.slice(0, 30),
      unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
    },
  };
}

function logStats(plan) {
  const jobs = plan.sliceJobs;

  // CH-wide canton distribution (2-letter code → count).
  const byCanton = {};
  for (const job of jobs) {
    const code = String(job?.canton || '').toUpperCase() || '??';
    byCanton[code] = (byCanton[code] || 0) + 1;
  }
  const sortedCantons = Object.entries(byCanton).sort((a, b) => b[1] - a[1]);

  console.log(`\n📊 === Fust Job Stats (CH-wide) ===`);
  console.log(`  🏪 Total Fust jobs: ${jobs.length}`);
  console.log(`  🇨🇭 Cantons covered (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log('');

  const crawlDiff = plan.crawlDiff;
  printCrawlChangeSummary(crawlDiff, 'Fust');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Fust');

  return { total: jobs.length, crawlDiff };
}

/**
 * Persist one internally-coherent jobs+summary snapshot. A verified API
 * `total=0` is stronger evidence than probing stale detail URLs one by one,
 * so that one case archives the prior jobs and bypasses only the generic
 * anti-shrink guard for the empty write.
 *
 * @param {FustPublishPlan} plan
 * @param {FustPublishOptions} [options]
 * @returns {Promise<{total: number, archived: number}>}
 */
export async function writeFustPublishPlan(plan, options = {}) {
  const {
    authoritativeEmpty = false,
    priorJobs = [],
    writeSlice = writeJobsCrawlerSlice,
    writeVerified = writeJobsCrawlerSliceVerified,
    archive = archiveRemovedJobsToSlice,
    writeSummary = writeSummaryCrawlerSlice,
    assemble = assembleJobsDataset,
  } = options;

  if (!plan || !Array.isArray(plan.sliceJobs) || !plan.summary) {
    throw new TypeError('writeFustPublishPlan requires a jobs+summary plan.');
  }
  if (plan.summary.total !== plan.sliceJobs.length) {
    throw new Error(`Fust publish invariant failed: summary=${plan.summary.total}, slice=${plan.sliceJobs.length}.`);
  }

  let archived = 0;
  if (authoritativeEmpty) {
    if (plan.sliceJobs.length !== 0) {
      throw new Error('Fust authoritative-empty write refused: slice is not empty.');
    }
    archived = await archive(priorJobs, FUST_KEY);
    await writeSlice(FUST_KEY, plan.sliceJobs, { skipShrinkGuard: true });
  } else {
    await writeVerified(FUST_KEY, plan.sliceJobs, { isTargetJob: isFustJob });
  }
  await writeSummary(plan.summary);
  await assemble();
  return { total: plan.sliceJobs.length, archived };
}

/**
 * Reads the Fust summary slice as the source of empty-snapshot confirmation
 * state. Corrupt or unexpected-shape content (e.g. truncated JSON from an
 * interrupted write, or a shape written by tooling this crawler doesn't
 * recognize) degrades to "no prior confirmation" (null) instead of crashing
 * the crawler: `emptySnapshotRunCount(null)` is 0, which only ever delays
 * authoritative-empty archival by one more confirmation cycle — never causes
 * a wrongful bulk-archive of live Fust vacancies. A hard crash here would be
 * strictly worse for the funnel (no job-board update at all for that run) for
 * state that isn't required to be perfect, only safe-to-reset.
 */
function parseFustSummaryJson(raw, warnPrefix) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`⚠️ ${warnPrefix} is not valid JSON (${error.message}) — treating as no prior confirmation.`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`⚠️ ${warnPrefix} is not a JSON object — treating as no prior confirmation.`);
    return null;
  }
  return parsed;
}

export function readFustSummarySlice() {
  if (!fs.existsSync(FUST_SUMMARY_SLICE)) return null;
  let raw;
  try {
    raw = fs.readFileSync(FUST_SUMMARY_SLICE, 'utf8');
  } catch (error) {
    console.warn(`⚠️ Fust empty-snapshot confirmation state could not be read (${error.message}) — treating as no prior confirmation.`);
    return null;
  }
  return parseFustSummaryJson(raw, 'Fust empty-snapshot confirmation state');
}

/**
 * Live variant of readFustSummarySlice(): reads the confirmation state from
 * `origin/main` instead of the local checkout. Two Fust crawler runs whose
 * execution windows overlap (crawl + discovery, several minutes) each read
 * their OWN pre-run local checkout in handleFustEmptyDiscovery(), so the
 * previous local-only read made the race window the full run duration
 * instead of the sub-second gap between a live read and the eventual push
 * (#6803): both runs would see `authoritativeEmptyConsecutiveRuns=0` and
 * both take the "first observation" branch, so neither ever confirms.
 * Fetching+reading `origin/main` immediately before the decision lets a run
 * that starts after another run's write see that write instead of stale
 * local state, shrinking the race window to the (still nonzero, but much
 * smaller) gap between this read and the eventual commit+push.
 *
 * Any git failure (no repo, offline, sandboxed test run, no `origin` remote,
 * summary not yet present on origin/main) falls back to the local-file read
 * — this never throws, matching the fail-soft philosophy of
 * readFustSummarySlice() above.
 */
export function readFustSummarySliceLive() {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
    const raw = execFileSync('git', ['show', `origin/main:${FUST_SUMMARY_SLICE_REL}`], { cwd: ROOT, encoding: 'utf8' });
    return parseFustSummaryJson(raw, 'Fust empty-snapshot confirmation state (origin/main)');
  } catch {
    return readFustSummarySlice();
  }
}

function emptySnapshotRunCount(summary) {
  const raw = summary?.authoritativeEmptyConsecutiveRuns;
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error('Fust empty-snapshot confirmation counter must be a non-negative integer.');
  }
  return raw;
}

/**
 * A coherent `total=0` is destructive only after two consecutive successful
 * observations. The first observation writes a durable marker into Fust's
 * already-versioned summary slice while preserving the jobs slice verbatim.
 * Any later successful non-empty publication overwrites that summary without
 * the marker, resetting the sequence by construction.
 *
 * @param {FustDiscoveryResult} discovery
 * @param {object[]} priorJobs
 * @param {ReturnType<typeof snapshotJobSlugs>} beforeSnapshot
 * @param {FustEmptyPublishOptions} [options]
 */
export async function handleFustEmptyDiscovery(discovery, priorJobs, beforeSnapshot, options = {}) {
  if (discovery?.apiTotal !== 0 || (discovery?.urls || []).length !== 0) {
    throw new Error('Fust empty-snapshot confirmation requires an internally coherent total=0 discovery.');
  }

  const {
    readSummary = readFustSummarySliceLive,
    writeScratch = writeReconciledFustScratch,
    durationMs = getCrawlerElapsedMs(),
    generatedAt,
    writeSummary = writeSummaryCrawlerSlice,
    ...publishOptions
  } = options;
  const previousSummary = await readSummary();
  const priorEmptyRuns = emptySnapshotRunCount(previousSummary);

  if (priorEmptyRuns < 1) {
    const preservedPlan = buildFustPublishPlan(priorJobs, beforeSnapshot, { durationMs, generatedAt });
    await writeSummary({
      ...preservedPlan.summary,
      authoritativeEmptyConsecutiveRuns: 1,
      authoritativeEmptyPending: true,
    });
    return { confirmed: false, total: priorJobs.length, archived: 0 };
  }

  const emptyJobs = writeScratch(discovery, priorJobs);
  const emptyPlan = buildFustPublishPlan(emptyJobs, beforeSnapshot, { durationMs, generatedAt });
  const result = await writeFustPublishPlan(emptyPlan, {
    ...publishOptions,
    authoritativeEmpty: true,
    priorJobs,
    writeSummary,
  });
  return { confirmed: true, ...result };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_FUST_STRICT',
    label: 'Fust',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isFustJob,
    noJobsMessage: 'No Fust jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(FUST_KEY, 'Fust');
  console.log('🏪 Running dedicated Fust jobs crawler...');
  console.log('   Platform: Prospective.ch JobBooster (Career Center 1000103, Coop Group)');
  console.log('   Scope: CH-wide (all 26 cantons, unfiltered national query; Fust subsidiary only)');
  console.log('');

  // Step 0: Re-tag existing Fust jobs that may have coop-ticino key
  retagFustJobs();

  // Step 1: Discover Fust job URLs from the Prospective.ch API
  const discovery = await fetchFustJobUrls();
  const detailUrls = discovery.urls;

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls, discovery.seedMetaByUrl);

  // Snapshot before crawl for diff summary and slug-stability precedence.
  // The per-crawler slice is already scoped to Fust. Do not re-filter it by
  // mutable company text: a localized/mislabelled prior record must still keep
  // its published identity when its canonical UUID is present in discovery.
  const _priorJobs = readExistingCrawlerJobs(FUST_KEY, DATA_JOBS);
  const _beforeSnapshot = snapshotJobSlugs(_priorJobs);

  // A numeric API total of zero has passed every discovery completeness
  // invariant above, but a single internally-coherent zero can still be an
  // upstream cache/WAF incident. Persist the first observation without
  // touching the jobs slice; only a second consecutive zero is authoritative.
  if (discovery.apiTotal === 0) {
    const result = await handleFustEmptyDiscovery(discovery, _priorJobs, _beforeSnapshot, {
      durationMs: getCrawlerElapsedMs(),
    });
    if (result.confirmed) {
      console.log(`✅ Fust authoritative empty snapshot confirmed and published (${result.archived} prior job(s) removed).`);
    } else {
      console.log(`⚠️ Fust empty snapshot pending confirmation; preserved ${result.total} prior job(s).`);
    }
    return;
  }

  // Step 3: Run the base crawler (fetches JSON-LD from detail pages)
  await runBaseCrawler();

  // Step 4: Re-tag any newly crawled Fust jobs
  retagFustJobs();
  writeReconciledFustScratch(discovery, _priorJobs);

  // Step 5: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isFustJob,
  });
  // Translation/local-hardening may fill locale slugs. Re-run the deterministic
  // collision pass so housekeeping never has to delete a valid sibling job.
  writeReconciledFustScratch(discovery, _priorJobs);

  // Step 6: Stats + validation
  const _durationMs = getCrawlerElapsedMs();
  const _plan = buildFustPublishPlan(readScratchJobs(), _beforeSnapshot, { durationMs: _durationMs });
  const stats = logStats(_plan);
  if (stats.total === 0) throw new Error('Fust parser produced zero jobs for a non-empty authoritative snapshot.');

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  await writeFustPublishPlan(_plan);
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
  main().catch((err) => exitCrawlerOnError(err, 'Fust'));
}
