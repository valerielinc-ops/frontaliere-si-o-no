/**
 * Google Indexing API — second source of job URLs: the published dataset.
 *
 * ## Why
 *
 * The submitter used to read job URLs ONLY from the live job sitemaps. The job
 * sitemaps are written by the full publish; when that publish fails they stay
 * frozen (from 2026-11-06 every one of them carried the 06-11 build, e.g.
 * sitemap-jobs-zurigo-de.xml `last-modified: Fri, 06 Nov 2026 07:21:05 GMT`)
 * while the offer pages keep going live through the section shard pushes. A
 * page published on 2026-11-12 was therefore in no sitemap and was never
 * notified: Google for Jobs did not see the new offers at all.
 *
 * ## Which file, and why this one
 *
 * The build derives the job-detail pages from `data/jobs.json` and publishes,
 * from the SAME filtered inventory, two files on the data CDN:
 *
 *   - `/data/jobs-it-index.json` (slim index: id, slug, canton, location and
 *     the posting-date fields the sitemap lastmod is computed from);
 *   - `/data/jobs-slug-map.json` (id → slug per locale + canton).
 *
 * They are fetched over HTTP (~6.5 MB + ~4 MB brotli) instead of checking out
 * the dataset: the assembled jobs file is not tracked (the assembler needs the
 * per-crawler slices, 1.4 GB tracked, plus `npm ci`; the indexing job's sparse
 * checkout leaves them out on purpose), and the CDN copy is
 * refreshed by the deploy offload even on the days the final publish fails
 * (2026-11-12: last-modified 18:27Z, sitemaps still at 06-11).
 *
 * ## Contract with the caller
 *
 * - A URL in both sources keeps the sitemap entry, with the later of the two
 *   lastmods (both come from scripts/lib/job-sitemap-lastmod.mjs).
 * - A dataset-only URL is a CANDIDATE, never a fact: the caller live-checks it
 *   with {@link judgeDatasetLive} before spending a request on it.
 * - Any failure here (network, JSON, empty or truncated file) returns
 *   `{ entries: [], error }`: the caller warns and goes on with the sitemaps
 *   alone, exactly the pre-2026-11-12 behaviour.
 *
 * @module scripts/lib/indexing-jobs-dataset
 */
import { readFileSync } from 'node:fs';
import { createCantonResolvers } from '../../build-plugins/shared/cantonResolvers.mjs';
import { CDN_ASSET_ORIGIN } from '../../build-plugins/shared/cdnAssetOffloadRx.mjs';
import { jobSitemapLastmodDay } from './job-sitemap-lastmod.mjs';
import { isJobDetailCandidate, judgeLive } from './indexing-jobs-planner.mjs';

export const DATASET_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const DATASET_INDEX_URL = `${CDN_ASSET_ORIGIN}/data/jobs-it-index.json`;
export const DATASET_SLUG_MAP_URL = `${CDN_ASSET_ORIGIN}/data/jobs-slug-map.json`;
/**
 * Fewer records than this means a truncated or placeholder file (the corpus
 * holds ~34k active jobs in 2026-11): ignore it rather than plan from it.
 */
export const DATASET_MIN_RECORDS = 1000;
const SITE_ORIGIN = 'https://frontaliereticino.ch';

let defaultResolvers = null;
/** Canton resolvers fed with the same JSON the build uses (data/ is in the indexing job checkout). */
export function loadCantonResolvers() {
  if (defaultResolvers) return defaultResolvers;
  const read = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
  defaultResolvers = createCantonResolvers({
    cantonSlugFile: read('canton-url-slugs.json'),
    municipalitiesFile: read('canton-municipalities.json'),
  });
  return defaultResolvers;
}

/**
 * Absolute job-detail URL, the string-target branch of
 * build-plugins/shared/jobDetailPath.ts#buildCanonicalJobDetailPath (pinned by
 * tests/indexing-jobs-dataset.test.ts for every canton and locale).
 */
export function jobDetailUrl(resolvers, locale, cantonCode, slug) {
  const section = resolvers.resolveCantonSection(locale, cantonCode);
  const normalizedSlug = String(slug ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!normalizedSlug) return null;
  const path = [locale === 'it' ? '' : locale, section, normalizedSlug].filter(Boolean).join('/');
  return `${SITE_ORIGIN}/${path}/`;
}

/**
 * Job-detail entries `{loc, lastmod, id}` for every active job and locale.
 * `index` is the slim IT index (dates, canton, location); `slugMap` gives the
 * per-locale slugs. Without a slug map only the IT URL of each job is derived.
 */
export function datasetJobEntries(index, slugMap, { resolvers = loadCantonResolvers(), now = new Date() } = {}) {
  const slugsById = new Map();
  for (const rec of Array.isArray(slugMap) ? slugMap : []) {
    if (rec && typeof rec.id === 'string' && rec.slugByLocale && typeof rec.slugByLocale === 'object') {
      slugsById.set(rec.id, rec.slugByLocale);
    }
  }
  const out = [];
  const seen = new Set();
  for (const job of Array.isArray(index) ? index : []) {
    if (!job || typeof job !== 'object') continue;
    const canton = resolvers.resolveJobCanton({ canton: job.canton, location: job.location });
    const lastmod = jobSitemapLastmodDay(job, now) || null;
    const slugs = slugsById.get(job.id) || { it: job.slug };
    for (const locale of DATASET_LOCALES) {
      const slug = locale === 'it' ? slugs.it || job.slug : slugs[locale];
      if (!slug) continue;
      const loc = jobDetailUrl(resolvers, locale, canton, slug);
      if (!loc || seen.has(loc) || !isJobDetailCandidate(loc)) continue;
      seen.add(loc);
      out.push({ loc, lastmod, id: typeof job.id === 'string' ? job.id : null });
    }
  }
  return out;
}

/**
 * Merge the two sources, one entry per URL.
 * @returns {{entries: Array<{loc: string, lastmod: string|null}>, datasetOnly: Map<string, string|null>,
 *   counts: {sitemap: number, dataset: number, datasetOnly: number, both: number}}}
 *   `datasetOnly` maps each URL found only in the dataset to its job id.
 */
export function mergeJobSources(sitemapEntries, datasetEntries) {
  const byUrl = new Map();
  for (const e of sitemapEntries) byUrl.set(e.loc, { loc: e.loc, lastmod: e.lastmod ?? null });
  const datasetOnly = new Map();
  const both = new Set();
  for (const e of datasetEntries) {
    const prev = byUrl.get(e.loc);
    if (prev) {
      both.add(e.loc);
      if (e.lastmod && (!prev.lastmod || e.lastmod > prev.lastmod)) prev.lastmod = e.lastmod;
      continue;
    }
    byUrl.set(e.loc, { loc: e.loc, lastmod: e.lastmod ?? null });
    datasetOnly.set(e.loc, e.id ?? null);
  }
  return {
    entries: [...byUrl.values()],
    datasetOnly,
    counts: { sitemap: sitemapEntries.length, dataset: datasetEntries.length, datasetOnly: datasetOnly.size, both: both.size },
  };
}

/**
 * The active-page seed as an object: `undefined` when the page has no seed,
 * `null` when it has one that is not a JSON object (never an active page we
 * can attribute to a job).
 */
export function parseJobSeed(html) {
  const m = /<script\b[^>]*>\s*window\s*\.\s*__JOB_SEED__\s*=\s*([\s\S]*?)<\/script\s*>/i.exec(html);
  if (!m) return undefined;
  try {
    const seed = JSON.parse(m[1].trim().replace(/;\s*$/, ''));
    return seed && typeof seed === 'object' && !Array.isArray(seed) ? seed : null;
  } catch {
    return null;
  }
}

function jobPostingValidThroughDays(html) {
  return [...html.matchAll(/"validThrough"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Live verdict for a URL that only the dataset knows, stricter than
 * judgeLive: the page must be the ACTIVE detail page of this job.
 *   - 404/410 → `not-live`: not published yet (the shard has not been pushed),
 *     re-checked on a later quota day without the 7-day not-job penalty;
 *   - judgeLive's rules (200, JobPosting, no robots noindex), then
 *   - `window.__JOB_SEED__`, which the build injects only into active
 *     job-detail pages: the expired soft-landing and the «Offerta non
 *     verificata» archive stub never carry it (they use
 *     `__EXPIRED_JOB_DATA__`), even when they keep an archived JobPosting;
 *   - the seed names this job id, when the dataset gave one;
 *   - no JobPosting `validThrough` in the past.
 * @param {{status: number, html?: string}} res
 * @param {{id?: string|null, now?: Date}} [opts]
 * @returns {'ok'|'not-job'|'not-live'|'transient'}
 */
export function judgeDatasetLive(res, { id = null, now = new Date() } = {}) {
  if (res.status === 404 || res.status === 410) return 'not-live';
  const base = judgeLive('URL_UPDATED', res);
  if (base !== 'ok') return base;
  const html = res.html || '';
  const seed = parseJobSeed(html);
  if (!seed) return 'not-job';
  // Exact match on the seed's own top-level id: a substring test would accept
  // `job-1234` for `job-123`, or an `"id"` nested in another field, i.e. the
  // active page of ANOTHER job reached through a stale slug or route.
  if (id && seed.id !== id) return 'not-job';
  const nowMs = now.getTime();
  if (jobPostingValidThroughDays(html).some((v) => Number.isFinite(Date.parse(v)) && Date.parse(v) < nowMs)) return 'not-job';
  return 'ok';
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'frontaliere-indexing-api/2.0 (+https://frontaliereticino.ch)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and derive the dataset entries. Never throws.
 * @returns {Promise<{entries: Array<{loc: string, lastmod: string|null, id: string|null}>, jobs: number,
 *   error: string|null, warning?: string|null}>} `warning`: the slug map failed, Italian URLs only.
 */
export async function loadDatasetJobEntries({
  fetchImpl = fetch,
  indexUrl = DATASET_INDEX_URL,
  slugMapUrl = DATASET_SLUG_MAP_URL,
  timeoutMs = 120_000,
  resolvers,
  now = new Date(),
} = {}) {
  let index;
  try {
    index = await fetchJson(indexUrl, fetchImpl, timeoutMs);
  } catch (err) {
    return { entries: [], jobs: 0, error: `${indexUrl}: ${err.message}` };
  }
  if (!Array.isArray(index) || index.length < DATASET_MIN_RECORDS) {
    return { entries: [], jobs: 0, error: `${indexUrl}: ${Array.isArray(index) ? `${index.length} records, below ${DATASET_MIN_RECORDS}` : 'not an array'}` };
  }
  let slugMap = null;
  let warning = null;
  try {
    slugMap = await fetchJson(slugMapUrl, fetchImpl, timeoutMs);
    if (!Array.isArray(slugMap)) throw new Error('not an array');
  } catch (err) {
    slugMap = null;
    warning = `${slugMapUrl}: ${err.message} — Italian URLs only`;
  }
  try {
    const entries = datasetJobEntries(index, slugMap, { ...(resolvers ? { resolvers } : {}), now });
    return { entries, jobs: index.length, error: null, warning };
  } catch (err) {
    return { entries: [], jobs: 0, error: `dataset entries: ${err.message}` };
  }
}
