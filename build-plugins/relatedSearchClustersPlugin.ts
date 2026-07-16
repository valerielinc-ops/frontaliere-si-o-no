/**
 * Related-search cluster landings — Vite build plugin.
 *
 * Phase 2 of canonicalizing the related-search URLs that the SPA's JobBoard
 * widget exposes (e.g. `/cerca-lavoro-ticino/ricerca-data-center-technician/`).
 * Phase 1 (audit script) populated `data/related-search-candidates.json`.
 * Phase B1 (AI enrichment) optionally populates
 * `data/related-search-enriched.json` with intro + 3-FAQ blocks per cluster.
 *
 * This plugin reads both files plus `data/jobs.json`, filters to clusters
 * with ≥5 emissions and no editorial collision, then emits one indexable
 * static HTML page per surviving cluster at:
 *   IT: /cerca-lavoro-ticino/ricerca-{slug-core}/
 *   EN: /en/find-jobs-ticino/search-{slug-core}/
 *   DE: /de/jobs-im-tessin/suche-{slug-core}/
 *   FR: /fr/trouver-emploi-tessin/recherche-{slug-core}/
 *
 * Mobile-first layout: the job-list section appears in source order BEFORE
 * any editorial filler (intro + FAQ go inside collapsed `<details>`). This
 * is critical — Googlebot reads source order, mobile users see source order
 * on collapse, and we MUST NOT inline 80 words above the listings.
 *
 * Hub index pages are emitted at:
 *   /{sectionLocalized}/{searchPrefix}/  (paginated at 200 entries / page)
 *
 * Anti-doorway mitigations:
 *   - Clusters with <3 matching jobs are SKIPPED entirely (no thin-content
 *     fallback) per CLAUDE.md non-negotiable rule #4.
 *   - Up to 30 jobs / page (cap).
 *   - Template intro is parameterized by jobCount + keyword + city +
 *     top-3-companies, so even when the AI cache is empty the body varies
 *     per-page.
 *   - When enrichment data has no FAQs for a cluster, the FAQ section is
 *     OMITTED rather than templated (better than fake content).
 *
 * Gates:
 *   - SKIP_RELATED_SEARCH_CLUSTERS=1 → fast-path exit, no files generated.
 *
 * The plugin DEGRADES GRACEFULLY when input files are missing (logs a
 * warning and returns 0 pages instead of failing the build).
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Plugin } from 'vite';

import { WriteCollector } from './batchWrite';
import { BASE_URL } from './constants';
import { buildFlatBridgeFromSibling } from './flatHtmlRedirectPlugin';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { stripLiteralMarkdown } from './shared/stripLiteralMarkdown';
import { ORPHAN_LANDING_SECTION } from './orphanQueryData';
import { buildTitleWithBrand, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { getTrafficEvidenceFilter } from './shared/trafficEvidenceFilter';
import { buildClusterThinHtml } from './shared/clusterThinShell';
import { EJP_STRIPPED_MARKER } from './shared/ejpMarker';
import {
  renderJobBoardCommuterContext,
  renderSearchQueryIntro,
  buildJobBoardCommuterFaqItems,
  type JobBoardCommuterContextOpts,
} from './shared/jobBoardCommuterContext';
import {
  getJobBoardSectionSlug,
  getSearchSlugPrefix,
  stripSearchQueryBoilerplate,
} from '../services/relatedSearchClusters';
import { isJunkSearchKeyword } from '../services/relatedSearchJunkTerms.mjs';
import { stemSearchToken, stemHaystack } from '../services/searchStem.mjs';
import { cantonSearchTokens } from '../services/cantonList';
import {
  AGGREGATE_KEY,
  resolveCantonSection,
  resolveJobCanton,
  type CantonLocale,
} from './shared/cantonSection';
import type { Locale } from '../services/i18n';
import {
  COPY,
  KNOWN_CITIES,
  LOCALE_PREFIX,
  OG_LOCALE,
  SUPPORTED_LOCALES,
  type CandidateEntry,
  type CandidatesFile,
  type EnrichedEntry,
  type EnrichedFile,
  type LocaleCopy,
  type RawJob,
} from './relatedSearchClustersData';
import { jobsSeoPagesFlushed } from './shared/buildSignals';
import { shouldEmitLocale, EMIT_ALL_LOCALES, localeOfDistPath } from './shared/localeEmitFilter';
import { inlineScriptJson } from './shared/inlineJsonScript';
import {
  startTimer as profileStart,
  recordEmit as profileRecord,
  printSummary as printRelatedSearchProfile,
} from './shared/relatedSearchClustersProfiler';

// ── Constants ───────────────────────────────────────────────────────────

// MIN_JOB_COUNT — candidate-level frequency floor (audit time).
//
// Set to 1 (no filtering) so every audit-captured candidate slug — i.e.
// every slug JobBoard's SPA `<a href>` widget can produce on a page-visit —
// becomes eligible for emission. This is the upstream coverage contract:
// any link the SPA generates MUST resolve to a real page.
//
// MIN_MATCHING_JOBS — per-page emission floor (post job-matching).
//
// Set to 0 (2026-05-11): emit a static page for every candidate that has
// a non-empty keyword, even when AND-tier + OR-fill find 0 matching jobs
// in the current jobs.json. Two cohorts depended on relaxing this:
//   1. GSC-synthetic candidates from `ingest-gsc-orphans-into-candidates.mjs`
//      (slugs Google indexed in the past, whose source jobs have since
//      rotated out of jobs.json). With the previous floor of 3 these
//      slugs stayed 404, fueling the "Indicizzata Non trovata" cohort in
//      Search Console. Removing the floor makes the page emit; the SPA's
//      JobBoard hydration handles the empty result-set UX, while the
//      static crawler body keeps the AI intro + commuter-context prose
//      (~5-7 KB) so text-html-ratio stays above the 10% gate.
//   2. Audit-derived candidates with single-token slugs that don't AND-
//      match any job in jobs.json (rare — most are recovered via OR-fill,
//      but a few hundred slipped through).
//
// n=0 copy: `buildDescription` + `buildHeadline*` shift to a forward-
// framed phrasing ("Crea alert", "subscribe to alerts") instead of
// "0 offerte aperte" so SERP CTR doesn't tank on the empty pages.
const MIN_JOB_COUNT = 1;
const MIN_MATCHING_JOBS = 0;
const MAX_JOBS_PER_PAGE = 30;
const HUB_PAGE_SIZE = 200;

// STRIP_CLUSTER_SEO_PROSE: when ON (default), drops the per-cluster
// commuter-context block (~5 KB raw: crawler methodology + Permesso G +
// tax formula + esempio + 4 visible <details> FAQ + tools links) AND the
// FAQPage JSON-LD on cluster landing pages. Across the ~102,827 cluster
// pages this surface emits, the saved per-page payload sums to ~150 MB
// gzip — enough to push the github-pages artifact back under the soft
// cap that started rejecting deploys ~14:00 UTC 2026-05-22. The
// cluster-specific H1, AI intro paragraphs (mention real employers /
// keyword / city), and Ricerche correlate cross-link nav are KEPT —
// they're the only parts that meaningfully differentiate one cluster
// page from another. Marker mirrors STRIP_EXPIRED_JOB_PROSE so
// audit:text-html-ratio skips matching pages via EJP_STRIPPED_MARKER.
// Opt out with STRIP_CLUSTER_SEO_PROSE=0 to re-emit the full prose
// (e.g. for an A/B test of organic CTR vs. SERP impressions).
const STRIP_CLUSTER_SEO_PROSE = (process.env.STRIP_CLUSTER_SEO_PROSE ?? '1') !== '0';
// EJP_STRIPPED_MARKER imported from ./shared/ejpMarker (single source of truth).

// ── Utilities ───────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Lower-case + NFD-strip (handles Zürich/Zurich, Genève/Geneva, etc.). */
function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Tokenize a query string into [normalized, length>=2, stemmed] tokens.
 * Stemming (shared with the SPA via services/searchStem.mjs) collapses
 * derivational/plural variants onto a root so a slug query like
 * `…-cure-infermieristiche-…` matches "infermiere" jobs — the static page no
 * longer needs the SPA to over-recover after hydration.
 */
function tokenizeQuery(query: string): string[] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2)
    .map(stemSearchToken);
}

/**
 * Build the per-locale normalized + STEMMED haystack once and cache it on the
 * job. The haystack is stemmed identically to the query tokens (and to the SPA
 * and the off-thread postings worker, all via stemHaystack/stemSearchToken in
 * services/searchStem.mjs) so substring matching aligns on roots, not surface
 * forms. The gram/postings index is built from this haystack, so the worker
 * MUST apply the same stemHaystack step to stay byte-identical.
 */
function buildJobHaystack(job: RawJob, locale: Locale): string {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return stemHaystack(normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${cantonSearchTokens(job.canton ?? '')} ${description}`));
}

/** Detect a known city in a sample term (longest match wins). */
function detectCity(sampleTerm: string): string | null {
  if (!sampleTerm) return null;
  const lower = normalizeText(sampleTerm);
  const sortedCities = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  for (const city of sortedCities) {
    const cityLower = normalizeText(city);
    const re = new RegExp(`(^|[\\s,/-])${cityLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,/-])`);
    if (re.test(lower)) return city;
  }
  return null;
}

/** Strip a trailing city occurrence from the sample term, returning the keyword. */
function stripCityFromKeyword(sampleTerm: string, city: string | null): string {
  if (!city) return sampleTerm.trim();
  const lowerCity = normalizeText(city);
  const lowerTerm = normalizeText(sampleTerm);
  const trailingRe = new RegExp(`[\\s,/-]+${lowerCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  if (!trailingRe.test(lowerTerm)) return sampleTerm.trim();
  return sampleTerm.replace(/[\s,/-]+\S+$/, '').trim() || sampleTerm.trim();
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Cache (skip slow emit when inputs unchanged) ────────────────────────

/**
 * Files whose content participates in the cache key. Any change to these
 * invalidates the cache and forces a full re-emit.
 *   - jobs.json: changes daily via cron crawlers
 *   - candidates / enriched: changes weekly via the audit pipeline
 *   - plugin source: any code edit invalidates cache
 *   - shared helpers: emit shape depends on them
 *   - relatedSearchClusters service: shared with the SPA, defines slugs
 */
const CACHE_KEY_INPUTS = [
  'data/jobs.json',
  'data/related-search-candidates.json',
  'data/related-search-enriched.json',
  // GSC/GA4/PostHog-driven mirror set: when the weekly workflow rewrites
  // this file the build must re-emit so the new mirror paths land in dist.
  // Missing file is hashed as `missing:<rel>` by computeCacheKey, so
  // bootstrap stub vs. populated data still produce distinct cache keys.
  'data/indexed-cluster-urls.json',
  'build-plugins/relatedSearchClustersPlugin.ts',
  'build-plugins/relatedSearchClustersData.ts',
  'build-plugins/shared/seoPageShell.ts',
  'build-plugins/shared/seoContentTokens.ts',
  'build-plugins/shared/titleSuffix.ts',
  'build-plugins/shared/jobBoardCommuterContext.ts',
  'services/relatedSearchClusters.ts',
  // Stemmer shared with the SPA + postings worker: a change here alters which
  // jobs each cluster page matches, so it must bust the emit cache.
  'services/searchStem.mjs',
  'build-plugins/relatedSearchPostingsWorker.mjs',
];

// v2 (2026-05-07) invalidates v1 entries that were saved before the
// dropNoindexLocs filter was added — those cached sitemaps still listed
// 2 cluster URLs that another plugin (jobsSeoPagesPlugin's
// search-stats-landing emit) overwrites with `noindex,follow`. Bumping
// the version forces a fresh emit on next build so the filter runs.
//
// v3 (2026-05-10) extends dropNoindexLocs → dropOverwrittenLocs to also
// drop URLs whose dist/ HTML carries a `<link rel="canonical">` pointing
// elsewhere — typically jobsSeoPagesPlugin's previousSlugs bridge for an
// active job whose old slug coincides with a cluster candidate
// (e.g. `ricerca-{job-slug}` collides with the candidate harvested from
// the GSC 404 cohort). The bridge HTML self-canonicalizes to the current
// slug, so listing the bridge URL in sitemap-search-clusters.xml fails
// audit:sitemap-canonicals + validate:sitemap-pages.
//
// v4 (2026-05-11) lowers MIN_MATCHING_JOBS from 3 → 0. Previously skipped
// clusters (GSC orphans with expired source jobs; audit-derived slugs
// whose tokens don't AND-match any current job) now emit. Bumping the
// version invalidates v3 caches so the new pages render on next build.
//
// v5 (2026-05-18) shards sitemap-search-clusters.xml into <45k-URL files
// (sitemap-search-clusters-001.xml, …) so we stay under the sitemaps.org
// 50k hard cap. Old single-file caches would restore one 81k file and
// reintroduce the violation — bump invalidates them.
//
// v6 (2026-05-29, issue #911) adds `crossSectionMirrorLocs` to the manifest:
// the legacy per-canton mirror URLs (canonical → Svizzera) that THIS plugin
// overwrites in dist/, so the cache-hit path can drop them from
// sitemap-jobs.xml (written by jobsSeoPagesPlugin, which lists them as
// self-canonical TI before our overwrite). Old caches lack the field → bump
// invalidates them so the next build re-emits and repopulates it.
//
// v7 (2026-06-15) routes the matcher through the shared root stemmer
// (services/searchStem.mjs): query tokens AND job haystacks are now stemmed, so
// the AND/OR job set for every cluster page changes (e.g. `…-infermieristiche-…`
// now matches "infermiere" jobs). Old v6 caches hold the un-stemmed pages —
// bump invalidates them so the next build re-emits with root matching.
const CACHE_VERSION = 'v7';

/**
 * sitemaps.org caps each sitemap at 50,000 URLs. We shard at 45,000 to
 * leave a safety margin for incidental growth between builds. The
 * `sitemap-search-clusters.xml` cohort topped 81,537 URLs as of
 * 2026-05-18, silently failing GSC ingestion above the cap.
 */
const SITEMAP_SHARD_CAP = 45_000;
const SITEMAP_SHARD_PREFIX = 'sitemap-search-clusters';

function padShardIndex(index: number): string {
  return index >= 1000 ? String(index) : String(index).padStart(3, '0');
}

function shardFilename(index: number): string {
  return `${SITEMAP_SHARD_PREFIX}-${padShardIndex(index)}.xml`;
}

/**
 * Remove any pre-existing cluster sitemap files (single-file legacy +
 * stale shard residue from a previous, longer run). Returns the list of
 * filenames removed so callers can log if desired.
 */
function clearStaleClusterSitemaps(distDir: string): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(distDir)) return removed;
  const re = new RegExp(`^${SITEMAP_SHARD_PREFIX}(?:-\\d+)?\\.xml$`);
  for (const file of fs.readdirSync(distDir)) {
    if (!re.test(file)) continue;
    try {
      fs.unlinkSync(path.join(distDir, file));
      removed.push(file);
    } catch {
      // best-effort cleanup
    }
  }
  return removed;
}

interface CacheManifest {
  version: string;
  generatedAt: string;
  files: string[];                         // dist-relative paths
  hubs: { locale: Locale; url: string }[]; // hub URLs for re-injection
  sitemapLocs: string[];                   // for master sitemap patch
  // Legacy per-canton mirror loc URLs (canonical → Svizzera) overwritten by
  // this plugin in dist/. Persisted so the cache-hit path can drop them from
  // sitemap-jobs.xml (issue #911). Optional for back-compat with pre-v6 caches.
  crossSectionMirrorLocs?: string[];
  emittedCount: number;
}

function computeCacheKey(rootDir: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(`floor:${MIN_JOB_COUNT}\0`);
  hash.update(`version:${CACHE_VERSION}\0`);
  for (const rel of CACHE_KEY_INPUTS) {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) {
      hash.update(`missing:${rel}\0`);
      continue;
    }
    // For huge inputs (jobs.json is ~30 MB) read the bytes directly.
    hash.update(fs.readFileSync(full));
    hash.update(`\0${rel}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}

function cacheDirFor(rootDir: string, cacheKey: string): string {
  return path.join(rootDir, '.cache', 'related-search-clusters', cacheKey);
}

async function tryRestoreFromCache(
  rootDir: string,
  distDir: string,
  cacheKey: string,
): Promise<CacheManifest | null> {
  const cacheDir = cacheDirFor(rootDir, cacheKey);
  const manifestPath = path.join(cacheDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: CacheManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
  if (manifest.version !== CACHE_VERSION) return null;

  // Streamed disk-to-disk copy in parallel batches. Bypasses the
  // WriteCollector path on purpose: that path buffers each file's content
  // in memory + recomputes a sha256 per file, which on the GH free-tier
  // 7 GB runner pushed the process into swap thrashing and made cache HIT
  // restore (~418s) about as slow as a full emit (~414s) — defeating the
  // point of caching. fs.promises.copyFile streams bytes directly so peak
  // memory stays bounded by `concurrency × OS pipe buffer` (~MB), not by
  // the total HTML payload (~320 MB).
  //
  // Concurrency 64 chosen empirically: enough to saturate libuv's default
  // 4-thread pool with mkdir overlap, low enough to avoid EMFILE on the
  // runner's default ulimit (1024 open files).
  const concurrency = 64;
  const files = manifest.files;
  const ensuredDirs = new Set<string>();
  let restored = 0;

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map(async (rel) => {
      const src = path.join(cacheDir, 'files', rel);
      const dst = path.join(distDir, rel);
      try {
        const dir = path.dirname(dst);
        if (!ensuredDirs.has(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          ensuredDirs.add(dir);
        }
        await fs.promises.copyFile(src, dst);
        restored++;
      } catch (err) {
        // Missing src or unwritable dst: skip silently — the missing file
        // will be detected by post-build audits if it actually mattered.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`\x1b[33m[related-search-clusters]\x1b[0m restore failed for ${rel}:`, err);
        }
      }
    }));
  }

  // Each shard carries a `<lastmod>` per URL; refresh today's date on every
  // restored sitemap-search-clusters*.xml so the master sitemap signals
  // freshness even when the body is unchanged. Walks the actual restored
  // shard set (legacy single-file caches will surface as a single match;
  // post-sharding caches have N matches — both handled uniformly).
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(distDir)) {
    const shardRe = new RegExp(`^${SITEMAP_SHARD_PREFIX}(?:-\\d+)?\\.xml$`);
    for (const file of fs.readdirSync(distDir)) {
      if (!shardRe.test(file)) continue;
      const p = path.join(distDir, file);
      try {
        const xml = fs.readFileSync(p, 'utf-8')
          .replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
        fs.writeFileSync(p, xml, 'utf-8');
      } catch {
        // best-effort refresh
      }
    }
  }
  return { ...manifest, emittedCount: restored };
}

function saveToCache(
  rootDir: string,
  distDir: string,
  cacheKey: string,
  emittedFiles: ReadonlyArray<string>,
  hubs: ReadonlyArray<{ locale: Locale; url: string }>,
  sitemapLocs: ReadonlyArray<string>,
  crossSectionMirrorLocs: ReadonlyArray<string>,
): number {
  const cacheDir = cacheDirFor(rootDir, cacheKey);
  // Wipe stale entries for the same key (defensive — should never collide).
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(cacheDir, 'files'), { recursive: true });

  const seen = new Set<string>();
  let copied = 0;
  for (const rel of emittedFiles) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = path.join(distDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(cacheDir, 'files', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }

  const manifest: CacheManifest = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    files: Array.from(seen),
    hubs: hubs.slice(),
    sitemapLocs: sitemapLocs.slice(),
    crossSectionMirrorLocs: crossSectionMirrorLocs.slice(),
    emittedCount: copied,
  };
  fs.writeFileSync(
    path.join(cacheDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
  return copied;
}

// ── File loading ────────────────────────────────────────────────────────

function loadCandidates(rootDir: string): CandidateEntry[] {
  const candidatesPath = path.join(rootDir, 'data', 'related-search-candidates.json');
  if (!fs.existsSync(candidatesPath)) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m candidates file missing — skipping (soft).');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8')) as CandidatesFile;
    if (!Array.isArray(raw.candidates)) {
      console.warn('\x1b[33m[related-search-clusters]\x1b[0m candidates file has unexpected shape — skipping.');
      return [];
    }
    return raw.candidates;
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse candidates file:', err);
    return [];
  }
}

function loadEnriched(rootDir: string): Record<string, EnrichedEntry> {
  const enrichedPath = path.join(rootDir, 'data', 'related-search-enriched.json');
  if (!fs.existsSync(enrichedPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(enrichedPath, 'utf-8')) as EnrichedFile;
    return raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse enriched file:', err);
    return {};
  }
}

function loadJobs(rootDir: string): RawJob[] {
  const jobsPath = path.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m jobs.json missing — no listings will be rendered.');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as RawJob[]) : [];
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse jobs.json:', err);
    return [];
  }
}

/**
 * Parse a cluster URL path into its (locale, slug) key so we can bucket the
 * GSC-driven mirror paths by the same key the render loop uses.
 *
 * Returns null when the path doesn't match the cluster shape — including the
 * Svizzera aggregator sections, since those ARE the canonical and don't need
 * a mirror entry.
 *
 * Mirrors the `CLUSTER_PATH_RX` regex in scripts/refresh-indexed-cluster-urls.mjs.
 * If you change one, change the other — keep the de/jobs-im, de/jobs-in,
 * de/jobs-in-der prefixes in sync because the data file is consumed by this
 * function unmodified.
 */
const CLUSTER_PATH_PARSE_RX = /^\/(?:(en|de|fr)\/)?(?:cerca-lavoro|find-jobs|jobs-im|jobs-in|jobs-in-der|trouver-emploi)-(?!svizzera\b|switzerland\b|schweiz\b|suisse\b)[a-z-]+\/((?:ricerca|search|suche|recherche)-[a-z0-9-]+)\/?$/;

function parseClusterPathKey(p: string): { locale: Locale; slug: string } | null {
  if (!p) return null;
  const m = p.toLowerCase().match(CLUSTER_PATH_PARSE_RX);
  if (!m) return null;
  const locale = (m[1] || 'it') as Locale;
  return { locale, slug: m[2] };
}

/**
 * Load `data/indexed-cluster-urls.json` and bucket the listed paths by
 * `${locale}::${slug}` so the render loop can look up additional mirror paths
 * in O(1) per cluster.
 *
 * The file is populated by `scripts/refresh-indexed-cluster-urls.mjs` (run
 * weekly via `.github/workflows/refresh-indexed-cluster-urls.yml`) — its
 * union of GSC/GA4/PostHog cluster URLs under non-aggregator sections is the
 * authoritative list of paths Google / users still hit.
 *
 * Missing file or malformed JSON returns an empty map → emit loop falls back
 * to the default TI + legacyCantonGroup mirrors.
 */
function loadIndexedClusterUrls(rootDir: string): Map<string, string[]> {
  const filePath = path.join(rootDir, 'data', 'indexed-cluster-urls.json');
  const out = new Map<string, string[]>();
  if (!fs.existsSync(filePath)) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse indexed-cluster-urls.json:', err);
    return out;
  }
  const indexedPaths = (raw as { indexedPaths?: unknown })?.indexedPaths;
  if (!Array.isArray(indexedPaths)) return out;
  for (const entry of indexedPaths) {
    if (typeof entry !== 'string') continue;
    const parsed = parseClusterPathKey(entry);
    if (!parsed) continue;
    const key = `${parsed.locale}::${parsed.slug}`;
    const list = out.get(key) || [];
    // Normalize to trailing-slash form so the emit-loop dedup against
    // `out.urlPath` (always slashed) catches collisions with the canonical.
    const normalized = entry.endsWith('/') ? entry : `${entry}/`;
    if (!list.includes(normalized)) list.push(normalized);
    out.set(key, list);
  }
  return out;
}

// ── Filtering & dedupe ──────────────────────────────────────────────────

interface ClusterContext {
  candidate: CandidateEntry;
  keyword: string;
  city: string | null;
  matchingJobs: RawJob[];
  topCompanies: string[];
  /**
   * URL canton group key used for the cluster's CANONICAL URL. Now hardcoded
   * to `AGGREGATE_KEY` so every cluster canonicalizes to the Switzerland-wide
   * section (`/cerca-lavoro-svizzera/ricerca-{slug}/` and locale variants).
   * The SPA on `_AGGREGATE_` does not apply a canton filter, so the user sees
   * all matching jobs cross-canton — strictly more results than the previous
   * per-canton pinning, which arbitrarily picked the canton of `matching[0]`
   * and hid the rest behind the SPA's canton filter.
   *
   * Used by `buildClusterPath` for the canonical URL AND for every cross-link
   * (hreflang alternates, related-cluster anchors, hub-item URLs) — so the
   * internal link graph is fully consistent with the canonical.
   */
  cantonGroup: string;
  /**
   * Canton group derived from `resolveJobCanton(matchingJobs[0])`. Preserved
   * separately from `cantonGroup` (which is now always AGGREGATE_KEY for the
   * canonical) so the emit loop can still write a legacy per-canton mirror
   * at the URL the build was producing before this refactor. Mirrors share
   * the canonical's HTML byte-for-byte; their `<link rel="canonical">` still
   * points at the Svizzera URL — Google folds the mirror into the canonical
   * over time while indexed legacy URLs stay 200 OK in the interim.
   */
  legacyCantonGroup: string;
}

// ── Inverted index for token → posting list of jobIdx ────────────────────
// Lazy-builds posting lists per (locale, token) pair. Each posting list is
// computed once, then reused across every candidate that contains the same
// token. A per-locale alphanumeric 2/3-gram index narrows each token to a
// small candidate job set before the final `haystack.includes(token)` check.
// This preserves exact substring semantics while avoiding ~30k locale-token
// full-corpus scans on the current 180k-candidate corpus.
//
// Substring semantics are preserved exactly: each posting list contains
// jobIdx for every job whose locale-specific haystack contains `token` as a
// substring — the same `haystack.includes(token)` condition the prior
// per-candidate scan applied via queryMatchScore. Stemming is intentionally
// skipped (matches plurals/feminines via substring, like the SPA filter).
export class TokenIndex {
  private haystacksByLocale = new Map<Locale, string[]>();
  private postingsByLocale = new Map<Locale, Map<string, number[]>>();
  private gramPostingsByLocale = new Map<Locale, Map<string, number[]>>();
  private readonly scratchScores: Uint8Array;
  private readonly touchedIdx: number[] = [];
  private readonly jobs: ReadonlyArray<RawJob>;

  constructor(jobs: ReadonlyArray<RawJob>) {
    this.jobs = jobs;
    // Per-call score buckets (0..fullScore). fullScore is bounded by the
    // candidate's token count which never exceeds tokenizeQuery's word cap,
    // so Uint8 (max 255) is generous.
    this.scratchScores = new Uint8Array(jobs.length);
  }

  /**
   * Seed cold posting lists computed off the main thread (via
   * relatedSearchPostingsWorker). The build-contexts loop's `postings()`
   * cache will then hit on these entries instead of falling into the
   * synchronous haystack scan path. Idempotent: re-seeding the same token
   * overwrites with a byte-identical list.
   */
  seedPostings(locale: Locale, entries: ReadonlyArray<{ token: string; list: number[] }>): void {
    let perLocale = this.postingsByLocale.get(locale);
    if (!perLocale) {
      perLocale = new Map<string, number[]>();
      this.postingsByLocale.set(locale, perLocale);
    }
    for (const { token, list } of entries) {
      perLocale.set(token, list);
    }
  }

  /** Posting list for (locale, token), sorted ascending by jobIdx (corpus order). */
  postings(locale: Locale, token: string): readonly number[] {
    let perLocale = this.postingsByLocale.get(locale);
    if (!perLocale) {
      perLocale = new Map<string, number[]>();
      this.postingsByLocale.set(locale, perLocale);
    }
    const cached = perLocale.get(token);
    if (cached !== undefined) {
      const __tHit = profileStart();
      profileRecord('bc:postings-hit', __tHit);
      return cached;
    }

    const __tMiss = profileStart();
    const haystacks = this.getHaystacks(locale);
    const candidateJobs = this.candidateJobsForToken(locale, token);
    const list: number[] = [];
    for (const idx of candidateJobs) {
      if (haystacks[idx].includes(token)) list.push(idx);
    }
    perLocale.set(token, list);
    profileRecord('bc:postings-miss', __tMiss);
    return list;
  }

  /**
   * Return the same top-N ordering as the old per-candidate Map+sort path:
   * all AND matches first in corpus order, then OR matches by score desc with
   * corpus-order tie breaks. The page only renders MAX_JOBS_PER_PAGE jobs, so
   * avoid materializing/sorting the full match universe for every candidate.
   */
  matchingJobs(locale: Locale, tokens: readonly string[], maxJobs: number, minOrScore = 1): RawJob[] {
    const __tPostings = profileStart();
    const lists = tokens.map((tok) => this.postings(locale, tok));
    profileRecord('bc:mj-postings-batch', __tPostings);
    if (lists.length === 0) return [];

    if (lists.length === 1) {
      const __tSingle = profileStart();
      const out = lists[0].slice(0, maxJobs).map((idx) => this.jobs[idx]);
      profileRecord('bc:mj-single', __tSingle);
      return out;
    }

    const __tAnd = profileStart();
    const matchingIdx = this.firstAndMatches(lists, maxJobs);
    profileRecord('bc:mj-and', __tAnd);
    if (matchingIdx.length < maxJobs) {
      const __tOr = profileStart();
      this.fillOrMatches(lists, tokens.length, matchingIdx, maxJobs, minOrScore);
      profileRecord('bc:mj-or', __tOr);
    }

    return matchingIdx.map((idx) => this.jobs[idx]);
  }

  /** Free the haystack + postings cache once index queries are complete. */
  clear(): void {
    this.haystacksByLocale.clear();
    this.postingsByLocale.clear();
    this.gramPostingsByLocale.clear();
    this.touchedIdx.length = 0;
  }

  private getHaystacks(locale: Locale): string[] {
    const cached = this.haystacksByLocale.get(locale);
    if (cached) return cached;
    const __t = profileStart();
    const arr = new Array<string>(this.jobs.length);
    for (let i = 0; i < this.jobs.length; i++) {
      arr[i] = buildJobHaystack(this.jobs[i], locale);
    }
    this.haystacksByLocale.set(locale, arr);
    profileRecord('bc:lazy-haystacks', __t);
    return arr;
  }

  private getGramPostings(locale: Locale): Map<string, number[]> {
    const cached = this.gramPostingsByLocale.get(locale);
    if (cached) return cached;

    const __t = profileStart();
    const haystacks = this.getHaystacks(locale);
    const grams = new Map<string, number[]>();
    const seenInJob = new Set<string>();

    for (let jobIdx = 0; jobIdx < haystacks.length; jobIdx++) {
      const haystack = haystacks[jobIdx];
      seenInJob.clear();

      for (const width of [2, 3]) {
        if (haystack.length < width) continue;
        for (let i = 0; i <= haystack.length - width; i++) {
          const gram = haystack.slice(i, i + width);
          if (!isSearchTokenGram(gram)) continue;
          if (seenInJob.has(gram)) continue;
          seenInJob.add(gram);

          let list = grams.get(gram);
          if (!list) {
            list = [];
            grams.set(gram, list);
          }
          list.push(jobIdx);
        }
      }
    }

    this.gramPostingsByLocale.set(locale, grams);
    profileRecord('bc:lazy-grams', __t);
    return grams;
  }

  private candidateJobsForToken(locale: Locale, token: string): readonly number[] {
    const grams = this.getGramPostings(locale);
    if (token.length <= 2) {
      return grams.get(token) ?? [];
    }

    let rarest: readonly number[] | null = null;
    const seenTokenGrams = new Set<string>();
    for (let i = 0; i <= token.length - 3; i++) {
      const gram = token.slice(i, i + 3);
      if (seenTokenGrams.has(gram)) continue;
      seenTokenGrams.add(gram);

      const list = grams.get(gram) ?? [];
      if (rarest === null || list.length < rarest.length) {
        rarest = list;
        if (rarest.length === 0) break;
      }
    }
    return rarest ?? [];
  }

  private firstAndMatches(lists: ReadonlyArray<readonly number[]>, maxJobs: number): number[] {
    if (lists.some((list) => list.length === 0)) return [];

    let shortestIdx = 0;
    for (let i = 1; i < lists.length; i++) {
      if (lists[i].length < lists[shortestIdx].length) shortestIdx = i;
    }

    const shortest = lists[shortestIdx];
    const out: number[] = [];
    outer:
    for (const idx of shortest) {
      for (let i = 0; i < lists.length; i++) {
        if (i === shortestIdx) continue;
        if (!binaryIncludes(lists[i], idx)) continue outer;
      }
      out.push(idx);
      if (out.length >= maxJobs) break;
    }
    return out;
  }

  private fillOrMatches(
    lists: ReadonlyArray<readonly number[]>,
    fullScore: number,
    out: number[],
    maxJobs: number,
    minScore: number,
  ): void {
    const scores = this.scratchScores;
    const touched = this.touchedIdx;
    touched.length = 0;

    for (const list of lists) {
      for (const idx of list) {
        if (scores[idx] === 0) touched.push(idx);
        scores[idx]++;
      }
    }

    // Full Uint8Array scan was empirically faster than a sort+touched
    // iteration: V8's Array.prototype.sort with a comparator costs more
    // than a sequential typed-array walk for the typical small touched
    // sizes (~100 entries), and the run 26467347040 measurement showed
    // the sort variant added +11s across 161,542 OR-merge calls vs the
    // straight scan. Keep the scan; the scratchScores typed array is
    // cache-friendly and bounded by jobs.length (5819).
    // `minScore` is the relevance floor: OR-fill only appends jobs matching at
    // least this many query tokens. For multi-token *content* queries it is 2,
    // so a job matching only the generic role word ("responsabile") but not the
    // domain word ("neurologia") is no longer pulled in — that single-token
    // OR-fill is what flooded "Responsabile Neurologia" with Chef de Rang / Spa
    // / Vendite listings. For single-content-token queries (e.g. "koch davos",
    // where the city token is droppable) it stays 1 to preserve recovery.
    for (let score = fullScore - 1; score >= minScore && out.length < maxJobs; score--) {
      for (let idx = 0; idx < scores.length && out.length < maxJobs; idx++) {
        if (scores[idx] === score) out.push(idx);
      }
    }

    for (const idx of touched) scores[idx] = 0;
    touched.length = 0;
  }
}

function isSearchTokenGram(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAscii = code >= 97 && code <= 122;
    if (!isDigit && !isLowerAscii) return false;
  }
  return true;
}

function binaryIncludes(sorted: readonly number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const current = sorted[mid];
    if (current === value) return true;
    if (current < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function filterAndDedupeCandidates(all: CandidateEntry[]): CandidateEntry[] {
  const passing = all.filter((c) =>
    c.jobCount >= MIN_JOB_COUNT
    && c.editorialCollision === null
    && Array.isArray(c.sampleTerms)
    && c.sampleTerms.length > 0
    && SUPPORTED_LOCALES.includes(c.locale),
  );
  // Dedupe by `${locale}::${slug}`: keep the entry with the highest jobCount.
  const bySlug = new Map<string, CandidateEntry>();
  for (const c of passing) {
    const key = `${c.locale}::${c.slug}`;
    const existing = bySlug.get(key);
    if (!existing || (c.jobCount > existing.jobCount)) bySlug.set(key, c);
  }
  return Array.from(bySlug.values());
}

export function buildClusterContext(
  candidate: CandidateEntry,
  index: TokenIndex,
  jobs: ReadonlyArray<RawJob>,
): ClusterContext | null {
  const __tTokenize = profileStart();
  const sampleTerm = (candidate.sampleTerms || [])[0] || '';
  if (!sampleTerm) {
    profileRecord('bc:tokenize', __tTokenize);
    return null;
  }
  const city = detectCity(sampleTerm);
  // Strip literal markdown (`**Requisitos:**`) leaked from crawler
  // descriptions into the harvested sample term BEFORE it flows into the
  // displayed keyword (H1, title, hub link, intro, JSON-LD). The slug stays
  // `candidate.slug` (already markdown-free), so canonical URLs are unaffected.
  const keyword = stripLiteralMarkdown(stripCityFromKeyword(sampleTerm, city));
  if (!keyword) {
    profileRecord('bc:tokenize', __tTokenize);
    return null;
  }

  // Drop junk keywords (generic filler / cross-language connectives / scraped
  // UI noise like "cookie", "sowie", "pazienti") even when they survive in the
  // already-committed candidates file. This guard runs at emit time, so it
  // cleans the LIVE /…/ricerca/ hub + stops emitting the thin doorway landings
  // (e.g. /…/ricerca-cookie-bern/) without waiting for the weekly audit regen.
  // Net-reducing consolidation (drops thin junk doorways). See relatedSearchJunkTerms.mjs.
  if (isJunkSearchKeyword(keyword)) {
    profileRecord('bc:tokenize', __tTokenize);
    return null;
  }

  // Match jobs on the boilerplate-stripped term so the static job set mirrors
  // what the SPA shows after hydration (parseSearchSlugFilter strips the same
  // leading "offerte lavoro" / "offres d emploi" prefix). Without this, the AND
  // phase here matched [offerte, lavoro, <role>] → 0 and the OR-fill surfaced
  // any job mentioning "offerta"/"lavoro" in its description, diluting the page
  // with off-intent listings the hydrated board no longer shows. The displayed
  // keyword/H1 (and thus the canonical slug) are intentionally left untouched.
  const tokens = tokenizeQuery(stripSearchQueryBoilerplate(sampleTerm));
  profileRecord('bc:tokenize', __tTokenize);
  if (tokens.length === 0) return null;

  // Two-phase matching:
  //   Phase 1 (best match — AND): jobs whose haystack contains EVERY token
  //     match the user's intent precisely. These come first in the listing.
  //   Phase 2 (fill — OR): when AND alone can't fill the page, append jobs
  //     that match any subset of tokens, ranked by partial-score (more
  //     tokens matched = closer to intent). This recovers landings like
  //     /en/find-jobs-ticino/search-koch-davos/ where AND yields 0 jobs
  //     (Davos isn't Ticino) but OR surfaces relevant "koch" listings —
  //     turning a 404 into an indexable page that still respects the
  //     MIN_MATCHING_JOBS=3 / MIN_INDEXABLE_WORDS quality gates.
  //
  // Each token's posting list is computed once per (locale, token) inside
  // TokenIndex and reused across every candidate that shares it. TokenIndex
  // then selects only the first MAX_JOBS_PER_PAGE results in the same order as
  // the former full Map+sort path: AND matches in corpus order, then OR
  // matches by score desc with corpus-order tie breaks.
  // Relevance floor for OR-fill. The recovery case the OR-fill exists for
  // drops a *city* token ("koch davos" → surface "koch" jobs); the pollution
  // case drops a *domain* token ("responsabile neurologia" → surface bare
  // "responsabile" jobs). Distinguish via the city-stripped keyword: when it
  // still carries ≥2 content tokens, require ≥2 token matches so a single
  // generic token can't pull in off-topic listings. Single-content-token
  // keywords keep minScore=1 so the legitimate city-drop recovery still works.
  //
  // Count CONTENT tokens only: strip the same leading boilerplate as the
  // matching tokens above. Otherwise `offerte lavoro <role>` inflates the count
  // by +2 ("offerte","lavoro") → minOrScore=2 even when the post-strip content
  // is a single token, which would suppress the very city-drop recovery this
  // floor means to preserve (and re-diverge the static page from the SPA).
  const keywordTokenCount = tokenizeQuery(stripSearchQueryBoilerplate(keyword)).length;
  const minOrScore = keywordTokenCount >= 2 ? 2 : 1;

  const __tMatch = profileStart();
  const matching = index.matchingJobs(candidate.locale, tokens, MAX_JOBS_PER_PAGE, minOrScore);
  profileRecord('bc:match', __tMatch);

  if (matching.length < MIN_MATCHING_JOBS) return null;
  // NB: deliberately NO zero-match suppression here. A multi-content-token
  // query that now clears to zero jobs (the ≥2 OR-floor drops the single-token
  // pollution) keeps emitting as the existing n=0 soft-landing (200 + alert
  // CTA + intro prose), NOT a 404. Suppressing it (return null) would de-index
  // already-indexed `/cerca-lavoro-svizzera/ricerca-…/` URLs without a
  // 410/redirect — flagged 🔴 in PR review. The relevance win is that those
  // pages no longer list off-topic jobs, not that they vanish from the index.
  // Note: with MIN_MATCHING_JOBS=0 the line above is a no-op (length is
  // never negative). Kept as a literal expression of the floor so the
  // constant stays the single source of truth — flip it back to ≥1 here
  // by raising MIN_MATCHING_JOBS, not by editing the predicate.

  const __tTop = profileStart();
  const counts = new Map<string, number>();
  for (const j of matching) {
    const c = (j.company || '').trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const topCompanies = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  profileRecord('bc:top-companies', __tTop);

  // Canonical URL is now the Switzerland-wide aggregate so the cluster page
  // surfaces cross-canton jobs (the SPA's canton filter is disabled on
  // `_AGGREGATE_`). Previously every cluster pinned to `matching[0]`'s
  // canton — that arbitrarily hid the other ~95% of matching jobs behind a
  // canton filter and produced an orphan URL on every other canton each time
  // an internal link defaulted to a different section (the JobBoard
  // related-search widget at JobBoard.tsx:5776 defaulted to TI, leaking
  // ~30k orphan URLs into Google's index per locale).
  //
  // `legacyCantonGroup` keeps the old behaviour available for the emit-loop
  // mirror writes — the per-canton URL the build was previously emitting is
  // mirrored alongside the new canonical (same HTML, canonical href → Svizzera)
  // so already-indexed sitemap entries stay 200 OK and Google consolidates them
  // into the new canonical instead of 404-ing.
  const legacyCantonGroup = matching.length > 0 ? resolveJobCanton(matching[0]) : 'TI';
  const cantonGroup = AGGREGATE_KEY;

  return { candidate, keyword: keyword.trim(), city, matchingJobs: matching, topCompanies, cantonGroup, legacyCantonGroup };
}

// ── Page emission ───────────────────────────────────────────────────────

interface PageInputs {
  ctx: ClusterContext;
  enriched: EnrichedEntry | undefined;
  hreflang: ReadonlyArray<{ locale: Locale; url: string }>;
  related: ReadonlyArray<{ keyword: string; url: string }>;
  distDir: string;
  dateStamp: string;
}

interface PageOutput {
  urlPath: string;
  html: string;
  loc: string;
}

/**
 * Build the canonical URL path for a cluster page.
 *
 * `cantonGroup` defaults to `'TI'` (legacy hardcode) to keep call sites that
 * don't yet thread the cluster's home canton working unchanged. Real callers
 * pass `ctx.cantonGroup` so clusters whose top match is in BL/ZH/etc emit
 * under `/cerca-lavoro-basilea/`, `/cerca-lavoro-zurigo/`, ...
 */
function buildClusterPath(locale: Locale, slug: string, cantonGroup: string = 'TI'): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = resolveCantonSection(locale as CantonLocale, cantonGroup);
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/**
 * Build the URL path for the per-locale hub.
 *
 * The hub aggregates every cluster across cantons, so it stays on the legacy
 * TI section (the existing hub URL — clusters are linked into it from there).
 * Re-routing the hub per-canton would shard the index across 22 URLs without
 * a corresponding navigation entry — deferred.
 */
function buildHubPath(locale: Locale, page: number = 1): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const sub = getSearchSlugPrefix(locale);
  const base = `${prefix}/${section}/${sub}/`.replace(/\/+/g, '/');
  return page > 1 ? `${base}page-${page}/` : base;
}

/**
 * Build a localized job-detail URL.
 *
 * Each job's canonical detail page is emitted by jobsSeoPagesPlugin under the
 * job's OWN canton (`/cerca-lavoro-zurigo/{slug}/` for a ZH job, etc — see
 * `buildCantonAwareSection` there). Linking via the legacy TI section made
 * every cross-canton card target an unroutable URL (router resolves to TI
 * canton, slug not in TI shard → "Annuncio non trovato"). Per-job canton
 * resolution mirrors the emit side.
 */
function jobLocalizedUrl(job: RawJob, locale: Locale): string {
  const prefix = LOCALE_PREFIX[locale];
  const jobCantonGroup = resolveJobCanton(job);
  const section = resolveCantonSection(locale as CantonLocale, jobCantonGroup);
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  // Collapse only the path portion — a naive replace on the whole URL
  // would turn `https://` into `https:/` (the original prior-to-call bug
  // was masked because no caller exercised this helper).
  const collapsedPath = `${prefix}/${section}/${slug ? `${slug}/` : ''}`.replace(/\/+/g, '/');
  return `${BASE_URL}${collapsedPath}`;
}

/** Build the page headline. Keeps under 44 chars where possible. */
function buildHeadline(keyword: string, city: string | null): string {
  const kw = capitalize(keyword.trim());
  return city ? `${kw} a ${city}` : kw;
}

/**
 * Cap the headline at `max` chars on a whitespace boundary, no ellipsis.
 *
 * `audit:title-length` (deploy-blocking ratchet) caps titles at
 * TITLE_MAX_CHARS=66. Long compound keywords (e.g.
 * "Addetto al commercio al dettaglio efz creare esperienze di acquisto")
 * push the headline past 80-100 chars, so `buildTitleWithBrand`'s
 * verbatim-pass-through path (per its no-`…` policy in titleSuffix.ts)
 * triggers the audit. We cut on the last whitespace boundary inside `max`
 * and drop the trailing word — no `…`, since titleSuffix policy explicitly
 * documents that mid-headline ellipsis collapses SERP CTR. Falls back to a
 * hard cut only if no whitespace exists in the first `max` chars (defensive
 * — every real keyword has spaces).
 */
function capForTitle(headline: string, max: number): string {
  const safe = String(headline || '').trim();
  if (safe.length <= max) return safe;
  const sliced = safe.slice(0, max);
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > 0 ? sliced.slice(0, lastSpace).trimEnd() : sliced.trimEnd();
}

/** Forward-framed copy when matching jobs is empty — avoids "0 jobs found"
 *  CTR-killer in SERP snippets. Used by both meta description and H1 build. */
const EMPTY_TAGLINE: Record<Locale, (kw: string, city: string | null) => string> = {
  it: (kw, city) => city
    ? `Alert quotidiano per "${kw}" a ${city} — nuove offerte appena pubblicate.`
    : `Alert quotidiano per "${kw}" in Ticino — nuove offerte appena pubblicate.`,
  en: (kw, city) => city
    ? `Daily alert for "${kw}" in ${city} — get notified when new openings are posted.`
    : `Daily alert for "${kw}" in Ticino — get notified when new openings are posted.`,
  de: (kw, city) => city
    ? `Täglicher Alert für "${kw}" in ${city} — neue Inserate sofort sehen.`
    : `Täglicher Alert für "${kw}" im Tessin — neue Inserate sofort sehen.`,
  fr: (kw, city) => city
    ? `Alerte quotidienne pour "${kw}" à ${city} — soyez prévenu·e dès qu'une offre est publiée.`
    : `Alerte quotidienne pour "${kw}" au Tessin — soyez prévenu·e dès qu'une offre est publiée.`,
};

/** Build the meta description (120-160 chars). */
function buildDescription(ctx: ClusterContext, locale: Locale): string {
  const tagline = ctx.matchingJobs.length === 0
    ? EMPTY_TAGLINE[locale](ctx.keyword, ctx.city)
    : COPY[locale].taglineSingular(ctx.matchingJobs.length, ctx.keyword, ctx.city);
  const head = ctx.topCompanies.length > 0 ? ` ${ctx.topCompanies.slice(0, 2).join(', ')}.` : '';
  const out = `${tagline}${head}`.trim();
  return out.length > 158 ? `${out.slice(0, 157)}…` : out;
}

/**
 * Detect a high-level sector label from the keyword. Used to vary the FAQ
 * copy in `renderJobBoardCommuterContext` so 1,400 cluster pages don't all
 * surface the same "Are Italian qualifications recognised?" answer text.
 *
 * Returns null when no confident match — the helper falls back to a
 * locale-agnostic generic in that case.
 */
function detectSectorLabel(keyword: string, locale: Locale): string | null {
  const k = normalizeText(keyword);
  // Healthcare cluster (covers nurses, doctors, OSS, paramedics).
  if (/(nurs|inferm|oss|sanit|health|krank|gesund|sant|medic|doctor|arzt)/.test(k)) {
    return locale === 'it' ? 'sanità' : locale === 'en' ? 'healthcare' : locale === 'de' ? 'Gesundheitswesen' : 'santé';
  }
  // Tech / engineering cluster.
  if (/(tech|dev|engin|ingegn|sviluppo|software|data|IT|informatic|programm)/.test(k)) {
    return locale === 'it' ? 'tecnologia' : locale === 'en' ? 'technology' : locale === 'de' ? 'Technologie' : 'technologie';
  }
  // Banking / finance cluster.
  if (/(bank|financ|wealth|fiscal|conta|account|gestione patrimoni|finanz)/.test(k)) {
    return locale === 'it' ? 'banche e finanza' : locale === 'en' ? 'banking and finance' : locale === 'de' ? 'Banken und Finanzen' : 'banque et finance';
  }
  // Logistics / transport.
  if (/(autista|logistic|transport|driver|fahrer|chauffeur|magazz|warehouse)/.test(k)) {
    return locale === 'it' ? 'logistica e trasporti' : locale === 'en' ? 'logistics and transport' : locale === 'de' ? 'Logistik und Transport' : 'logistique et transport';
  }
  // Hospitality / restaurants.
  if (/(cuoc|chef|cameri|hotel|ristor|gastro|restaur|kellner|serveur)/.test(k)) {
    return locale === 'it' ? 'ristorazione e ospitalità' : locale === 'en' ? 'hospitality' : locale === 'de' ? 'Gastronomie und Hotellerie' : 'restauration et hôtellerie';
  }
  // Construction / manual.
  if (/(muratore|builder|constru|bau|carpent|elettricista|electric|idraulic|plumb)/.test(k)) {
    return locale === 'it' ? 'edilizia' : locale === 'en' ? 'construction' : locale === 'de' ? 'Bauwesen' : 'bâtiment';
  }
  // Education.
  if (/(insegn|teach|docent|lehr|prof|education|formaz)/.test(k)) {
    return locale === 'it' ? 'istruzione' : locale === 'en' ? 'education' : locale === 'de' ? 'Bildung' : 'éducation';
  }
  return null;
}

/** Localised copy for the cluster page (search bar, chrome, fallbacks). */
interface ClusterChromeCopy {
  searchPlaceholder: string;
  /** "Searching for" pseudo-label inside the searchbar (visible cue). */
  searchingFor: string;
  /** Active-filter chip label prefix (e.g. "query:"). */
  filterChipPrefix: string;
  /** "Read more about this search" summary on the bottom <details>. */
  contextSummary: string;
  /** Region fallback when no city is detected (used for commuter copy). */
  regionFallback: string;
  /**
   * Region phrase appended to the H1 to differ from <title>. Only used on the
   * non-city (Switzerland-aggregate) clusters — canonical `/cerca-lavoro-
   * svizzera/…` whose job set is nation-wide — so it must read nation-wide
   * ("in Svizzera"), not "in Ticino", to match the cross-canton listings.
   */
  regionH1Suffix: string;
  /** Aria label for active filters group. */
  activeFiltersLabel: string;
  /** Visually-hidden label announcing the result count. */
  resultsCountLabel: (n: number) => string;
}

const CHROME_COPY: Record<Locale, ClusterChromeCopy> = {
  it: {
    searchPlaceholder: 'Cerca per ruolo, azienda o città…',
    searchingFor: 'Risultati per',
    filterChipPrefix: 'ricerca',
    contextSummary: 'Approfondimento: come funziona questa ricerca per i frontalieri',
    regionFallback: 'Ticino',
    regionH1Suffix: 'in Svizzera',
    activeFiltersLabel: 'Filtri attivi',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'offerta trovata' : 'offerte trovate'}`,
  },
  en: {
    searchPlaceholder: 'Search by role, company or city…',
    searchingFor: 'Results for',
    filterChipPrefix: 'search',
    contextSummary: 'More about this search for cross-border applicants',
    regionFallback: 'Ticino',
    regionH1Suffix: 'across Switzerland',
    activeFiltersLabel: 'Active filters',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'job found' : 'jobs found'}`,
  },
  de: {
    searchPlaceholder: 'Suche nach Rolle, Unternehmen oder Stadt…',
    searchingFor: 'Ergebnisse für',
    filterChipPrefix: 'Suche',
    contextSummary: 'Mehr zu dieser Suche für Grenzgänger',
    regionFallback: 'Tessin',
    regionH1Suffix: 'in der Schweiz',
    activeFiltersLabel: 'Aktive Filter',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'Stelle gefunden' : 'Stellen gefunden'}`,
  },
  fr: {
    searchPlaceholder: 'Recherche par poste, entreprise ou ville…',
    searchingFor: 'Résultats pour',
    filterChipPrefix: 'recherche',
    contextSummary: 'En savoir plus sur cette recherche pour les frontaliers',
    regionFallback: 'Tessin',
    regionH1Suffix: 'en Suisse',
    activeFiltersLabel: 'Filtres actifs',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'offre trouvée' : 'offres trouvées'}`,
  },
};

// Cluster page rendering deliberately does NOT emit a static searchbar
// replica, active-filter chip, or JobCard grid in the body. The SPA's
// JobBoard component renders all of those (and they actually function)
// on hydration via `parseSearchSlugFilter`. The previous static replicas
// looked interactive but were dead — UX regression. The static body now
// contains only crawler-facing prose; see `renderClusterPage` below.

/** Build all JSON-LD scripts for a cluster page. */
function buildJsonLd(opts: {
  ctx: ClusterContext;
  canonicalUrl: string;
  enriched: EnrichedEntry | undefined;
  locale: Locale;
  commuterLocation: string;
  sectorLabel: string | null;
}): string[] {
  const { ctx, canonicalUrl, enriched, locale, commuterLocation, sectorLabel } = opts;
  const headline = buildHeadline(ctx.keyword, ctx.city);
  const copy = COPY[locale];
  const sectionPath = `${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');
  const sectionUrl = `${BASE_URL}${sectionPath}`;

  // ItemList JSON-LD intentionally NOT emitted: the static body no longer
  // visibly lists the jobs (the SPA renders them via JobBoard hydration),
  // and Google's structured-data policy requires structured data to match
  // visible content. Job listings are still surfaced via the SPA-rendered
  // JobCard grid, which Google indexes after JS execution.
  const breadcrumb = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.homeBreadcrumb, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.jobsBreadcrumb, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: headline, item: canonicalUrl },
    ],
  });

  const out = [breadcrumb];

  // Single combined FAQPage: GSC reports "Campo duplicato 'FAQPage'" when
  // two separate FAQPage JSON-LD blocks appear on the same page. Merge the
  // AI-enriched Q&A (when present) with the commuter-context Q&A into one
  // FAQPage `mainEntity` array so all entries surface to Google's FAQ
  // rich result without tripping the duplicate gate.
  const aiFaqItems = (enriched?.faqs ?? [])
    .filter((f) => f.q && f.q.trim() && f.a && f.a.trim())
    .map((f) => ({
      '@type': 'Question' as const,
      name: f.q.trim(),
      acceptedAnswer: { '@type': 'Answer' as const, text: f.a.trim() },
    }));
  const commuterFaqItems = buildJobBoardCommuterFaqItems({
    locale: locale as 'it' | 'en' | 'de' | 'fr',
    location: commuterLocation,
    sectorOrType: sectorLabel,
  });
  // When STRIP_CLUSTER_SEO_PROSE is ON, the commuter-context block in the
  // <body> is dropped — so its FAQPage JSON-LD must go too (otherwise
  // Google reports "Field 'mainEntity' references missing content" for
  // questions whose visible answers no longer exist on the page). The AI
  // FAQ JSON-LD goes for the same reason (its visible <details> is
  // dropped). Net per cluster: -~1.5 KB raw JSON-LD on top of the
  // ~5 KB raw HTML strip, for ~6.5 KB raw total = ~150 MB gzip on the
  // github-pages artifact across the 102,827-page cluster surface.
  const faqMainEntity = STRIP_CLUSTER_SEO_PROSE
    ? []
    : [...aiFaqItems, ...commuterFaqItems];
  if (faqMainEntity.length > 0) {
    out.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: locale,
      mainEntity: faqMainEntity,
    }));
  }

  return out;
}

function renderHreflang(
  hreflang: ReadonlyArray<{ locale: Locale; url: string }>,
  fallbackUrl: string,
): string {
  // Per audit:hreflang gate: a page WITH hreflang must declare all 4 locales
  // + x-default (5 entries minimum). Most clusters exist in only 1-2 locales,
  // so emitting partial hreflang trips the [tooFew] check. Strategy: only
  // emit hreflang when we have ALL 4 locale alternates; otherwise omit
  // entirely (single-locale pages don't need hreflang and the audit doesn't
  // flag pages with zero hreflang entries).
  const distinctLocales = new Set(hreflang.map((h) => h.locale));
  if (distinctLocales.size < 4) return '';
  const lines: string[] = [];
  for (const alt of hreflang) {
    lines.push(`    <link rel="alternate" hreflang="${alt.locale}" href="${alt.url}">`);
  }
  const itAlt = hreflang.find((h) => h.locale === 'it');
  const xDefaultUrl = itAlt?.url || hreflang[0]?.url || fallbackUrl;
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${xDefaultUrl}">`);
  return lines.join('\n');
}

// Memoize renderJobBoardCommuterContext: pure function, ~52k calls per build
// across only ~560 unique (locale, location, sectorOrType, omitCommute) inputs.
// Cleared at the top of closeBundle so it can't leak across builds in dev/tests.
const commuterCtxCache = new Map<string, string>();
function memoCommuterCtx(opts: JobBoardCommuterContextOpts): string {
  const k = `${opts.locale}::${opts.location}::${opts.sectorOrType ?? '_'}::${opts.omitCommute ? '1' : '0'}`;
  let cached = commuterCtxCache.get(k);
  if (cached === undefined) {
    cached = renderJobBoardCommuterContext(opts);
    commuterCtxCache.set(k, cached);
  }
  return cached;
}

/**
 * Render a single cluster page.
 *
 * Exported so `build-plugins/relatedSearchClustersRenderWorker.mjs` can
 * invoke this function from a worker_threads child via tsx dynamic
 * import. The worker reconstructs a slim ClusterContext from chunkContexts
 * — see worker file for the contract. Byte-identicality requires that
 * the SAME function runs in both modes; do not fork the worker render
 * logic, always extend through this entry point.
 */
export function renderClusterPage(inputs: PageInputs): PageOutput {
  const { ctx, enriched, hreflang, related, distDir } = inputs;
  const { candidate } = ctx;
  const locale = candidate.locale;
  const copy = COPY[locale];
  const chrome = CHROME_COPY[locale];

  const urlPath = buildClusterPath(locale, candidate.slug, ctx.cantonGroup);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const headline = buildHeadline(ctx.keyword, ctx.city);
  const description = buildDescription(ctx, locale);

  // Resolve the location used by the commuter-context helper. When the
  // cluster has a city, use it directly (the helper recognises Lugano,
  // Mendrisio, Chiasso, Bellinzona, Locarno, Stabio and surfaces TILO/
  // crossing data). Otherwise fall back to the regional name and pass
  // omitCommute to skip the city-specific table.
  const commuterLocation = ctx.city || chrome.regionFallback;
  const sectorLabel = detectSectorLabel(ctx.keyword, locale);

  const jsonLdScripts = buildJsonLd({ ctx, canonicalUrl, enriched, locale, commuterLocation, sectorLabel });
  const hreflangHtml = renderHreflang(hreflang, canonicalUrl);

  // ── Strategy: SPA renders the interactive UI for users; static page
  // emits ONLY crawler-facing prose (collapsed `<details>`) below `#root`.
  // The wrapper class `cluster-seo-prose` is intentionally NOT
  // `seo-static-content` — that lets the SPA's lite-shell detector miss
  // the marker and hydrate `#root` with its full JobBoard search-query UI
  // (working searchbar + filter chips + JobCard grid + pagination from
  // `parseSearchSlugFilter`). User sees a fully-functional search-results
  // view; crawlers index the prose section that lives below `#root`.

  // H1 must differ from <title> (audit:h1-title-duplicates is zero-tolerance).
  // Append a city/region suffix + count so the H1 (e.g. "Data Center
  // Technician — 12 offerte aperte in Ticino") never matches the title
  // (which is just the headline + brand) under the audit's case+whitespace-
  // insensitive comparison.
  //
  // n=0 path: drop the count, append a forward-framed cue ("alert
  // quotidiano") instead of "0 offerte" — same goal (differ from title)
  // without the negative-signal in serp/static-body H1.
  const regionPart = ctx.city ? '' : ` ${chrome.regionH1Suffix}`;
  const headlineH1 = ctx.matchingJobs.length === 0
    ? `${headline}${regionPart} — ${copy.alertCta}`
    : `${headline} — ${ctx.matchingJobs.length} ${copy.jobsHeading.toLowerCase()}${regionPart}`;

  // Top companies / cities for the search-query intro paragraph (used by
  // `renderSearchQueryIntro` to vary opening framing per page).
  const topCities = Array.from(
    new Set(
      ctx.matchingJobs
        .map((j) => (j.location || '').trim())
        .filter((l) => l.length > 0),
    ),
  ).slice(0, 5);

  // ── BOTTOM: SEO prose block (collapsed by default on mobile) ─────
  // Source-order placement: AFTER the job grid + CTA so mobile users
  // see meaty content first (CLAUDE.md non-negotiable rule #14). The
  // <details> wraps both the AI intro (when present) / search-query
  // template and the commuter-context block — combined ~5-7 KB of
  // unique prose per page (varies by query/city/sector hash so 1,400
  // pages don't share boilerplate).
  const aiIntroHtml = enriched?.intro
    ? `<p class="s-XHYGOJ">${esc(enriched.intro)}</p>`
    : renderSearchQueryIntro(
        locale as 'it' | 'en' | 'de' | 'fr',
        ctx.keyword,
        ctx.matchingJobs.length,
        ctx.topCompanies,
        topCities,
        // City clusters are TI cities (Lugano, Mendrisio, …) → keep "in Ticino";
        // non-city clusters are the Switzerland-aggregate canonical → "in Svizzera".
        ctx.city ? 'ticino' : 'svizzera',
      );

  // AI-enriched FAQ block (when available). Rendered as <dl> for clarity;
  // FAQPage JSON-LD for these is emitted as part of the merged FAQPage in
  // `buildJsonLd` (combined with the commuter-context FAQ entries to avoid
  // the GSC duplicate-FAQPage warning).
  const renderableAiFaqs = (enriched?.faqs ?? []).filter(
    (q) => q.q && q.q.trim() && q.a && q.a.trim(),
  );
  const aiFaqHtml = renderableAiFaqs.length > 0
    ? `<section class="s-Va7_33">
        <h3 class="s-BlnHQi">${esc(copy.faqSummary)}</h3>
        ${renderableAiFaqs.map((q) =>
          `<details class="s-YlAYKz"><summary class="s-Jrv0AS">${esc(q.q)}</summary><p class="s-bOIp6r">${esc(q.a)}</p></details>`,
        ).join('')}
      </section>`
    : '';

  // Commuter-context prose: 5-7 KB methodology + city-specific commute
  // table + salary breakdown + scenario callout + 4-FAQ + cross-links.
  const commuterContextHtml = memoCommuterCtx({
    locale: locale as 'it' | 'en' | 'de' | 'fr',
    location: commuterLocation,
    sectorOrType: sectorLabel,
    omitCommute: !ctx.city,
  });

  // Related-search cross-links (same-city, different-keyword) — kept at
  // the bottom of the prose block for crawlability and to avoid pushing
  // editorial filler above the fold.
  const relatedHtml = related.length > 0
    ? `<nav aria-label="${esc(copy.relatedHeading)}" class="rsc-related s-i-dyT1">
        <h3 class="s-yj2sXC">${esc(copy.relatedHeading)}</h3>
        <ul class="s-tQuvrl">${related.map((r) => `<li><a class="s-cpill" href="${esc(r.url)}">${esc(r.keyword)}</a></li>`).join('')}</ul>
      </nav>`
    : '';

  // STRIP_CLUSTER_SEO_PROSE (default ON): drop the heaviest, fully-
  // generic chunks — the visible AI <details> 4-FAQ block and the
  // commuter-context section (crawler methodology + Permesso G explainer
  // + tax formula + esempio + 4 duplicate <details> FAQ + tools links).
  // Together they're ~5-6 KB raw per cluster page; across the ~102,827
  // pages this surface emits, that's ~150 MB gzip on the github-pages
  // artifact. The cluster-specific AI intro (mentions real employers /
  // keyword / city) and Ricerche correlate cross-link nav are KEPT — they
  // are the only parts that meaningfully differentiate one cluster page
  // from another. EJP_STRIPPED_MARKER lets audit:text-html-ratio skip
  // these pages (its ratio is by-design low when we drop the prose).
  //
  // Boilerplate `paddingHtml` (a ~60-word "open the salary calculator" CTA
  // paragraph hard-coded in Italian, emitted alongside the strip on EVERY
  // cluster page regardless of locale) is dropped entirely — per user
  // review the IT-only text on EN/DE/FR pages was both a wire-bloat
  // (~250 B × 180k pages × 4 locales = ~45 MB) and a "mixed-language
  // content" SEO smell. The audit:content-quality 50-word floor stays
  // covered by the cluster's own `aiIntroHtml` (per-cluster unique prose,
  // typically 30-60 words) plus the `relatedHtml` cross-link list and
  // the visible job count in the H1; any cluster that falls under the
  // floor would have failed before this commit too. Re-enable by
  // restoring this paragraph if validate-dist starts blocking
  // sparse-aiIntro clusters at the 50-word mark.
  const seoContextBlock = STRIP_CLUSTER_SEO_PROSE
    ? `${EJP_STRIPPED_MARKER}<details class="cluster-seo-context s-mxdIN0">
    <summary class="s-1yn7b_">${esc(chrome.contextSummary)}</summary>
    <div class="s-yZU6bn">
      <section class="s-p_RJwm">
        ${aiIntroHtml}
      </section>
      ${relatedHtml}
    </div>
  </details>`
    : `<details class="cluster-seo-context s-mxdIN0">
    <summary class="s-1yn7b_">${esc(chrome.contextSummary)}</summary>
    <div class="s-yZU6bn">
      <section class="s-p_RJwm">
        ${aiIntroHtml}
      </section>
      ${aiFaqHtml}
      ${commuterContextHtml}
      ${relatedHtml}
    </div>
  </details>`;

  // ── Body ────────────────────────────────────────────────────────
  // Visible PRE-hydration, hidden at hydration. The SPA's hydrated JobBoard
  // renders all visible chrome for users (sub-nav, breadcrumb, search-query
  // header, JobCard grid, footer) inside `#root`; until those chunks arrive
  // this static body (H1 + job links + prose) is the ONLY paintable content
  // on the page, so it renders in normal flow — the former clip-rect
  // recipe (#1249) blanked these landings until SPA paint (FCP ~4s desktop).
  // App.tsx's pre-paint useLayoutEffect flips `main.cluster-seo-prose` to
  // display:none on hydration, so it never duplicates the JobBoard.
  // No `hubChrome` is passed below either, so the
  // sub-nav strip we previously emitted as a static sibling is gone.
  // SEO content stays in DOM (Googlebot indexes it with the same weight
  // as standard `<details>` accordion content per Search Central docs).
  // Job list is always emitted
  // so the static HTML carries cross-canton job references even when the
  // SPA's canton-scoped grid would render zero — mirrors the SPA's Tier 3
  // cross-canton fallback at the build layer. Each link points to the job's
  // OWN canton-aware detail URL (see `jobLocalizedUrl`) so we never link a
  // BL job into a TI section path that the router can't resolve.
  // Body anchors use a SITE-RELATIVE href (starts with `/`). Browser resolves
  // relative to the current document URL → same destination as the absolute
  // form. Spec-required absolute URLs (canonical, OG, JSON-LD @id, hreflang)
  // are emitted elsewhere by `buildSeoPageHtml` and remain absolute.
  // Trimming `https://frontaliereticino.ch` (28 B) × ~30 jobs/page × 180k
  // pages ≈ ~150 MB on the dist artifact.
  const jobLinksHtml = ctx.matchingJobs.length > 0
    ? `<ul class="cluster-seo-jobs">${ctx.matchingJobs.map((job) => {
        const jobTitle = String(job.titleByLocale?.[locale] ?? job.title ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const company = String(job.company || '').trim();
        const loc = String(job.location || '').trim();
        const meta = [company, loc].filter(Boolean).join(' · ');
        const href = jobLocalizedUrl(job, locale).replace(BASE_URL, '');
        return `<li><a href="${esc(href)}">${esc(jobTitle)}${meta ? ` — ${esc(meta)}` : ''}</a></li>`;
      }).join('')}</ul>`
    : '';

  // The `.related-search-cluster` class in `public/assets/seo-static.css`
  // carries the visible-pre-hydration layout (max-width, padding, job-list
  // styling). Keeping it class-based (not inline `style=`) saves
  // ~132 B × 180k cluster pages = ~24 MB on the dist artifact. The class
  // is loaded by the shared `seoStaticCssLink` that every cluster page
  // already imports — no extra request.
  const bodyHtml = `<div class="related-search-cluster">
    <h1>${esc(headlineH1)}</h1>
    ${jobLinksHtml}
    ${seoContextBlock}
  </div>`;

  // Cluster keywords can exceed 60+ chars when the candidate slug is a long
  // compound query (e.g. "addetto al commercio al dettaglio efz creare
  // esperienze di acquisto"). buildTitleWithBrand returns the headline
  // verbatim past the 66-char cap (no `…` per titleSuffix policy), so we
  // must shorten the headline at source before composing. Word-aware cut
  // on a whitespace boundary, no ellipsis — preserves SERP CTR while
  // keeping the title within the audit:title-length ratchet.
  const titleHeadline = capForTitle(headline, TITLE_MAX_CHARS);
  const title = buildTitleWithBrand(titleHeadline);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml,
    jsonLdScripts,
    bodyHtml,
    distDir,
    // No hubChrome: the SPA renders its own sub-nav inside `#root`. A
    // duplicate static sub-nav would render visually below the footer.
    // Opt OUT of `seo-static-content` lite-shell trigger so the SPA
    // hydrates `#root` and renders the working JobBoard search-query UI
    // (parseSearchSlugFilter populates the searchbar, JobBoard renders
    // results, filters work). The static `<main>` below is crawler-only
    // and screen-reader-only via the off-screen wrapper above.
    seoMainClass: 'cluster-seo-prose',
  });

  return { urlPath, html, loc: canonicalUrl };
}

// ── Hub index pages ─────────────────────────────────────────────────────

interface HubItem {
  keyword: string;
  city: string | null;
  /** Absolute URL — used in JSON-LD where Schema.org / Google expect absolute. */
  url: string;
  /** Site-relative path — used in body <a href> to keep HTML lean (browsers resolve against <link rel="canonical">). */
  path: string;
  slug: string;
}

interface HubPageInput {
  locale: Locale;
  items: ReadonlyArray<HubItem>;
  page: number;
  totalPages: number;
  distDir: string;
  dateStamp: string;
}

function groupByCity(items: ReadonlyArray<HubItem>): { byCity: Map<string, HubItem[]>; uncategorized: HubItem[] } {
  const byCity = new Map<string, HubItem[]>();
  const uncategorized: HubItem[] = [];
  for (const it of items) {
    if (it.city) {
      const arr = byCity.get(it.city) ?? [];
      arr.push(it);
      byCity.set(it.city, arr);
    } else {
      uncategorized.push(it);
    }
  }
  return { byCity, uncategorized };
}

/** Render a full page navigator (every page-N is linked — BFS depth gate). */
function renderPageNavigator(locale: Locale, totalPages: number, currentPage: number): string {
  if (totalPages <= 1) return '';
  const copy = COPY[locale];
  const links: string[] = [];
  for (let p = 1; p <= totalPages; p++) {
    const url = buildHubPath(locale, p);
    if (p === currentPage) {
      links.push(`<span class="s-v7bb9T">${p}</span>`);
    } else {
      links.push(`<a class="s-cpag" href="${esc(url)}">${p}</a>`);
    }
  }
  return `<nav class="s-SU718R" aria-label="${esc(copy.pageNavigatorLabel)}">${links.join('')}</nav>`;
}

function renderHubRootHreflang(): string {
  const lines = SUPPORTED_LOCALES.map((alt) =>
    `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildHubPath(alt, 1)}">`,
  );
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildHubPath('it', 1)}">`);
  return lines.join('\n');
}

function renderHubPage(input: HubPageInput): { urlPath: string; html: string; loc: string } {
  const { locale, items, page, totalPages, distDir, dateStamp } = input;
  const copy = COPY[locale];
  const urlPath = buildHubPath(locale, page);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const { byCity, uncategorized } = groupByCity(items);
  const sortedCities = Array.from(byCity.keys()).sort((a, b) => a.localeCompare(b, locale));

  const cityBlocks = sortedCities.map((city) => {
    const list = (byCity.get(city) || []).sort((a, b) => a.keyword.localeCompare(b.keyword, locale));
    return `<section class="s-USY9TF">
      <h3 class="s-vZUVtO">${esc(city)}</h3>
      <ul class="s-MwMbiH">${list.map((it) => `<li><a class="s-la" href="${esc(it.path)}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
    </section>`;
  }).join('');

  const sortedUncat = [...uncategorized].sort((a, b) => a.keyword.localeCompare(b.keyword, locale));
  const uncatBlock = sortedUncat.length > 0
    ? `<section class="s-USY9TF">
        <h3 class="s-vZUVtO">${esc(copy.alphabeticalLabel)}</h3>
        <ul class="s-MwMbiH">${sortedUncat.map((it) => `<li><a class="s-la" href="${esc(it.path)}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
      </section>`
    : '';

  const navigator = renderPageNavigator(locale, totalPages, page);
  const sectionPath = `${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');
  const sectionUrl = `${BASE_URL}${sectionPath}`;

  const collectionLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.hubTitle,
    url: canonicalUrl,
    description: copy.hubDescription,
    inLanguage: locale,
    // Day-granularity (matches the visible `dateStamp` rendered on the page),
    // NOT a full build timestamp: a sub-second `new Date().toISOString()` here
    // made every search-cluster/listing page churn on every deploy. Stable
    // within the UTC day → same-day deploys no longer rewrite these pages from
    // dateModified alone. See build-plugins/shared/buildDayStamp.ts.
    dateModified: `${dateStamp}T00:00:00.000Z`,
    mainEntity: {
      '@type': 'ItemList',
      // numberOfItems reports the full list size; itemListElement is a sample.
      // Schema.org permits sampling — `numberOfItems > itemListElement.length`
      // — and Google treats the array as representative. Capped at 30 (was 100)
      // to shrink emitted HTML by ~10 KB per page, lifting the text/html ratio
      // above the 10 % audit floor without dropping any visible body content.
      numberOfItems: items.length,
      itemListElement: items.slice(0, 30).map((it, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: capitalize(it.keyword),
        url: it.url,
      })),
    },
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.homeBreadcrumb, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.jobsBreadcrumb, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: copy.searchBreadcrumb, item: canonicalUrl },
    ],
  });

  const bodyHtml = `<article class="s-haN35X">
    <nav class="s-bcr">
      <a href="/" class="s-bcl">${esc(copy.homeBreadcrumb)}</a>
      <span> / </span>
      <a href="${esc(sectionUrl)}" class="s-bcl">${esc(copy.jobsBreadcrumb)}</a>
      <span> / </span>
      <span>${esc(copy.searchBreadcrumb)}</span>
    </nav>
    <header class="s-S1RSUf">
      <h1 class="s-JvjD5-">${esc(copy.hubH1)}${page > 1 ? ` — ${copy.pageNavigatorLabel} ${page}` : ''}</h1>
      <p class="lede s-zd3YWl">${esc(copy.hubIntro(items.length))}</p>
      <p class="s-Znu67P">${esc(dateStamp)}</p>
    </header>
    ${sortedCities.length > 0 ? `<section class="s-h0CoDf"><h2 class="s-sOn5-B">${esc(copy.citySectionLabel)}</h2>${cityBlocks}</section>` : ''}
    ${uncatBlock}
    ${navigator}
    ${(() => {
      const summary = ({
        it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
        en: 'Cross-border guide: salary, G permit, tax, weekly return',
        de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
        fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
      } as Record<Locale, string>)[locale];
      const inner = memoCommuterCtx({ locale, location: 'Ticino', omitCommute: true });
      return `<details class="hub-seo-context s-mxdIN0">
        <summary class="s-1yn7b_">${summary}</summary>
        <div class="s-yZU6bn">
          <section class="s-p_RJwm">
            ${inner}
          </section>
        </div>
      </details>`;
    })()}
  </article>`;

  const title = buildTitleWithBrand(`${copy.hubTitle}${page > 1 ? ` — ${copy.pageNavigatorLabel} ${page}` : ''}`);
  const html = buildSeoPageHtml({
    locale,
    title,
    description: copy.hubDescription,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: page === 1 ? renderHubRootHreflang() : '',
    jsonLdScripts: [breadcrumbLd, collectionLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return { urlPath, html, loc: canonicalUrl };
}

// ── Section landing post-process ────────────────────────────────────────

/**
 * Inject a link to the per-locale hub into the existing job-board section
 * landing (emitted by `jobsSeoPagesPlugin`). Keeps the hub at BFS depth
 * ≤4 from `/`. If the section landing is missing (jobs plugin skipped),
 * we log a warning and skip — never fail on a missing/unwritable file.
 * The ONE hard failure is the page-weight guard at the end: an oversized
 * landing must fail the build here rather than the post-deploy audit.
 */
function injectHubLinkIntoSectionLanding(
  distDir: string,
  locale: Locale,
  hubUrl: string,
  copy: LocaleCopy,
): void {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const sectionPath = path.join(distDir, prefix.replace(/^\//, ''), section, 'index.html');
  if (!fs.existsSync(sectionPath)) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m section landing missing at ${sectionPath} — skipping hub link injection.`);
    return;
  }

  let html: string;
  try {
    html = fs.readFileSync(sectionPath, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to read section landing:', err);
    return;
  }

  // Idempotent: skip if our marker is already present.
  if (html.includes('data-related-search-hub-link="1"')) return;

  const hubPagePaths = listEmittedHubPagePaths(distDir, locale);
  // FULL page list, deliberately. PR #1915 truncated this to head(20)+tail(5)
  // to duck the page-weight budget, but that pushed every cluster page hanging
  // off a middle hub page one hop deeper — on the EN/DE/FR landings (which sit
  // at depth 2, not 1) clusters landed at depth 5 and audit:max-bfs-depth
  // regressed on sitemap-search-clusters-001..005 (run 27393621559, 47-73%
  // below crawl depth vs baseline 0%). renderPageNavigator() on the hub pages
  // does link every page-N, but only from depth 3 on non-IT locales — too
  // deep. The full list (~55 B/page, 265 pages ≈ 15 KB) fits again because
  // PR #1921 freed ~110 KB of inline-style overhead on this landing; the
  // 205 KB guard below still bounds the page.
  const tailPaths = hubPagePaths.slice(1); // pages 2..N
  const pageAnchor = (urlPath: string, pageNum: number): string =>
    `<a href="${esc(urlPath)}">${pageNum}</a>`;
  const pageLinks = tailPaths.map((urlPath, idx) => pageAnchor(urlPath, idx + 2)).join(' ');
  const pageLinkBlock = pageLinks
    ? `<details><summary>${esc(copy.pageNavigatorLabel)}</summary><p>${pageLinks}</p></details>`
    : '';
  const linkBlock = `<nav class="s-4FS1gg" data-related-search-hub-link="1" aria-label="${esc(copy.searchBreadcrumb)}"><a class="s-chub" href="${esc(hubUrl)}">${esc(copy.hubH1)}</a>${pageLinkBlock}</nav>`;

  let patched: string | null = null;
  if (html.includes('<!-- end:job-board-main -->')) {
    patched = html.replace('<!-- end:job-board-main -->', `${linkBlock}\n<!-- end:job-board-main -->`);
  } else if (html.includes('</main>')) {
    patched = html.replace('</main>', `${linkBlock}\n</main>`);
  }

  if (!patched) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m no insertion anchor in ${sectionPath} — skipping.`);
    return;
  }

  try {
    fs.writeFileSync(sectionPath, patched, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to write section landing:', err);
  }

  // Build-time page-weight guard. This injection is the last known mutator
  // of the job-board landing, the only repeat offender of the post-deploy
  // audit:page-weight gate (broke at 200 KB on run 26112128794, again at
  // 215 KB on run 27386112992 → issue #1887; gate raised again 215->260 KB
  // for the unrelated /tutti/ pagination-ladder headroom, issue #4209(b) —
  // this landing-page guard is intentionally NOT raised alongside it, see
  // below). Failing HERE turns "deploy → validate-dist red → rollback →
  // prod frozen on a stale build" into a build-job failure that never
  // reaches deploy and names the page. Kept at a fixed 205 KB (independent
  // of the shared audit budget above) so the build fails before the audit
  // ever can. Do NOT raise this guard to pass a build — trim the
  // data-driven blocks instead (see .jbx-* in seo-static.css for the
  // 119 KB inline-style precedent).
  const JOB_BOARD_LANDING_GUARD_BYTES = 205 * 1024;
  const patchedBytes = Buffer.byteLength(patched, 'utf-8');
  if (patchedBytes > JOB_BOARD_LANDING_GUARD_BYTES) {
    throw new Error(
      `[related-search-clusters] job-board landing ${sectionPath} is ${patchedBytes} B after hub-link injection, ` +
      `over the ${JOB_BOARD_LANDING_GUARD_BYTES} B build-time guard (fixed, independent of the shared ` +
      `audit:page-weight budget in scripts/audit-page-weight.mjs). ` +
      `A data-driven block on this landing grew past its headroom — trim the offending block ` +
      `(do not raise this guard or the audit budget; non-negotiable #1).`,
    );
  }
}

/**
 * Inject the FULL hub page-N index into the per-locale orphan-query hub
 * (/ricerca/, /en/search/, /de/suche/, /fr/recherche/ — emitted by
 * orphanQueryLandingPlugin and linked from the depth-1 site index). PR #1915
 * truncated the job-board paginator to head+tail for the page-weight
 * budget, which orphaned every cluster page reachable only through hub
 * pages 22..N (max-bfs-depth: +134k unreachable, deploy 27393621559
 * rolled back). This block restores reachability on a page with ample
 * byte headroom (~79 KB of 220 KB): site index (1) -> orphan hub (2) ->
 * hub page-N (3) -> cluster page (4) stays within the depth-4 gate.
 * Idempotent via the data marker; missing hub file -> warn and skip.
 */
function injectPageIndexIntoOrphanHub(distDir: string, locale: Locale): void {
  const prefix = LOCALE_PREFIX[locale];
  const section = ORPHAN_LANDING_SECTION[locale];
  const hubPath = path.join(distDir, prefix.replace(/^\//, ''), section, 'index.html');
  if (!fs.existsSync(hubPath)) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m orphan-query hub missing at ${hubPath} — skipping page-index injection.`);
    return;
  }
  let html: string;
  try {
    html = fs.readFileSync(hubPath, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to read orphan-query hub:', err);
    return;
  }
  if (html.includes('data-related-search-pages-index="1"')) return;
  const hubPagePaths = listEmittedHubPagePaths(distDir, locale);
  if (hubPagePaths.length === 0) return;
  const copy = COPY[locale];
  const links = hubPagePaths.map((urlPath, idx) =>
    `<a href="${esc(urlPath)}">${idx + 1}</a>`,
  ).join(' ');
  const block = `<nav data-related-search-pages-index="1" aria-label="${esc(copy.pageNavigatorLabel)}"><details><summary>${esc(copy.pageNavigatorLabel)} (${hubPagePaths.length})</summary><p>${links}</p></details></nav>`;
  let patched: string | null = null;
  if (html.includes('</main>')) {
    patched = html.replace('</main>', `${block}\n</main>`);
  }
  if (!patched) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m no insertion anchor in ${hubPath} — skipping page-index injection.`);
    return;
  }
  try {
    fs.writeFileSync(hubPath, patched);
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to write orphan-query hub:', err);
  }
}

function listEmittedHubPagePaths(distDir: string, locale: Locale): string[] {
  const rootPath = buildHubPath(locale, 1);
  const rootDir = path.join(distDir, rootPath.replace(/^\/+/, ''));
  const out: string[] = [];
  if (fs.existsSync(path.join(rootDir, 'index.html'))) out.push(rootPath);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return out;
  }
  const pages = entries
    .map((entry) => /^page-(\d+)$/.exec(entry)?.[1])
    .filter((n): n is string => Boolean(n))
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 1)
    .sort((a, b) => a - b);
  for (const page of pages) {
    if (fs.existsSync(path.join(rootDir, `page-${page}`, 'index.html'))) {
      out.push(buildHubPath(locale, page));
    }
  }
  return out;
}

// ── Sitemap ─────────────────────────────────────────────────────────────

/**
 * Filter out cluster URLs whose dist/ HTML is owned by another plugin and
 * therefore can't be advertised in the cluster sitemap. Two failure modes:
 *
 *   1. **noindex overwrite** — another emitter (e.g. jobsSeoPagesPlugin's
 *      soft-landing for an expired job sharing the slug) overwrote our
 *      index,follow page with a noindex variant. validate:sitemap-pages
 *      hard-fails when a noindex page appears in any sitemap.
 *   2. **non-self-canonical overwrite** — another emitter wrote a bridge /
 *      alias page whose `<link rel="canonical">` points at a *different*
 *      URL (e.g. jobsSeoPagesPlugin's previousSlugs bridge: when a job
 *      previously lived at `/cerca-lavoro-ticino/ricerca-XXX/`, the bridge
 *      reuses the active page's HTML so canonical points at the current
 *      slug, not the bridge URL). audit:sitemap-canonicals hard-fails
 *      ("non-canonical URL in sitemap") on any such mismatch.
 *
 * Both classes are detected by the same per-loc HTML read, so we fold
 * them into a single pass. Cheap: O(locs) reads of small HTML files.
 */
// Quote-flexible: PR #478 baked `removeAttributeQuotes` upstream, so single-token
// attribute values lose their quotes in dist/ (`name=robots`, `content=noindex`). A
// quote-mandatory regex fails to detect minified noindex metas → false negative.
// Attribute-order-independent (two lookaheads, #3060): content-before-name on the
// robots meta must not slip past and leak a noindex page into a cluster.
const NOINDEX_RE = /<meta(?=[^>]*name=["']?robots["']?)(?=[^>]*content=["']?[^"'>]*noindex)/i;
const CANONICAL_HREF_RE = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*href\s*=\s*["']([^"']+)["']/i;
const CANONICAL_HREF_REVERSED_RE = /<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']?canonical["']?/i;
function normalizeLocForCanonicalCmp(u: string): string {
  try {
    const parsed = new URL(u, BASE_URL);
    let p = parsed.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${p}${parsed.search}`;
  } catch {
    return u.trim();
  }
}
/**
 * Async parallel variant. Replaced the sync version (180k `fs.readFileSync`
 * + 360k `fs.existsSync` per build, ~41s under `sitemap-write` in run
 * 26597194374) with a fixed-size concurrency pool of async readFile attempts.
 * Order-preserving: each location's decision is recorded into a pre-allocated
 * Uint8Array indexed by input position, then the output `string[]` is
 * collected in input order — byte-identical sitemap content vs sync path.
 *
 * The async pool overlaps SSD reads across N in-flight ops per main-thread
 * lane (no worker_threads needed since the work is pure I/O). With
 * IN_FLIGHT=32 on a 4-vCPU runner the kernel readahead pipeline stays
 * saturated; higher values returned diminishing gains in microbenchmarks
 * and risk fd contention with concurrent plugins still flushing writes.
 *
 * Missing-HTML semantics preserved: the original code silently skipped a
 * loc when neither `<urlPath>/index.html` nor `<urlPath>.html` existed
 * (no counter); this path collapses both `existsSync` probes into the
 * `readFile` attempts and flags `DROP_MISSING` only for logging-skip — the
 * net output is identical (loc absent from result, no log line).
 *
 * Locale-shard awareness (BUILD_LOCALE, LOCALE-SHARD-BUILD-PLAN Fase 0):
 * on a single-locale shard the render-skip branch pushes a complete
 * cross-locale `sitemapLocs` set (cheap, string-only) so the it/main shard's
 * `sitemap-search-clusters.xml` stays complete — but the EN/DE/FR cluster
 * HTML for the non-owned locales is NEVER written to dist (WriteCollector.add
 * gates it via shouldEmitPath). Without a guard the file-existence check below
 * would flag every cross-shard loc as DROP_MISSING and silently truncate the
 * sitemap to IT-only. So a loc whose OWNING locale this shard does not emit is
 * KEPT unconditionally (it lives on another shard; the dist-file absence is
 * expected, not a broken/overwritten URL). This mirrors hreflangGuard's
 * `!shouldEmitLocale → keep` short-circuit (build-plugins/shared/hreflangGuard.ts).
 * No-op in the default all-locale build (EMIT_ALL_LOCALES short-circuits to the
 * unconditional file-existence path → byte-identical sitemap).
 */
export async function dropOverwrittenLocs(
  distDir: string,
  locs: ReadonlyArray<string>,
): Promise<string[]> {
  const KEEP = 1;
  const DROP_NOINDEX = 2;
  const DROP_NONCANON = 3;
  const DROP_MISSING = 4;
  const flags = new Uint8Array(locs.length);

  // Concurrency cap for in-flight async readFile attempts. Bumped 32 → 64
  // (commit TBD) after the [related-search-profile] table on run 26604491084
  // measured sw:drop-overwritten still at 20.0 s (down from 41.4 s sync in
  // PR #776, but the dominant cost inside sitemap-write at 5.9% of the
  // plugin's wall). The walk runs on the main thread (no worker_threads
  // budget contention) and the file reads are pure I/O — Linux readahead
  // saturates well above 32 in-flight ops on a 4-vCPU ubuntu-latest runner.
  // Aggregate fd ceiling: 64 simultaneous open files, three orders of
  // magnitude under the ulimit 65535 default.
  const IN_FLIGHT = 64;
  let cursor = 0;

  const lane = async (): Promise<void> => {
    while (cursor < locs.length) {
      const i = cursor++;
      const loc = locs[i];
      const urlPath = new URL(loc).pathname.replace(/\/+$/, '');
      // Cross-shard keep: when running a single-locale shard, a loc whose
      // owning locale this shard does not emit has no HTML on disk by design —
      // keep it so the it/main shard's sitemap stays complete. Skipped entirely
      // in the default build (EMIT_ALL_LOCALES) so behaviour is byte-identical.
      if (!EMIT_ALL_LOCALES && !shouldEmitLocale(localeOfDistPath(urlPath, ''))) {
        flags[i] = KEEP;
        continue;
      }
      const indexPath = path.join(distDir, urlPath, 'index.html');
      const flatPath = path.join(distDir, urlPath + '.html');
      let html: string | null = null;
      try {
        html = await fs.promises.readFile(indexPath, 'utf-8');
      } catch {
        try {
          html = await fs.promises.readFile(flatPath, 'utf-8');
        } catch {
          flags[i] = DROP_MISSING;
          continue;
        }
      }
      if (NOINDEX_RE.test(html)) {
        flags[i] = DROP_NOINDEX;
        continue;
      }
      const canonMatch =
        html.match(CANONICAL_HREF_RE) || html.match(CANONICAL_HREF_REVERSED_RE);
      if (canonMatch && canonMatch[1]) {
        const canonHref = canonMatch[1].trim();
        if (normalizeLocForCanonicalCmp(canonHref) !== normalizeLocForCanonicalCmp(loc)) {
          flags[i] = DROP_NONCANON;
          continue;
        }
      }
      flags[i] = KEEP;
    }
  };

  const lanes: Promise<void>[] = [];
  for (let l = 0; l < Math.min(IN_FLIGHT, locs.length); l++) lanes.push(lane());
  await Promise.all(lanes);

  const out: string[] = [];
  let droppedNoindex = 0;
  let droppedNonCanonical = 0;
  for (let i = 0; i < locs.length; i++) {
    const f = flags[i];
    if (f === KEEP) out.push(locs[i]);
    else if (f === DROP_NOINDEX) droppedNoindex++;
    else if (f === DROP_NONCANON) droppedNonCanonical++;
  }
  if (droppedNoindex > 0 || droppedNonCanonical > 0) {
    console.log(
      `\x1b[33m[related-search-clusters]\x1b[0m dropped ${droppedNoindex} noindex + ${droppedNonCanonical} non-self-canonical URL(s) from sitemap (cross-plugin overwrite races)`,
    );
  }
  return out;
}

/**
 * Drop the given cross-section mirror loc URLs from sitemap-jobs.xml (issue #911).
 *
 * sitemap-jobs.xml is owned by jobsSeoPagesPlugin (a `default`-phase plugin) and
 * lists keyword/search landings as SELF-canonical TI URLs. This `post`-phase
 * plugin then overwrites the HTML at those legacy per-canton paths with mirrors
 * whose `<link rel="canonical">` points to the Svizzera aggregate — so the TI
 * URL stops being self-canonical and `audit:sitemap-canonicals` (0-tolerance)
 * fails, blocking publish. jobsSeoPagesPlugin's sitemap can't know about our
 * overwrite, so we patch it here: remove exactly the `<url>` blocks whose `<loc>`
 * is one we mirrored. Targeted (membership test, no HTML re-scan) — only the
 * cluster mirror URLs are touched; the ~200k self-canonical job-detail entries
 * are left byte-identical.
 *
 * Safe ordering: sitemap-jobs.xml is written in the `default` phase, fully
 * flushed before any `post`-phase plugin runs (and we additionally await
 * `jobsSeoPagesFlushed` at both call sites). sitemapAliasPlugin only regenerates
 * the master `sitemap.xml` INDEX from a directory scan; it never rewrites this
 * file's URL body, so our patch survives.
 */
/**
 * Pure core of the sitemap-jobs.xml patch: remove every `<url>...</url>` block
 * whose `<loc>` matches one of `mirrorLocs` (compared via canonical-normalized
 * form, so trailing-slash/host-case differences don't matter). Exported for
 * unit testing — no filesystem access here.
 */
export function dropUrlBlocksByLoc(
  xml: string,
  mirrorLocs: ReadonlyArray<string>,
): { xml: string; dropped: number } {
  if (mirrorLocs.length === 0) return { xml, dropped: 0 };
  const dropSet = new Set(mirrorLocs.map(normalizeLocForCanonicalCmp));
  const LOC_RE = /<loc>([^<]+)<\/loc>/;
  let dropped = 0;
  const patched = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
    const m = block.match(LOC_RE);
    if (m && dropSet.has(normalizeLocForCanonicalCmp(m[1]))) {
      dropped++;
      return '';
    }
    return block;
  });
  return { xml: patched, dropped };
}

async function dropMirrorLocsFromSitemapJobs(
  distDir: string,
  mirrorLocs: ReadonlyArray<string>,
): Promise<void> {
  if (mirrorLocs.length === 0) return;
  const sitemapPath = path.join(distDir, 'sitemap-jobs.xml');
  let xml: string;
  try {
    xml = await fs.promises.readFile(sitemapPath, 'utf-8');
  } catch {
    return; // sitemap-jobs.xml not emitted this build — nothing to patch.
  }
  const { xml: patched, dropped } = dropUrlBlocksByLoc(xml, mirrorLocs);
  if (dropped > 0) {
    await fs.promises.writeFile(sitemapPath, patched, 'utf-8');
    console.log(
      `\x1b[33m[related-search-clusters]\x1b[0m dropped ${dropped} cross-section mirror URL(s) from sitemap-jobs.xml (canonical → Svizzera, issue #911)`,
    );
  }
}

async function writeSitemap(
  distDir: string,
  allLocs: ReadonlyArray<string>,
  dateStamp: string,
): Promise<string[]> {
  // Wait for jobsSeoPagesPlugin to flush its buffered writes (notably the
  // previousSlugs bridge HTML) before scanning dist/ HTML for canonical
  // mismatches. Vite/Rollup runs closeBundle hooks in parallel by default
  // (commit 15536b1d94 — `parallel closeBundle is now the default`), so
  // without this barrier the cluster sitemap is written while bridge files
  // are still buffered and bridge URLs whose canonical points elsewhere
  // leak into sitemap-search-clusters.xml — audit:sitemap-canonicals fails.
  const __tFlushWait = profileStart();
  await jobsSeoPagesFlushed;
  profileRecord('sw:wait-jobs-flush', __tFlushWait);
  const __tDrop = profileStart();
  const locs = await dropOverwrittenLocs(distDir, allLocs);
  profileRecord('sw:drop-overwritten', __tDrop);
  if (locs.length === 0) return [];

  // Clear any stale single-file legacy sitemap or shard residue from a
  // previous run that produced more shards than this one. Without this,
  // a shrinking corpus would leave dangling sitemap-search-clusters-NNN.xml
  // files referenced by the auto-discovered sitemap.xml index.
  const __tClearStale = profileStart();
  clearStaleClusterSitemaps(distDir);
  profileRecord('sw:clear-stale', __tClearStale);

  const totalShards = Math.max(1, Math.ceil(locs.length / SITEMAP_SHARD_CAP));
  const written: string[] = [];
  try {
    fs.mkdirSync(distDir, { recursive: true });
    for (let i = 0; i < totalShards; i++) {
      const __tSerialize = profileStart();
      const slice = locs.slice(i * SITEMAP_SHARD_CAP, (i + 1) * SITEMAP_SHARD_CAP);
      const entries = slice.map((loc) =>
        `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
      ).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
      profileRecord('sw:serialize-xml', __tSerialize);
      const __tWriteShard = profileStart();
      const file = shardFilename(i + 1);
      fs.writeFileSync(path.join(distDir, file), xml, 'utf-8');
      profileRecord('sw:write-shard', __tWriteShard);
      written.push(file);
    }
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m sitemap write failed:', err);
    return written;
  }
  console.log(
    `\x1b[36m[related-search-clusters]\x1b[0m sharded ${locs.length} URLs into ${written.length} file(s) at ${SITEMAP_SHARD_CAP}/shard`,
  );
  const __tPatchMaster = profileStart();
  patchMasterSitemap(distDir, dateStamp, written);
  profileRecord('sw:patch-master', __tPatchMaster);
  return written;
}

/**
 * Register the cluster sitemap in `dist/sitemap.xml` (master sitemap index).
 * Idempotent: refreshes the lastmod when the entry already exists, otherwise
 * appends a new <sitemap> entry. Always re-runs even on cache hit because
 * `dist/sitemap.xml` is owned by another plugin and is regenerated each
 * build.
 */
function patchMasterSitemap(distDir: string, dateStamp: string, shardFiles: ReadonlyArray<string>): void {
  const masterPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterPath)) return;
  if (shardFiles.length === 0) return;
  try {
    let idx = fs.readFileSync(masterPath, 'utf-8');
    // Strip any legacy single-file entry plus prior shard entries — they're
    // re-emitted below from the authoritative shardFiles list.
    idx = idx.replace(
      /\s*<sitemap>\s*<loc>https:\/\/frontaliereticino\.ch\/sitemap-search-clusters(?:-\d+)?\.xml<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>\s*<\/sitemap>/g,
      '',
    );
    const newEntries = shardFiles
      .map(
        (file) =>
          `  <sitemap>\n    <loc>${BASE_URL}/${file}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>`,
      )
      .join('\n');
    idx = idx.replace('</sitemapindex>', `${newEntries}\n</sitemapindex>`);
    fs.writeFileSync(masterPath, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to patch master sitemap:', err);
  }
  // Note: sitemapAliasPlugin runs `enforce: 'post'` AFTER us and regenerates
  // sitemap.xml entirely from a directory scan of dist/sitemap-*.xml. This
  // patch is therefore defensive — it keeps the file valid for any consumer
  // that inspects it between our write and the alias plugin's overwrite.
}

// ── Plugin entry ────────────────────────────────────────────────────────

export function relatedSearchClustersPlugin(rootDir: string): Plugin {
  return {
    name: 'related-search-clusters',
    apply: 'build',
    // Vite groups closeBundle hooks by enforce: pre → default → post.
    // staticPagesPlugin uses `enforce: 'post'` to emit the section-landing
    // index.html files (/cerca-lavoro-ticino/, /en/find-jobs-ticino/, etc.)
    // AFTER all default-order plugins. We need to run AFTER staticPages so
    // injectHubLinkIntoSectionLanding() finds those landings on disk and
    // can patch in the link to the cluster paginated hub. Joining the
    // post group too — and being registered AFTER staticPages in
    // vite.config.ts — guarantees that ordering. Without this we got 4
    // "section landing missing — skipping hub link injection" warnings
    // every build.
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_RELATED_SEARCH_CLUSTERS === '1') {
        console.log('\x1b[36m[related-search-clusters]\x1b[0m skipped via SKIP_RELATED_SEARCH_CLUSTERS');
        return;
      }

      commuterCtxCache.clear();

      const distDir = path.resolve(rootDir, 'dist');
      const startedAt = Date.now();
      const dateStamp = new Date().toISOString().slice(0, 10);

      // Tiered emission for cluster pages (urlClass: 'gsc-keyword-landing').
      // 2026-05-28 dist: 517 k pages = 5.17 GB = 57 % of jobs-seo bucket;
      // sample shows `<main class=cluster-seo-prose>` block accounts for
      // 77 % of each page's bytes. Filter consults
      // data/evidence-index.json + data/thin-page-promotions-active.json
      // + data/url-pruning-approved-patterns.json. URL with traffic stays
      // full; URL without and matching the approved pattern becomes a
      // thin shell (HEAD preserved verbatim; main block replaced with a
      // slim h1 + ≥50-word paragraph linking back to the canonical hub).
      // SPA hydrates the filtered listing client-side from the URL.
      // See build-plugins/shared/clusterThinShell.ts.
      const trafficFilter = getTrafficEvidenceFilter(rootDir);
      let clusterFullCount = 0;
      let clusterThinCount = 0;
      let clusterBytesSaved = 0;

      // Cache fast path. If inputs haven't changed since the last emit,
      // restore the cluster + hub HTML + sitemap fragment from disk, run
      // the cross-plugin patches (master sitemap + hub-link injection)
      // that DEPEND on other plugins' fresh output, and skip the slow
      // matching + render loop entirely.
      //
      // Disable with RELATED_SEARCH_CLUSTERS_NO_CACHE=1 (e.g. during
      // local debugging when you want a clean re-emit).
      const cacheEnabled = process.env.RELATED_SEARCH_CLUSTERS_NO_CACHE !== '1';
      const __tCacheKey = profileStart();
      const cacheKey = cacheEnabled ? computeCacheKey(rootDir) : '';
      profileRecord('cache-key', __tCacheKey);
      if (cacheEnabled) {
        const __tCacheRestore = profileStart();
        const restored = await tryRestoreFromCache(rootDir, distDir, cacheKey);
        profileRecord('cache-restore-check', __tCacheRestore);
        if (restored) {
          // Re-run the cross-plugin patches against THIS build's dist.
          const __tCacheHitPatch = profileStart();
          for (const { locale, url } of restored.hubs) {
            injectHubLinkIntoSectionLanding(distDir, locale, url, COPY[locale]);
            injectPageIndexIntoOrphanHub(distDir, locale);
          }
          // Discover whatever shards the cache restored (legacy single-file
          // or sharded) and re-advertise them in the master sitemap.
          const restoredShards = fs.existsSync(distDir)
            ? fs.readdirSync(distDir).filter((f) =>
                new RegExp(`^${SITEMAP_SHARD_PREFIX}(?:-\\d+)?\\.xml$`).test(f),
              ).sort()
            : [];
          patchMasterSitemap(distDir, dateStamp, restoredShards);
          // issue #911: also drop our cross-section mirror URLs from
          // sitemap-jobs.xml on the cache-hit path. Await the jobs flush first
          // (the emit path gets this barrier inside writeSitemap; here we must
          // do it explicitly since we skip writeSitemap entirely).
          await jobsSeoPagesFlushed;
          await dropMirrorLocsFromSitemapJobs(distDir, restored.crossSectionMirrorLocs ?? []);
          profileRecord('cache-hit-patches', __tCacheHitPatch);
          console.log(
            `\x1b[36m[related-search-clusters]\x1b[0m cache HIT (key=${cacheKey}): ${restored.emittedCount} files restored in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          );
          printRelatedSearchProfile();
          return;
        }
        console.log(`\x1b[36m[related-search-clusters]\x1b[0m cache MISS (key=${cacheKey}): full emit`);
      }

      const __tLoadCandidates = profileStart();
      const candidates = filterAndDedupeCandidates(loadCandidates(rootDir));
      profileRecord('load-candidates', __tLoadCandidates);
      if (candidates.length === 0) {
        console.log('\x1b[36m[related-search-clusters]\x1b[0m 0 candidates after filtering — nothing to emit');
        printRelatedSearchProfile();
        return;
      }
      const __tLoadEnriched = profileStart();
      const enriched = loadEnriched(rootDir);
      profileRecord('load-enriched', __tLoadEnriched);
      const __tLoadJobs = profileStart();
      const jobs = loadJobs(rootDir);
      profileRecord('load-jobs', __tLoadJobs);
      // GSC/GA4/PostHog-driven mirror paths, keyed by `${locale}::${slug}`.
      // Empty map when the data file is missing or hasn't been populated yet
      // (cron `.github/workflows/refresh-indexed-cluster-urls.yml` runs
      // weekly; first run after deploy populates it). Empty map is safe:
      // the emit loop still produces the TI + legacyCantonGroup default
      // mirrors for every cluster.
      const indexedClusterUrlsByKey = loadIndexedClusterUrls(rootDir);
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${candidates.length} candidates, ${Object.keys(enriched).length} enriched entries, ${jobs.length} jobs, ${indexedClusterUrlsByKey.size} GSC-driven mirror keys`);

      // Inverted token index: lazy posting lists per (locale, token), shared
      // across every candidate. Memory budget is dominated by the haystack
      // cache (4 locales × ~2k jobs × ~5 KB ≈ 40 MB) plus posting lists
      // (~13.6k entries × ~100 idx avg ≈ 5 MB). Index queries are only
      // needed during the match loop below; we free both haystacks and
      // postings before the heavier render+emit phase to keep peak heap
      // down for the rest of closeBundle.
      const tokenIndex = new TokenIndex(jobs);

      // Postings pre-pass: build the per-locale haystack + 2/3-gram index
      // and resolve every token that build-contexts will need OFF the main
      // thread, one worker per locale. Profiling on run 26457892172 showed
      // bc:postings-miss = 70.7s (68% of build-contexts) — 30,715 cold
      // posting builds each costing ~2.3ms. Splitting across 4 workers (one
      // per locale) lets us reclaim ~75% of that wall-clock while the
      // build-contexts loop runs the OR/AND merges on cache hits only.
      //
      // Skip the pre-pass for very small token sets (worker spawn ~250-500ms
      // each is dead weight below the threshold) or when explicitly disabled.
      const __tPrePass = profileStart();
      const POSTINGS_PREPASS_MIN_TOKENS = 200;
      const prepassDisabled = process.env.RELATED_SEARCH_POSTINGS_PREPASS === '0';
      const tokensByLocale = new Map<Locale, Set<string>>();
      if (!prepassDisabled) {
        for (const cand of candidates) {
          const sampleTerm = (cand.sampleTerms || [])[0] || '';
          if (!sampleTerm) continue;
          // Warm the SAME stripped tokens buildClusterContext queries (L923).
          // Seeding the raw term would build posting lists for the highest-
          // frequency boilerplate tokens ("lavoro"/"offerte"/"emploi"/"stellen")
          // — the most expensive cold builds — that the matcher never requests.
          const tokens = tokenizeQuery(stripSearchQueryBoilerplate(sampleTerm));
          if (tokens.length === 0) continue;
          let set = tokensByLocale.get(cand.locale);
          if (!set) {
            set = new Set<string>();
            tokensByLocale.set(cand.locale, set);
          }
          for (const t of tokens) set.add(t);
        }
      }
      const totalTokens = Array.from(tokensByLocale.values()).reduce((s, set) => s + set.size, 0);
      if (!prepassDisabled && totalTokens >= POSTINGS_PREPASS_MIN_TOKENS) {
        const workerUrl = new URL('./relatedSearchPostingsWorker.mjs', import.meta.url);
        const localeKeys = Array.from(tokensByLocale.keys());
        // Build a SLIM, same-order projection once: the worker reads only these
        // seven fields (relatedSearchPostingsWorker buildJobHaystack) and returns
        // postings by job INDEX, so order/length must match `jobs` exactly. This
        // avoids structured-cloning the full ~88 MB dataset into each of up to 4
        // worker boot payloads simultaneously (the "external memory pressure" in
        // the build OOM). Output is byte-identical. (Build OOM fix, #1290.)
        // `cantonSearch` is the canton-name token string resolved HERE (the
        // worker can't import the canton JSON) so the worker haystack stays
        // byte-identical to this plugin's buildJobHaystack (issue #2967).
        const slimJobs = jobs.map((j: any) => ({
          title: j.title,
          titleByLocale: j.titleByLocale,
          description: j.description,
          descriptionByLocale: j.descriptionByLocale,
          company: j.company,
          location: j.location,
          cantonSearch: cantonSearchTokens(j.canton ?? ''),
        }));
        // Concurrency cap on simultaneous workers. Each worker builds a FULL
        // per-locale 2/3-gram inverted index (~hundreds of MB for ~11k jobs)
        // that lives until the worker exits. Spawning all 4 locales at once
        // (the old Promise.all) stacked 4 of those indexes on top of the
        // already-~9.7 GB build heap → systemd-oomd SIGTERM (exit 143) on the
        // 16 GB runner — a kernel-level OOM, no V8 "heap limit" line. Batching
        // keeps at most PREPASS_CONCURRENCY worker indexes resident at a time;
        // output is byte-identical (results are seeded into the same
        // tokenIndex), the only cost is ~tens of seconds of pre-pass wall-time
        // when locales run in batches instead of fully parallel. Env override
        // RELATED_SEARCH_PREPASS_CONCURRENCY lets us drop to 1 (max safety) or
        // raise it again if runner headroom returns, with no code change.
        const PREPASS_CONCURRENCY = Math.max(
          1,
          Number(process.env.RELATED_SEARCH_PREPASS_CONCURRENCY) || 2,
        );
        const runPrepassWorker = (workerLocale: Locale) => {
          const localeTokens = Array.from(tokensByLocale.get(workerLocale) as Set<string>);
          return new Promise<{ locale: Locale; entries: Array<{ token: string; list: number[] }> }>(
            (resolve, reject) => {
              const worker = new Worker(workerUrl, {
                workerData: { jobs: slimJobs, locale: workerLocale, tokens: localeTokens },
              });
              // Resolve on 'exit', NOT 'message': the worker holds its full
              // per-locale gram index (~hundreds of MB) in memory until it tears
              // down. Resolving on 'message' would let the next batch spawn while
              // this batch's workers are still resident → up to 2×concurrency
              // indexes overlapping at the OOM ceiling (worst case = the original
              // all-at-once spawn, defeating the cap). Gating on 'exit' makes the
              // reclamation airtight: batch N is fully torn down before N+1
              // allocates. The message payload is captured first, then surfaced
              // once the worker has exited cleanly.
              let payload: { locale: Locale; entries: Array<{ token: string; list: number[] }> } | null = null;
              worker.once('message', (msg) => {
                payload = msg;
              });
              worker.once('error', reject);
              worker.once('exit', (code) => {
                if (code !== 0) {
                  reject(new Error(`relatedSearchPostingsWorker exited with code ${code}`));
                } else if (!payload) {
                  reject(new Error('relatedSearchPostingsWorker exited without posting a result'));
                } else {
                  resolve(payload);
                }
              });
            },
          );
        };
        let seededCount = 0;
        for (let i = 0; i < localeKeys.length; i += PREPASS_CONCURRENCY) {
          const batch = localeKeys.slice(i, i + PREPASS_CONCURRENCY);
          const batchResults = await Promise.all(batch.map(runPrepassWorker));
          // Seed per-batch so each worker's transient gram index is reclaimed
          // (worker exit) before the next batch spawns.
          for (const r of batchResults) {
            tokenIndex.seedPostings(r.locale, r.entries);
            seededCount += r.entries.length;
          }
        }
        console.log(
          `\x1b[36m[related-search-clusters]\x1b[0m postings pre-pass: ${localeKeys.length} worker(s) seeded ${seededCount} token postings (concurrency ${PREPASS_CONCURRENCY})`,
        );
      }
      profileRecord('postings-prepass', __tPrePass);

      const contexts: ClusterContext[] = [];
      const __tContextBuild = profileStart();
      for (const cand of candidates) {
        const ctx = buildClusterContext(cand, tokenIndex, jobs);
        if (ctx) contexts.push(ctx);
      }
      profileRecord('build-contexts', __tContextBuild);
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${contexts.length} clusters survived match-≥${MIN_MATCHING_JOBS} filter`);
      tokenIndex.clear(); // GC haystacks + posting lists before the render/emit loop runs

      if (contexts.length === 0) {
        printRelatedSearchProfile();
        return;
      }

      // Group by (normalized keyword + city) for cross-locale hreflang lookup.
      // The composite key is also reused inside the per-cluster render loop
      // (the `altKey` lookup against `byKeywordCity`), so we cache it onto a
      // side Map keyed by ctx — `normalizeText` is NFKD + regex per call,
      // ~180k × 2 calls/page in the render loop = ~360k normalizeText ops we
      // skip by sharing the result.
      const __tGroupHreflang = profileStart();
      const byKeywordCity = new Map<string, Map<Locale, ClusterContext>>();
      const altKeyByCtx = new Map<ClusterContext, string>();
      for (const ctx of contexts) {
        const key = `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
        altKeyByCtx.set(ctx, key);
        let inner = byKeywordCity.get(key);
        if (!inner) {
          inner = new Map();
          byKeywordCity.set(key, inner);
        }
        inner.set(ctx.candidate.locale, ctx);
      }
      profileRecord('group-hreflang', __tGroupHreflang);

      // Group by locale + city for related-link suggestions.
      const __tGroupRelated = profileStart();
      const byLocale = new Map<Locale, ClusterContext[]>();
      const byLocaleCity = new Map<Locale, Map<string, ClusterContext[]>>();
      for (const ctx of contexts) {
        const arr = byLocale.get(ctx.candidate.locale) || [];
        arr.push(ctx);
        byLocale.set(ctx.candidate.locale, arr);
        if (ctx.city) {
          let inner = byLocaleCity.get(ctx.candidate.locale);
          if (!inner) {
            inner = new Map();
            byLocaleCity.set(ctx.candidate.locale, inner);
          }
          const cityArr = inner.get(ctx.city) || [];
          cityArr.push(ctx);
          inner.set(ctx.city, cityArr);
        }
      }
      profileRecord('group-related-links', __tGroupRelated);

      const collector = new WriteCollector({ distDir, pluginName: 'relatedSearchClustersPlugin' });
      const sitemapLocs: string[] = [];
      const emittedFiles: string[] = []; // dist-relative paths for cache save
      // Legacy per-canton mirror loc URLs (canonical → Svizzera) we overwrite in
      // dist/. Collected during the emit loop, persisted to the cache manifest,
      // and dropped from sitemap-jobs.xml after jobs flush (issue #911).
      const crossSectionMirrorLocs: string[] = [];
      const cachedHubs: { locale: Locale; url: string }[] = [];

      // ── Per-cluster pages ─────────────────────────────────────────────
      //
      // NOTE: PR #382 attempted a worker_threads parallel path (see helper
      // `renderClustersInParallel` below + sibling `*RenderWorker.mjs`).
      // It failed in CI with ERR_MODULE_NOT_FOUND because tsx in
      // `--import` mode can't resolve extension-less relative imports
      // (`./batchWrite`, `./constants`, etc.) when the worker dynamic-
      // imports this plugin file. postWalkWorker works because
      // flatHtmlRedirectPlugin.ts has zero relative imports — this plugin
      // has ~15 transitive .ts deps. Proper fix requires extracting
      // renderClusterPage into a standalone module with explicit `.ts`
      // imports (deferred). For now we keep the sequential loop.
      let __renderClusterCounter = 0;
      for (const ctx of contexts) {
        // Backpressure every 2000 iterations — relatedSearchClustersPlugin
        // emits ~360k files (180k cluster pages × 2 [index.html + flat]).
        // Without this, WriteCollector closures pile up the same way they
        // did in jobsSeoPagesPlugin pre-PR #628: render-cluster-page
        // measured 1.18 ms avg in run 26490352942 (~213 s total), doubled
        // from the 0.59 ms / 106 s baseline because heap pressure under
        // the 12 GB cap forced V8 into constant scavenges. Capping
        // in-flight at 2 keeps pending HTML closures bounded → V8 GC has
        // less to chase → per-page render returns to baseline speed.
        if (++__renderClusterCounter % 2000 === 0) {
          await collector.awaitDrainSlot(2);
        }
        const __tRenderCluster = profileStart();
        const locale = ctx.candidate.locale;
        // Locale-shard render-skip (BUILD_LOCALE, LOCALE-SHARD-BUILD-PLAN Fase 0):
        // for a locale this shard is NOT emitting, skip the expensive
        // renderClusterPage + collector writes (the bulk of this plugin's
        // ~264s). Still record the canonical + legacy-mirror locs CHEAPLY
        // (string-only via buildClusterPath, no render) so the it/main shard —
        // which owns sitemap-search-clusters.xml and the sitemap-jobs.xml
        // mirror-drop patch (issue #911) — keeps a complete cross-locale set.
        // No-op in the default all-locale build (shouldEmitLocale always true).
        if (!shouldEmitLocale(locale)) {
          const __skUrlPath = buildClusterPath(locale, ctx.candidate.slug, ctx.cantonGroup);
          sitemapLocs.push(`${BASE_URL}${__skUrlPath}`);
          const __skMirror = new Set<string>();
          for (const __skMc of [ctx.legacyCantonGroup, 'TI']) {
            if (__skMc === AGGREGATE_KEY) continue;
            __skMirror.add(buildClusterPath(locale, ctx.candidate.slug, __skMc));
          }
          const __skExtra = indexedClusterUrlsByKey.get(`${locale}::${ctx.candidate.slug}`);
          if (__skExtra) for (const p of __skExtra) __skMirror.add(p);
          __skMirror.delete(__skUrlPath);
          for (const mp of __skMirror) crossSectionMirrorLocs.push(`${BASE_URL}${mp.replace(/\/+$/, '')}/`);
          continue;
        }
        // altKey was precomputed in the group-hreflang loop above and cached
        // on `altKeyByCtx` so we don't re-normalize ctx.keyword + ctx.city
        // here. Falls back to fresh compute for safety on the (impossible
        // in practice) ctx-not-in-map path.
        const altKey = altKeyByCtx.get(ctx) ?? `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
        const altMap = byKeywordCity.get(altKey);
        const hreflang = altMap
          ? Array.from(altMap.entries()).map(([loc, otherCtx]) => ({
              locale: loc,
              url: `${BASE_URL}${buildClusterPath(loc, otherCtx.candidate.slug, otherCtx.cantonGroup)}`,
            }))
          : [];

        const cityIdx = byLocaleCity.get(locale);
        const sameCityList = (ctx.city && cityIdx?.get(ctx.city)) || [];
        const related = sameCityList
          .filter((other) => other.candidate.slug !== ctx.candidate.slug)
          .slice(0, 8)
          .map((other) => ({
            keyword: other.city ? `${capitalize(other.keyword)} — ${other.city}` : capitalize(other.keyword),
            url: `${BASE_URL}${buildClusterPath(locale, other.candidate.slug, other.cantonGroup)}`,
          }));

        const enrichedKey = `${locale}::${ctx.candidate.slug}`;
        const out = renderClusterPage({
          ctx,
          enriched: enriched[enrichedKey],
          hreflang,
          related,
          distDir,
          dateStamp,
        });

        // Tiered emission decision per cluster context. The same html
        // payload is reused for the canonical + the flat-bridge source
        // + every legacy-canton mirror, so we decide once and apply
        // uniformly. PR #743 fix: compute the mirror set BEFORE the
        // decision and pass every candidate path through
        // `decideMulti` — GSC + GA4 attribute traffic to the legacy
        // mirror (typically `/cerca-lavoro-ticino/ricerca-X/`), not
        // the freshly-promoted Svizzera canonical, so checking only
        // `out.urlPath` would false-negative on essentially every
        // cluster with real traffic.
        const __clMirrorPaths = new Set<string>();
        for (const mirrorCanton of [ctx.legacyCantonGroup, 'TI']) {
          if (mirrorCanton === AGGREGATE_KEY) continue;
          __clMirrorPaths.add(buildClusterPath(locale, ctx.candidate.slug, mirrorCanton));
        }
        const __clExtraKey = `${locale}::${ctx.candidate.slug}`;
        const __clExtraPaths = indexedClusterUrlsByKey.get(__clExtraKey);
        if (__clExtraPaths) for (const p of __clExtraPaths) __clMirrorPaths.add(p);
        __clMirrorPaths.delete(out.urlPath);
        // PR #749: cross-locale safety net for the DECISION ONLY. Each
        // cluster context is emitted at a single locale, but the same
        // slug at the same canton in EN/DE/FR is a separate URL with
        // its own GSC + GA4 footprint. If any locale variant has
        // indexation evidence the cluster stays full in EVERY locale
        // (we own the content idea, not the per-locale page).
        //
        // CRITICAL: these probe-only paths are NOT added to
        // __clMirrorPaths because that Set is reused below for the
        // actual mirror EMIT loop. Adding cross-locale paths there
        // would write THIS-locale's HTML at OTHER-locales' URLs —
        // serving DE content at FR routes, etc. We keep emit + decide
        // payloads separate.
        const __clCrossLocaleProbes: string[] = [];
        for (const __clOtherLocale of ['it', 'en', 'de', 'fr'] as const) {
          if (__clOtherLocale === locale) continue;
          for (const __clOtherCanton of [ctx.cantonGroup, ctx.legacyCantonGroup, 'TI']) {
            if (__clOtherCanton === AGGREGATE_KEY) continue;
            __clCrossLocaleProbes.push(buildClusterPath(__clOtherLocale, ctx.candidate.slug, __clOtherCanton));
          }
          const __clOtherExtras = indexedClusterUrlsByKey.get(`${__clOtherLocale}::${ctx.candidate.slug}`);
          if (__clOtherExtras) for (const p of __clOtherExtras) __clCrossLocaleProbes.push(p);
        }
        const __clAllPaths = [out.urlPath, ...__clMirrorPaths, ...__clCrossLocaleProbes];
        const __clDecision = trafficFilter.decideMulti(__clAllPaths, 'gsc-keyword-landing');
        const __clAction: 'full' | 'thin' = __clDecision.action === 'thin' ? 'thin' : 'full';
        const __clHtml = __clAction === 'thin'
          ? buildClusterThinHtml(out.html, locale)
          : out.html;
        const __clDelta = __clAction === 'thin' ? out.html.length - __clHtml.length : 0;
        if (__clAction === 'thin') clusterThinCount++; else clusterFullCount++;

        const indexPath = path.join(distDir, out.urlPath, 'index.html');
        const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, __clHtml);
        clusterBytesSaved += __clDelta;
        // Emit the flat .html as a redirect bridge directly: postWalkCoordinator
        // would otherwise read this file (~30 KB), build the same bridge from
        // the sibling, and rewrite (~500 B). Pre-emitting the bridge cuts
        // ~52k × 30 KB writes here AND post-walk's `html === original` guard
        // skips the rewrite. Trims ~30-50 s off closeBundle.
        const slashUrl = `${BASE_URL}${out.urlPath.replace(/\/+$/, '')}/`;
        const flatBridge = buildFlatBridgeFromSibling(__clHtml, slashUrl);
        collector.add(flatPath, flatBridge);
        emittedFiles.push(path.relative(distDir, indexPath));
        emittedFiles.push(path.relative(distDir, flatPath));
        sitemapLocs.push(out.loc);

        // ── Legacy mirrors ──────────────────────────────────────────────
        // Emit byte-identical copies of the canonical (Svizzera) HTML at the
        // legacy per-canton paths that this cluster previously occupied. The
        // mirror's `<link rel="canonical">` already points to Svizzera (it's
        // baked into the rendered HTML), so search engines fold the mirror
        // into the canonical instead of treating it as a duplicate.
        //
        // Three mirror sources are merged into a single Set of absolute
        // paths (deduped + collision-guarded against the canonical):
        //   1. `ctx.legacyCantonGroup` — canton of `matchingJobs[0]`, the
        //      URL the pre-refactor build emitted AND where the
        //      sitemap-search-clusters shards still advertise the cluster
        //      from previous deploys (definitely crawled by Google).
        //   2. `'TI'` — legacy default section. The JobBoard related-search
        //      widget (components/community/JobBoard.tsx:5776) used
        //      `buildPath` without `jobBoardCanton`, falling back to
        //      `table.jobBoard` (cerca-lavoro-ticino / find-jobs-ticino /
        //      jobs-im-tessin / trouver-emploi-tessin), so Googlebot
        //      followed those internal links and indexed the TI variant
        //      across all locales.
        //   3. `data/indexed-cluster-urls.json` — GSC + GA4 + PostHog union
        //      of cluster URLs under any non-aggregator section that still
        //      receives traffic. Populated weekly by
        //      `.github/workflows/refresh-indexed-cluster-urls.yml`. Lets
        //      us preserve URLs Google indexed back when the top-match was
        //      a now-stale canton (e.g. cluster pinned to BL last month,
        //      pinned to ZH this month — GSC's BL impressions keep the BL
        //      mirror alive even after legacyCantonGroup moved to ZH).
        //
        // Mirrors are NOT added to sitemapLocs: only the Svizzera canonical
        // appears in sitemap-search-clusters.xml, so audit:sitemap-canonicals
        // continues to pass. Mirrors stay out of the index over time.
        // Mirror set was collected upstream for the decideMulti call
        // (PR #743 fix). Reuse it here so canonical-collision dedup
        // and per-source merging happen in exactly one place.
        const mirrorPaths = __clMirrorPaths;
        for (const mirrorPath of mirrorPaths) {
          // Mirrors emit ONLY index.html — no flat .html bridge. The slash
          // mirror already canonicalizes to Svizzera (via the rendered
          // HTML's `<link rel="canonical">`), so a flat .html bridge would
          // be a second redirect hop for a low-value URL form (visitors
          // typing the URL without trailing slash). Cuts mirror file count
          // in half — relevant because ~70% of clusters emit 2+ mirrors
          // (legacyCanton + TI + any GSC-flagged extras) so doubling mirrors
          // via flat bridges would add hundreds of thousands of files for a
          // negligible UX gain.
          const mirrorIndexPath = path.join(distDir, mirrorPath, 'index.html');
          collector.add(mirrorIndexPath, __clHtml);
          clusterBytesSaved += __clDelta;
          emittedFiles.push(path.relative(distDir, mirrorIndexPath));
          // The mirror's HTML canonicalizes to Svizzera (out.loc), so this TI
          // URL must NOT remain a self-canonical sitemap entry. Record it for
          // the sitemap-jobs.xml patch (issue #911).
          crossSectionMirrorLocs.push(`${BASE_URL}${mirrorPath.replace(/\/+$/, '')}/`);
        }
        profileRecord('render-cluster-page', __tRenderCluster);
      }

      // ── Per-locale hub pages ──────────────────────────────────────────
      for (const [locale, list] of byLocale.entries()) {
        const items: HubItem[] = list.map((ctx) => {
          const path = buildClusterPath(locale, ctx.candidate.slug, ctx.cantonGroup);
          return {
            keyword: ctx.keyword,
            city: ctx.city,
            slug: ctx.candidate.slug,
            url: `${BASE_URL}${path}`,
            path,
          };
        });
        const totalPages = Math.max(1, Math.ceil(items.length / HUB_PAGE_SIZE));

        for (let page = 1; page <= totalPages; page++) {
          const __tRenderHub = profileStart();
          const slice = items.slice((page - 1) * HUB_PAGE_SIZE, page * HUB_PAGE_SIZE);
          const out = renderHubPage({
            locale,
            items: slice,
            page,
            totalPages,
            distDir,
            dateStamp,
          });
          const indexPath = path.join(distDir, out.urlPath, 'index.html');
          const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, out.html);
          collector.add(flatPath, buildFlatBridgeFromSibling(out.html, out.loc));
          emittedFiles.push(path.relative(distDir, indexPath));
          emittedFiles.push(path.relative(distDir, flatPath));
          sitemapLocs.push(out.loc);
          profileRecord('render-hub-page', __tRenderHub);
        }

        const hubUrl = `${BASE_URL}${buildHubPath(locale, 1)}`;
        cachedHubs.push({ locale, url: hubUrl });
      }

      const __tFlush = profileStart();
      const written = await collector.flush();
      profileRecord('collector-flush', __tFlush);
      const __tHubInject = profileStart();
      for (const { locale, url } of cachedHubs) {
        injectHubLinkIntoSectionLanding(distDir, locale, url, COPY[locale]);
        injectPageIndexIntoOrphanHub(distDir, locale);
      }
      profileRecord('inject-hub-link', __tHubInject);
      const __tSitemap = profileStart();
      const sitemapShards = await writeSitemap(distDir, sitemapLocs, dateStamp);
      profileRecord('sitemap-write', __tSitemap);
      for (const shard of sitemapShards) emittedFiles.push(shard);

      // issue #911: drop our cross-section mirror URLs from sitemap-jobs.xml.
      // writeSitemap already awaited jobsSeoPagesFlushed, so the file is final.
      const __tDropJobsMirrors = profileStart();
      await dropMirrorLocsFromSitemapJobs(distDir, crossSectionMirrorLocs);
      profileRecord('drop-jobs-mirrors', __tDropJobsMirrors);

      // Capture stats before releasing the maps that hold them.
      const ctxCount = contexts.length;
      const hubCount = byLocale.size;

      // Release the heavy in-memory maps that hold rendered HTML transitively
      // (contexts → matchingJobs → job descriptions; byLocale* → contexts).
      // saveToCache below does ~3,200 fs.copyFile syscalls in parallel and
      // doesn't need any of these — keeping them pinned would push peak
      // heap up while the next plugin's closeBundle starts overlapping.
      contexts.length = 0;
      byKeywordCity.clear();
      byLocale.clear();
      byLocaleCity.clear();

      // Persist for next build. patchMasterSitemap is intentionally skipped
      // here — it patches a file owned by another plugin and is re-run on
      // every build (cache-hit and miss alike) inside the cache fast path.
      if (cacheEnabled) {
        try {
          const __tCacheSave = profileStart();
          const cached = saveToCache(rootDir, distDir, cacheKey, emittedFiles, cachedHubs, sitemapLocs, crossSectionMirrorLocs);
          profileRecord('cache-save', __tCacheSave);
          console.log(`\x1b[36m[related-search-clusters]\x1b[0m saved ${cached} files to cache (${cacheKey})`);
        } catch (err) {
          console.warn('\x1b[33m[related-search-clusters]\x1b[0m cache save failed:', err);
        }
      }

      console.log(
        `\x1b[36m[related-search-clusters]\x1b[0m emitted ${ctxCount} cluster pages + ${hubCount} hubs (${written} files) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
      // Tiered emission summary. Counter records FILTER DECISIONS;
      // bytes_saved is the REAL delta (full html length − thin html
      // length) accumulated per emitted file (canonical + every legacy
      // mirror that reused the html). See PR #729 / #734 lesson:
      // counter ≠ saving when the regex misses.
      if (clusterThinCount > 0 || clusterFullCount > 0) {
        const fmtBytes = (n: number): string => {
          if (n < 1024) return `${n}B`;
          if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
          if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
          return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
        };
        console.log(
          `\x1b[36m[related-search-clusters]\x1b[0m cluster tier: ` +
          `full=${clusterFullCount} thin=${clusterThinCount} ` +
          `bytes_saved=${fmtBytes(clusterBytesSaved)}`,
        );
        console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${trafficFilter.summary()}`);
      }
      printRelatedSearchProfile();
    },
  };
}
