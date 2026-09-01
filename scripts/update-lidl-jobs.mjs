#!/usr/bin/env node
/**
 * Dedicated Lidl Svizzera crawler runner.
 * Lidl Svizzera is a national discount retailer, so this crawler collects Lidl
 * jobs CH-wide (all 26 cantons) and enforces full locale coverage for
 * SEO-critical fields.
 *
 * Data source:
 *   team.lidl.ch LiCa search API (used by the public "Cerca opportunità" page):
 *   GET /it/api/v1/search?general={"page":N,"resultsPerPage":20,...}
 *     -> JSON with jobs[] and meta { totalCount, resultsPerPage, page }
 *   (The legacy /it/search_api/jobsearch endpoint was retired when Lidl migrated
 *   the careers site to the LiCa SPA platform — it now 404s.)
 *
 * This script:
 *   1. Reads the national count, then drains the source-declared language
 *      facets independently. Each facet is strict-count paginated and their
 *      totals must equal the national total exactly.
 *   2. Extracts unique job detail URLs from API hits.
 *   3. Infers each job's canton from the clean city signal via inferAnyCanton
 *      and drops jobs whose canton does not resolve to a Swiss canton.
 *   4. Updates the Lidl adapter seed URLs + seedMetaByUrl.
 *   5. Runs base crawler for detail parsing/localization.
 *   6. Post-processes and deduplicates Lidl jobs for canonical consistency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import MUNICIPALITY_DATA from '../data/canton-municipalities.json' with { type: 'json' };
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
import {
  hasListContent,
  MIN_LIDL_FULL_DESC,
  LIDL_SEARCH_API_BASE,
  LIDL_SEARCH_JOBS_KEY,
  LIDL_DEFAULT_RESULTS_PER_PAGE,
  buildLidlSearchQuery,
  getLidlSearchPageCount,
  extractLidlSearchLanguagePartitions,
  extractLidlApiHitFields,
} from './lib/lidl-job-parser.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LIDL_KEY = 'lidl-svizzera';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(LIDL_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const LIDL_COMPANY_NAME = 'Lidl Svizzera';
const LIDL_TEAM_HOST = 'team.lidl.ch';
const LIDL_COMPANY_DOMAIN = 'lidl.ch';
// Page size requested from the LiCa search API via the `general.resultsPerPage`
// param (LIDL_SEARCH_API_BASE / pagination contract live in lidl-job-parser.mjs).
const LIDL_RESULTS_PER_PAGE =
  Number(process.env.JOBS_LIDL_RESULTS_PER_PAGE) || LIDL_DEFAULT_RESULTS_PER_PAGE;
// Safety cap on the number of national pages to fetch (server returns up to 20
// jobs/page; the full Lidl Svizzera careers feed is ~18 pages / ~357 jobs).
const LIDL_MAX_PAGES = Number(process.env.JOBS_LIDL_MAX_PAGES) || 60;

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const LIDL_EXPLICIT_CITY_CANTONS = (() => {
  const candidatesByCity = new Map();
  for (const [canton, entry] of Object.entries(MUNICIPALITY_DATA.cantons || {})) {
    const values = [...(entry?.municipalities || []), ...(entry?.aliases || [])];
    for (const rawValue of values) {
      const city = String(rawValue || '').replace(/\s*\([A-Z]{2}\)\s*$/i, '');
      const key = normalizeKey(city);
      if (!key) continue;
      if (!candidatesByCity.has(key)) candidatesByCity.set(key, new Set());
      candidatesByCity.get(key).add(canton);
    }
  }
  return candidatesByCity;
})();

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

function extractReqIdFromFields(fields, detailUrl = '') {
  // LiCa API exposes the requisition id directly (extractLidlApiHitFields).
  const fromRequisition = extractReqId(fields?.requisitionId || '');
  if (fromRequisition) return fromRequisition;
  const easyApply = String(fields?.applyUrl || '').trim();
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

function inferFieldsLanguage(fields, detailUrl = '') {
  const lang = normalize(String(fields?.language || ''));
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

/**
 * Resolve a job's canton CH-wide from the cleanest single signal — the bare
 * `location.city` string — via the central inferAnyCanton helper (26 cantons).
 * The city string MUST be passed alone: a combined "city + region" string makes
 * inferAnyCanton return the wrong canton because of TARGET_CANTONS array order.
 * Returns a 2-letter Swiss canton code, or '' when the location does not
 * resolve to any Swiss canton (caller drops such jobs — never default to TI).
 */
export function inferLidlCanton(fields) {
  const city = String(fields?.city || '').trim();
  const country = String(fields?.country || '').trim().toUpperCase();
  if (!city || country !== 'CH') return '';

  const inferred = inferAnyCanton(city);
  if (inferred) return inferred;

  // `inferAnyCanton` intentionally suppresses ambiguous everyday-word tokens
  // in free prose (Bulle, Rolle, Court, Sâles). LiCa's `location.city` is an
  // authoritative address field, not prose: accept an exact BFS municipality
  // or alias only when it maps to one canton. The fallback never guesses exact
  // homonyms, while already-resolved cities retain their historical behavior.
  const exactCandidates = LIDL_EXPLICIT_CITY_CANTONS.get(normalizeKey(city));
  if (exactCandidates) {
    return exactCandidates.size === 1 ? [...exactCandidates][0] : '';
  }
  return '';
}

function normalizeLidlContract(raw = '') {
  const value = normalize(String(raw || ''));
  if (!value) return '';
  if (value.includes('apprend') || value.includes('lehre') || value.includes('apprent')) return 'Apprendistato';
  if (value.includes('teilzeit') || value.includes('part-time') || value.includes('part time')) return 'Part-time';
  if (value.includes('vollzeit') || value.includes('full-time') || value.includes('full time')) return 'Full-time';
  if (/\bstages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(value) || value.includes('praktikum') || /\bintern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(value)) return 'Stage';
  return String(raw || '').trim();
}

function stripHtmlToPlain(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#13;/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildJobFromApiFields(fields, detailUrl) {
  const title = String(fields?.title || '').trim();
  if (!title) return null;

  // The LiCa API bundles the whole job body (intro + tasks + profile + offer)
  // into descResponsibilities (mapped to fields.descriptionHtml).
  const body = stripHtmlToPlain(fields?.descriptionHtml || '');
  if (!body || body.length < 50) return null;

  const meta = buildSeedMetaFromFields(fields);
  // Drop jobs whose location does not resolve to a Swiss canton (non-CH /
  // unresolved). Never default to TI.
  if (!meta.canton) return null;
  const lang = inferFieldsLanguage(fields, detailUrl);
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
    postalCode: String(fields?.zipCode || '').trim(),
    streetAddress: String(fields?.address || '').trim(),
    category: '',
    contract: meta.contract || normalizeLidlContract(fields?.contractType || ''),
    datePosted: new Date().toISOString().split('T')[0],
    url: detailUrl,
    applyUrl: fields?.applyUrl || detailUrl,
    source: 'Lidl team.lidl.ch api/v1/search',
    sourceLang: lang || 'it',
    sector: 'Vendita al dettaglio',
    _targetScope: { canton: meta.canton, location: meta.location },
  };
}

function buildSeedMetaFromFields(fields) {
  const canton = inferLidlCanton(fields);
  const city = String(fields?.city || '').trim();
  const locationTitle = String(fields?.locationName || '').trim();
  const address = String(fields?.address || '').trim();
  const location = city || locationTitle || address;
  const contract = normalizeLidlContract(fields?.contractType || '');
  return {
    location,
    addressLocality: location,
    canton,
    country: 'CH',
    company: LIDL_COMPANY_NAME,
    companyDomain: LIDL_COMPANY_DOMAIN,
    ...(contract ? { contract } : {}),
  };
}

async function fetchLidlSearchPage(
  page,
  { userAgent, timeoutMs, fetchImpl = globalThis.fetch, language = '' },
) {
  // The LiCa API paginates via a JSON-encoded `general` object, NOT a bare
  // `page=N` query param (that one is silently ignored — meta.page stays 1).
  // Query + base URL contract live in lidl-job-parser.mjs (single source of truth).
  const apiUrl = `${LIDL_SEARCH_API_BASE}?${buildLidlSearchQuery(
    page,
    LIDL_RESULTS_PER_PAGE,
    language,
  )}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(apiUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://team.lidl.ch/it/cerca-opportunita',
        'User-Agent': userAgent,
      },
    });
    if (!res.ok) {
      const scope = language ? `language ${language}` : 'national';
      throw new Error(`Lidl discovery failed: API returned ${res.status} for ${scope} page ${page}.`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function canonicalizeLidlDetailUrl(rawUrl = '', reqId = '') {
  try {
    const parsed = new URL(toAbsoluteLidlUrl(rawUrl));
    parsed.protocol = 'https:';
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    const match = parsed.pathname.match(/^\/(it|de|fr|en)\/jobs\/[^/]*-(\d{5,})$/i);
    if (parsed.hostname.toLowerCase() !== LIDL_TEAM_HOST || !match || !reqId || match[2] !== reqId) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export async function fetchLidlJobDetailUrls(options = {}) {
  const selectedByKey = new Map();
  const seedMetaByUrl = {};
  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  // The national envelope is authoritative for the total and language facet
  // counts, but its unfiltered pagination is not: live intermediate pages can
  // be short while meta.totalCount remains unchanged. Drain each source-backed
  // language facet independently and require exact parity with the national
  // count, preserving CH-wide coverage without weakening completeness.
  console.log('🔍 Fetching Lidl jobs CH-wide from count-bound language partitions...');

  let droppedNonCh = 0;
  let droppedMalformed = 0;
  let duplicateIdentity = 0;
  let rawFetched = 0;
  const nationalPayload = await fetchLidlSearchPage(1, { userAgent, timeoutMs, fetchImpl });
  const nationalHits = assertJsonListShape(nationalPayload, {
    key: LIDL_SEARCH_JOBS_KEY,
    source: 'lidl:national:page1',
  });
  const totalCount = Number(nationalPayload?.meta?.totalCount);
  const nationalPerPage = Number(nationalPayload?.meta?.resultsPerPage);
  const nationalPage = Number(nationalPayload?.meta?.page);
  const nationalCount = Number(nationalPayload?.meta?.count);
  if (!Number.isInteger(totalCount) || totalCount < 0
      || nationalPerPage !== LIDL_RESULTS_PER_PAGE
      || nationalPage !== 1
      || nationalCount !== nationalHits.length
      || nationalHits.length > LIDL_RESULTS_PER_PAGE) {
    throw new Error(
      `Lidl discovery envelope invalid on national page 1: total=${nationalPayload?.meta?.totalCount ?? '?'}, perPage=${nationalPayload?.meta?.resultsPerPage ?? '?'}, page=${nationalPayload?.meta?.page ?? '?'}, count=${nationalPayload?.meta?.count ?? '?'}, hits=${nationalHits.length}.`,
    );
  }

  const partitions = extractLidlSearchLanguagePartitions(nationalPayload.meta);
  const totalPartitionPages = partitions.reduce(
    (total, partition) => total + getLidlSearchPageCount(
      { totalCount: partition.count, resultsPerPage: LIDL_RESULTS_PER_PAGE },
      LIDL_RESULTS_PER_PAGE,
    ),
    0,
  );
  if (totalPartitionPages > LIDL_MAX_PAGES) {
    throw new Error(
      `Lidl discovery incomplete: ${totalPartitionPages} partition pages exceed LIDL_MAX_PAGES=${LIDL_MAX_PAGES}.`,
    );
  }
  console.log(
    `    📦 Reported national results: ${totalCount} (${partitions.map(({ language, count }) => `${language}:${count}`).join(', ') || 'empty'})`,
  );

  for (const partition of partitions) {
    const pageCount = getLidlSearchPageCount(
      { totalCount: partition.count, resultsPerPage: LIDL_RESULTS_PER_PAGE },
      LIDL_RESULTS_PER_PAGE,
    );
    let partitionFetched = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      const payload = await fetchLidlSearchPage(page, {
        userAgent,
        timeoutMs,
        fetchImpl,
        language: partition.language,
      });
      const metaTotal = Number(payload?.meta?.totalCount);
      const metaPerPage = Number(payload?.meta?.resultsPerPage);
      const metaPage = Number(payload?.meta?.page);
      const metaCount = Number(payload?.meta?.count);
      const hits = assertJsonListShape(payload, {
        key: LIDL_SEARCH_JOBS_KEY,
        source: `lidl:${partition.language}:page${page}`,
      });
      if (!Number.isInteger(metaTotal) || metaTotal < 0
          || !Number.isInteger(metaPerPage) || metaPerPage <= 0
          || metaPerPage !== LIDL_RESULTS_PER_PAGE
          || !Number.isInteger(metaPage) || metaPage !== page
          || !Number.isInteger(metaCount) || metaCount !== hits.length) {
        throw new Error(
          `Lidl discovery envelope invalid on ${partition.language} page ${page}: total=${payload?.meta?.totalCount ?? '?'}, perPage=${payload?.meta?.resultsPerPage ?? '?'}, page=${payload?.meta?.page ?? '?'}, count=${payload?.meta?.count ?? '?'}, hits=${hits.length}.`,
        );
      }
      if (metaTotal !== partition.count) {
        throw new Error(
          `Lidl discovery total drift: ${partition.language} page ${page} reports ${metaTotal}, expected ${partition.count}.`,
        );
      }
      const expectedPageCount = page < pageCount
        ? LIDL_RESULTS_PER_PAGE
        : partition.count - (pageCount - 1) * LIDL_RESULTS_PER_PAGE;
      if (hits.length !== expectedPageCount) {
        throw new Error(
          `Lidl discovery incomplete: ${partition.language} page ${page} returned ${hits.length}/${expectedPageCount} expected hits.`,
        );
      }
      rawFetched += hits.length;
      partitionFetched += hits.length;
      console.log(`    📡 ${partition.language} page ${page}: ${hits.length} hit(s)`);

      for (const hit of hits) {
        // Normalize the LiCa hit once; all downstream consumers read `fields`.
        const fields = extractLidlApiHitFields(hit);
        if (fields.language !== partition.language) {
          throw new Error(
            `Lidl discovery facet mismatch: ${partition.language} returned language ${fields.language || '?'}.`,
          );
        }
        const reqId = extractReqIdFromFields(fields, fields.detailUrl);
        const detailUrl = canonicalizeLidlDetailUrl(fields.detailUrl, reqId);
        if (!detailUrl) {
          droppedMalformed += 1;
          continue;
        }

        // Drop jobs whose location does not resolve to a Swiss canton
        // (non-CH / unresolved). Never default to TI.
        const canton = inferLidlCanton(fields);
        if (!canton) {
          droppedNonCh += 1;
          continue;
        }

        const key = `req:${reqId}`;
        const lang = inferFieldsLanguage(fields, detailUrl);
        const descLen = String(fields.descriptionHtml || '').length;
        const score = languageScore(lang) + Math.min(8000, descLen) + (fields.highlight ? 120 : 0);

        const prev = selectedByKey.get(key);
        if (prev) duplicateIdentity += 1;
        if (!prev || score > prev.score) {
          selectedByKey.set(key, { score, detailUrl, reqId, fields });
        }
      }
    }
    if (partitionFetched !== partition.count) {
      throw new Error(
        `Lidl discovery incomplete: ${partition.language} fetched ${partitionFetched}/${partition.count} API hits.`,
      );
    }
  }

  if (rawFetched !== totalCount) {
    throw new Error(`Lidl discovery incomplete: fetched ${rawFetched}/${totalCount} API hits.`);
  }

  const detailUrls = [];
  const jobsFromApi = [];
  for (const item of selectedByKey.values()) {
    detailUrls.push(item.detailUrl);
    seedMetaByUrl[item.detailUrl] = buildSeedMetaFromFields(item.fields);
    // Build job directly from API fields (rich description available)
    const apiJob = buildJobFromApiFields(item.fields, item.detailUrl);
    if (!apiJob) {
      throw new Error(`Lidl discovery invariant failed: canonical hit ${item.reqId} lacks a rich CH API job.`);
    }
    jobsFromApi.push(apiJob);
  }

  detailUrls.sort((a, b) => a.localeCompare(b));
  const accounted = detailUrls.length + duplicateIdentity + droppedNonCh + droppedMalformed;
  if (accounted !== rawFetched
      || droppedNonCh !== 0
      || droppedMalformed !== 0
      || jobsFromApi.length !== detailUrls.length
      || Object.keys(seedMetaByUrl).length !== detailUrls.length) {
    throw new Error(
      `Lidl discovery invariant failed: fetched=${rawFetched}, accounted=${accounted}, canonical=${detailUrls.length}, duplicates=${duplicateIdentity}, non-CH=${droppedNonCh}, malformed=${droppedMalformed}, metadata=${Object.keys(seedMetaByUrl).length}, rich=${jobsFromApi.length}.`
    );
  }
  if (droppedNonCh > 0) {
    console.log(`  🚫 Dropped ${droppedNonCh} Lidl hit(s) not resolving to a Swiss canton.`);
  }
  console.log(`✅ Total unique Lidl detail URLs discovered: ${detailUrls.length}`);
  console.log(`✅ Jobs built from API data: ${jobsFromApi.length}`);
  return {
    urls: detailUrls,
    seedMetaByUrl,
    jobsFromApi,
    totalCount,
    rawFetched,
    duplicateIdentity,
    droppedNonCh,
    droppedMalformed,
    sourceZero: totalCount === 0,
  };
}

export function buildLidlAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl = {}, updatedAt = new Date().toISOString()) {
  const notes =
    'Dedicated Lidl crawler seeds from team.lidl.ch LiCa search API (/it/api/v1/search), drained through count-bound language partitions whose totals equal the national CH-wide feed; per-job canton inferred from the city signal.';
  return {
    ...(baseAdapter || {}),
    companyName: LIDL_COMPANY_NAME,
    companyHost: LIDL_TEAM_HOST,
    seedUrls,
    seedMetaByUrl,
    priority: Math.max(baseAdapter?.priority || 0, 10),
    crawlerModes: Array.from(new Set(['generic_ats', ...(baseAdapter?.crawlerModes || []), 'html', 'jsonld'])),
    notes,
    updatedAt,
  };
}

export function assertLidlAdapterParity(adapter, seedUrls, seedMetaByUrl = {}) {
  if (!isDeepStrictEqual(adapter?.seedUrls, seedUrls)
      || !isDeepStrictEqual(adapter?.seedMetaByUrl, seedMetaByUrl)) {
    throw new Error('Lidl adapter parity failed: persisted seeds differ from the complete LiCa feed.');
  }
  return true;
}

export function ensureAdapterSeedUrls(
  seedUrls,
  seedMetaByUrl = {},
  adapterPath = path.join(ADAPTERS_DIR, `${LIDL_KEY}.json`),
  updatedAt = new Date().toISOString(),
) {
  const baseAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: LIDL_KEY,
      companyName: LIDL_COMPANY_NAME,
      companyHost: LIDL_TEAM_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
    };
  const adapter = buildLidlAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl, updatedAt);
  writeJsonAtomic(adapterPath, adapter);
  const persisted = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  assertLidlAdapterParity(persisted, seedUrls, seedMetaByUrl);
  console.log(`📝 Adapter ${LIDL_KEY} updated with ${seedUrls.length} seed URLs (LiCa parity verified).`);
  return persisted;
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LIDL_KEY,
    localizeOnlyCompanyKeys: LIDL_KEY,
    forceLocalizationWhenAiEnabledOnly: true,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
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
 * The LiCa search API returns `descResponsibilities` with full HTML content,
 * which buildJobFromApiFields() converts to clean plain text. This replaces the
 * old enrichLidlJobDescriptions() which fetched detail pages with broken selectors.
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
    writeJsonAtomic(DATA_JOBS, jobs);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
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
      job.source = 'Lidl team.lidl.ch api/v1/search + JSON-LD';
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

    // Re-infer canton CH-wide from the clean city signal (addressLocality /
    // location). Only overwrite when it resolves to a Swiss canton — never
    // blank an already-set canton, never default to TI.
    const cityForCanton = String(job?.addressLocality || job?.location || '').trim();
    const inferred = inferAnyCanton(cityForCanton);
    if (inferred && inferred !== job.canton) {
      job.canton = inferred;
      job.addressRegion = inferred;
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
    writeJsonAtomic(DATA_JOBS, deduped);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      writeJsonAtomic(PUBLIC_DATA_JOBS, deduped);
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
  const byCanton = new Map();
  for (const job of lidlJobs) {
    const c = String(job?.canton || '').toUpperCase() || '??';
    byCanton.set(c, (byCanton.get(c) || 0) + 1);
  }
  const cantonBreakdown = [...byCanton.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}:${n}`)
    .join(' ');

  console.log('\n📊 === Lidl Svizzera Job Stats (CH-wide) ===');
  console.log(`  🛒 Job totali trovati (Lidl): ${lidlJobs.length}`);
  console.log(`  🇨🇭 Cantoni coperti (${byCanton.size}): ${cantonBreakdown}`);
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
  console.log('   Source: team.lidl.ch api/v1/search');
  console.log('   Scope: CH-wide (all 26 cantons)');
  console.log('');

  const discovery = await fetchLidlJobDetailUrls();
  if (discovery.sourceZero) {
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

const isInvokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isInvokedDirectly) {
  main().catch((err) => exitCrawlerOnError(err, 'Lidl'));
}
