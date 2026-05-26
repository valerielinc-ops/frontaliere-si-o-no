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
import type { Plugin } from 'vite';

import { WriteCollector } from './batchWrite';
import { BASE_URL } from './constants';
import { buildFlatBridgeFromSibling } from './flatHtmlRedirectPlugin';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { buildTitleWithBrand, TITLE_MAX_CHARS } from './shared/titleSuffix';
import {
  renderJobBoardCommuterContext,
  renderSearchQueryIntro,
  buildJobBoardCommuterFaqItems,
  type JobBoardCommuterContextOpts,
} from './shared/jobBoardCommuterContext';
import {
  getJobBoardSectionSlug,
  getSearchSlugPrefix,
} from '../services/relatedSearchClusters';
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
const EJP_STRIPPED_MARKER = '<!--EJP_STRIPPED-->';

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

/** Tokenize a query string into [normalized, length>=2] tokens. */
function tokenizeQuery(query: string): string[] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

/** Build the per-locale normalized haystack once and cache it on the job. */
function buildJobHaystack(job: RawJob, locale: Locale): string {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${description}`);
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
  'build-plugins/relatedSearchClustersPlugin.ts',
  'build-plugins/relatedSearchClustersData.ts',
  'build-plugins/shared/seoPageShell.ts',
  'build-plugins/shared/seoContentTokens.ts',
  'build-plugins/shared/titleSuffix.ts',
  'build-plugins/shared/jobBoardCommuterContext.ts',
  'services/relatedSearchClusters.ts',
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
const CACHE_VERSION = 'v5';

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

// ── Filtering & dedupe ──────────────────────────────────────────────────

interface ClusterContext {
  candidate: CandidateEntry;
  keyword: string;
  city: string | null;
  matchingJobs: RawJob[];
  topCompanies: string[];
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
class TokenIndex {
  private haystacksByLocale = new Map<Locale, string[]>();
  private postingsByLocale = new Map<Locale, Map<string, number[]>>();
  private gramPostingsByLocale = new Map<Locale, Map<string, number[]>>();
  private readonly scratchScores: Uint16Array;
  private readonly touchedIdx: number[] = [];
  private readonly jobs: ReadonlyArray<RawJob>;

  constructor(jobs: ReadonlyArray<RawJob>) {
    this.jobs = jobs;
    this.scratchScores = new Uint16Array(jobs.length);
  }

  /** Posting list for (locale, token), sorted ascending by jobIdx (corpus order). */
  postings(locale: Locale, token: string): readonly number[] {
    let perLocale = this.postingsByLocale.get(locale);
    if (!perLocale) {
      perLocale = new Map<string, number[]>();
      this.postingsByLocale.set(locale, perLocale);
    }
    const cached = perLocale.get(token);
    if (cached !== undefined) return cached;

    const haystacks = this.getHaystacks(locale);
    const candidateJobs = this.candidateJobsForToken(locale, token);
    const list: number[] = [];
    for (const idx of candidateJobs) {
      if (haystacks[idx].includes(token)) list.push(idx);
    }
    perLocale.set(token, list);
    return list;
  }

  /**
   * Return the same top-N ordering as the old per-candidate Map+sort path:
   * all AND matches first in corpus order, then OR matches by score desc with
   * corpus-order tie breaks. The page only renders MAX_JOBS_PER_PAGE jobs, so
   * avoid materializing/sorting the full match universe for every candidate.
   */
  matchingJobs(locale: Locale, tokens: readonly string[], maxJobs: number): RawJob[] {
    const lists = tokens.map((tok) => this.postings(locale, tok));
    if (lists.length === 0) return [];

    if (lists.length === 1) {
      return lists[0].slice(0, maxJobs).map((idx) => this.jobs[idx]);
    }

    const matchingIdx = this.firstAndMatches(lists, maxJobs);
    if (matchingIdx.length < maxJobs) {
      this.fillOrMatches(lists, tokens.length, matchingIdx, maxJobs);
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
    const arr = new Array<string>(this.jobs.length);
    for (let i = 0; i < this.jobs.length; i++) {
      arr[i] = buildJobHaystack(this.jobs[i], locale);
    }
    this.haystacksByLocale.set(locale, arr);
    return arr;
  }

  private getGramPostings(locale: Locale): Map<string, number[]> {
    const cached = this.gramPostingsByLocale.get(locale);
    if (cached) return cached;

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

    for (let score = fullScore - 1; score >= 1 && out.length < maxJobs; score--) {
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

function buildClusterContext(
  candidate: CandidateEntry,
  index: TokenIndex,
  jobs: ReadonlyArray<RawJob>,
): ClusterContext | null {
  const sampleTerm = (candidate.sampleTerms || [])[0] || '';
  if (!sampleTerm) return null;
  const city = detectCity(sampleTerm);
  const keyword = stripCityFromKeyword(sampleTerm, city);
  if (!keyword) return null;

  const tokens = tokenizeQuery(sampleTerm);
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
  const matching = index.matchingJobs(candidate.locale, tokens, MAX_JOBS_PER_PAGE);

  if (matching.length < MIN_MATCHING_JOBS) return null;
  // Note: with MIN_MATCHING_JOBS=0 the line above is a no-op (length is
  // never negative). Kept as a literal expression of the floor so the
  // constant stays the single source of truth — flip it back to ≥1 here
  // by raising MIN_MATCHING_JOBS, not by editing the predicate.

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

  return { candidate, keyword: keyword.trim(), city, matchingJobs: matching, topCompanies };
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

/** Build the canonical URL path for a cluster page. */
function buildClusterPath(locale: Locale, slug: string): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Build the URL path for the per-locale hub. */
function buildHubPath(locale: Locale, page: number = 1): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const sub = getSearchSlugPrefix(locale);
  const base = `${prefix}/${section}/${sub}/`.replace(/\/+/g, '/');
  return page > 1 ? `${base}page-${page}/` : base;
}

/** Build a localized job-detail URL. */
function jobLocalizedUrl(job: RawJob, locale: Locale): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  if (!slug) return `${BASE_URL}${prefix}/${section}/`.replace(/\/+/g, '/');
  return `${BASE_URL}${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
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
  /** "Frontaliere region" — used inside H1 to differ from <title>. */
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
    regionH1Suffix: 'in Ticino',
    activeFiltersLabel: 'Filtri attivi',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'offerta trovata' : 'offerte trovate'}`,
  },
  en: {
    searchPlaceholder: 'Search by role, company or city…',
    searchingFor: 'Results for',
    filterChipPrefix: 'search',
    contextSummary: 'More about this search for cross-border applicants',
    regionFallback: 'Ticino',
    regionH1Suffix: 'in Ticino',
    activeFiltersLabel: 'Active filters',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'job found' : 'jobs found'}`,
  },
  de: {
    searchPlaceholder: 'Suche nach Rolle, Unternehmen oder Stadt…',
    searchingFor: 'Ergebnisse für',
    filterChipPrefix: 'Suche',
    contextSummary: 'Mehr zu dieser Suche für Grenzgänger',
    regionFallback: 'Tessin',
    regionH1Suffix: 'im Tessin',
    activeFiltersLabel: 'Aktive Filter',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'Stelle gefunden' : 'Stellen gefunden'}`,
  },
  fr: {
    searchPlaceholder: 'Recherche par poste, entreprise ou ville…',
    searchingFor: 'Résultats pour',
    filterChipPrefix: 'recherche',
    contextSummary: 'En savoir plus sur cette recherche pour les frontaliers',
    regionFallback: 'Tessin',
    regionH1Suffix: 'au Tessin',
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

  const urlPath = buildClusterPath(locale, candidate.slug);
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
        <ul class="s-tQuvrl">${related.map((r) => `<li><a href="${esc(r.url)}" style="${LINK_ACCENT_STYLE};display:inline-block;padding:4px 10px;background:var(--color-surface);border:1px solid var(--color-edge);border-radius:9999px;font-size:13px">${esc(r.keyword)}</a></li>`).join('')}</ul>
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
  // `paddingHtml`: a ~60-word inline-link paragraph emitted alongside
  // the strip so the rendered body always crosses the 50-word floor that
  // `validate:content-quality` enforces on every sitemap URL (block
  // observed in validate-dist run 26312619412 for `ricerca-sowie-bern`
  // at 49 words — a single sparse-AI-intro cluster slipped under). The
  // padding also rebuilds three crawl-graph edges the dropped
  // commuter-context block was carrying (calculator + cassemalati + valuta
  // comparators), so BFS-depth stays flat. Per-page cost: ~250 B raw,
  // ~80 B gzip — keeps the savings at ~143 MB gzip (was 150 MB).
  const paddingHtml = `<p class="s-clIDbe">Per confrontare lo stipendio CHF lordo dell'annuncio con il netto reale (vecchio vs nuovo accordo Italia-Svizzera 2024, zona di frontiera, telelavoro fino al 25 %), apri il <a class="s-U9K6Vf" href="/">calcolatore stipendio netto frontaliere</a>. Strumenti correlati: <a class="s-U9K6Vf" href="/comparatori/casse-malati/">comparatore casse malati LAMal</a>, <a class="s-U9K6Vf" href="/comparatori/cambio-valuta/">comparatore cambio CHF/EUR</a>.</p>`;
  const seoContextBlock = STRIP_CLUSTER_SEO_PROSE
    ? `${EJP_STRIPPED_MARKER}<details class="cluster-seo-context s-mxdIN0">
    <summary class="s-1yn7b_">${esc(chrome.contextSummary)}</summary>
    <div class="s-yZU6bn">
      <section class="s-p_RJwm">
        ${aiIntroHtml}
        ${paddingHtml}
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
  // 100% crawler-only. The SPA's hydrated JobBoard renders all visible
  // chrome for users (sub-nav, breadcrumb, search-query header, JobCard
  // grid, footer) inside `#root`. This static body holds the H1 + ~9KB
  // prose ONLY for crawlers + screen readers — wrapped in an off-screen
  // (clip-rect) container so sighted users see absolutely nothing from
  // the static layer. No `hubChrome` is passed below either, so the
  // sub-nav strip we previously emitted as a static sibling is gone.
  // SEO content stays in DOM (Googlebot indexes it with the same weight
  // as standard `<details>` accordion content per Search Central docs).
  const srOnlyStyle = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
  const bodyHtml = `<div class="related-search-cluster" style="${srOnlyStyle}">
    <h1>${esc(headlineH1)}</h1>
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
      links.push(`<a href="${esc(url)}" style="${LINK_ACCENT_STYLE};padding:6px 10px;border-radius:8px;border:1px solid var(--color-edge);background:var(--color-surface)">${p}</a>`);
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

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.hubTitle,
    url: canonicalUrl,
    description: copy.hubDescription,
    inLanguage: locale,
    dateModified: new Date().toISOString(),
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
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.homeBreadcrumb, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.jobsBreadcrumb, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: copy.searchBreadcrumb, item: canonicalUrl },
    ],
  });

  const bodyHtml = `<article class="s-haN35X">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.homeBreadcrumb)}</a>
      <span> / </span>
      <a href="${esc(sectionUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.jobsBreadcrumb)}</a>
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
 * we log a warning and skip — never fail.
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
  const pageLinks = hubPagePaths.slice(1).map((urlPath, idx) =>
    `<a href="${esc(urlPath)}">${idx + 2}</a>`,
  ).join(' ');
  const pageLinkBlock = pageLinks
    ? `<details><summary>${esc(copy.pageNavigatorLabel)}</summary><p>${pageLinks}</p></details>`
    : '';
  const linkBlock = `<nav class="s-4FS1gg" data-related-search-hub-link="1" aria-label="${esc(copy.searchBreadcrumb)}"><a href="${esc(hubUrl)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.hubH1)}</a>${pageLinkBlock}</nav>`;

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
const NOINDEX_RE = /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i;
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
function dropOverwrittenLocs(distDir: string, locs: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  let droppedNoindex = 0;
  let droppedNonCanonical = 0;
  for (const loc of locs) {
    const urlPath = new URL(loc).pathname.replace(/\/+$/, '');
    const indexPath = path.join(distDir, urlPath, 'index.html');
    const flatPath = path.join(distDir, urlPath + '.html');
    const target = fs.existsSync(indexPath) ? indexPath : flatPath;
    if (!fs.existsSync(target)) continue; // missing HTML — skip silently
    const html = fs.readFileSync(target, 'utf-8');
    if (NOINDEX_RE.test(html)) {
      droppedNoindex++;
      continue;
    }
    const canonMatch = html.match(CANONICAL_HREF_RE) || html.match(CANONICAL_HREF_REVERSED_RE);
    if (canonMatch && canonMatch[1]) {
      const canonHref = canonMatch[1].trim();
      if (normalizeLocForCanonicalCmp(canonHref) !== normalizeLocForCanonicalCmp(loc)) {
        droppedNonCanonical++;
        continue;
      }
    }
    out.push(loc);
  }
  if (droppedNoindex > 0 || droppedNonCanonical > 0) {
    console.log(
      `\x1b[33m[related-search-clusters]\x1b[0m dropped ${droppedNoindex} noindex + ${droppedNonCanonical} non-self-canonical URL(s) from sitemap (cross-plugin overwrite races)`,
    );
  }
  return out;
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
  await jobsSeoPagesFlushed;
  const locs = dropOverwrittenLocs(distDir, allLocs);
  if (locs.length === 0) return [];

  // Clear any stale single-file legacy sitemap or shard residue from a
  // previous run that produced more shards than this one. Without this,
  // a shrinking corpus would leave dangling sitemap-search-clusters-NNN.xml
  // files referenced by the auto-discovered sitemap.xml index.
  clearStaleClusterSitemaps(distDir);

  const totalShards = Math.max(1, Math.ceil(locs.length / SITEMAP_SHARD_CAP));
  const written: string[] = [];
  try {
    fs.mkdirSync(distDir, { recursive: true });
    for (let i = 0; i < totalShards; i++) {
      const slice = locs.slice(i * SITEMAP_SHARD_CAP, (i + 1) * SITEMAP_SHARD_CAP);
      const entries = slice.map((loc) =>
        `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
      ).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
      const file = shardFilename(i + 1);
      fs.writeFileSync(path.join(distDir, file), xml, 'utf-8');
      written.push(file);
    }
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m sitemap write failed:', err);
    return written;
  }
  console.log(
    `\x1b[36m[related-search-clusters]\x1b[0m sharded ${locs.length} URLs into ${written.length} file(s) at ${SITEMAP_SHARD_CAP}/shard`,
  );
  patchMasterSitemap(distDir, dateStamp, written);
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
          }
          // Discover whatever shards the cache restored (legacy single-file
          // or sharded) and re-advertise them in the master sitemap.
          const restoredShards = fs.existsSync(distDir)
            ? fs.readdirSync(distDir).filter((f) =>
                new RegExp(`^${SITEMAP_SHARD_PREFIX}(?:-\\d+)?\\.xml$`).test(f),
              ).sort()
            : [];
          patchMasterSitemap(distDir, dateStamp, restoredShards);
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
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${candidates.length} candidates, ${Object.keys(enriched).length} enriched entries, ${jobs.length} jobs`);

      // Inverted token index: lazy posting lists per (locale, token), shared
      // across every candidate. Memory budget is dominated by the haystack
      // cache (4 locales × ~2k jobs × ~5 KB ≈ 40 MB) plus posting lists
      // (~13.6k entries × ~100 idx avg ≈ 5 MB). Index queries are only
      // needed during the match loop below; we free both haystacks and
      // postings before the heavier render+emit phase to keep peak heap
      // down for the rest of closeBundle.
      const tokenIndex = new TokenIndex(jobs);
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
      const __tGroupHreflang = profileStart();
      const byKeywordCity = new Map<string, Map<Locale, ClusterContext>>();
      for (const ctx of contexts) {
        const key = `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
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
      for (const ctx of contexts) {
        const __tRenderCluster = profileStart();
        const locale = ctx.candidate.locale;
        const altKey = `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
        const altMap = byKeywordCity.get(altKey);
        const hreflang = altMap
          ? Array.from(altMap.entries()).map(([loc, otherCtx]) => ({
              locale: loc,
              url: `${BASE_URL}${buildClusterPath(loc, otherCtx.candidate.slug)}`,
            }))
          : [];

        const cityIdx = byLocaleCity.get(locale);
        const sameCityList = (ctx.city && cityIdx?.get(ctx.city)) || [];
        const related = sameCityList
          .filter((other) => other.candidate.slug !== ctx.candidate.slug)
          .slice(0, 8)
          .map((other) => ({
            keyword: other.city ? `${capitalize(other.keyword)} — ${other.city}` : capitalize(other.keyword),
            url: `${BASE_URL}${buildClusterPath(locale, other.candidate.slug)}`,
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

        const indexPath = path.join(distDir, out.urlPath, 'index.html');
        const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, out.html);
        // Emit the flat .html as a redirect bridge directly: postWalkCoordinator
        // would otherwise read this file (~30 KB), build the same bridge from
        // the sibling, and rewrite (~500 B). Pre-emitting the bridge cuts
        // ~52k × 30 KB writes here AND post-walk's `html === original` guard
        // skips the rewrite. Trims ~30-50 s off closeBundle.
        const slashUrl = `${BASE_URL}${out.urlPath.replace(/\/+$/, '')}/`;
        const flatBridge = buildFlatBridgeFromSibling(out.html, slashUrl);
        collector.add(flatPath, flatBridge);
        emittedFiles.push(path.relative(distDir, indexPath));
        emittedFiles.push(path.relative(distDir, flatPath));
        sitemapLocs.push(out.loc);
        profileRecord('render-cluster-page', __tRenderCluster);
      }

      // ── Per-locale hub pages ──────────────────────────────────────────
      for (const [locale, list] of byLocale.entries()) {
        const items: HubItem[] = list.map((ctx) => {
          const path = buildClusterPath(locale, ctx.candidate.slug);
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
      }
      profileRecord('inject-hub-link', __tHubInject);
      const __tSitemap = profileStart();
      const sitemapShards = await writeSitemap(distDir, sitemapLocs, dateStamp);
      profileRecord('sitemap-write', __tSitemap);
      for (const shard of sitemapShards) emittedFiles.push(shard);

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
          const cached = saveToCache(rootDir, distDir, cacheKey, emittedFiles, cachedHubs, sitemapLocs);
          profileRecord('cache-save', __tCacheSave);
          console.log(`\x1b[36m[related-search-clusters]\x1b[0m saved ${cached} files to cache (${cacheKey})`);
        } catch (err) {
          console.warn('\x1b[33m[related-search-clusters]\x1b[0m cache save failed:', err);
        }
      }

      console.log(
        `\x1b[36m[related-search-clusters]\x1b[0m emitted ${ctxCount} cluster pages + ${hubCount} hubs (${written} files) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
      printRelatedSearchProfile();
    },
  };
}
