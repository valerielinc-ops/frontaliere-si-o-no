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
  buildJobBoardCommuterFaqLd,
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

// ── Constants ───────────────────────────────────────────────────────────

// MIN_JOB_COUNT — candidate-level frequency floor (audit time).
//
// Set to 1 (no filtering) to emit a static page for every audit-captured
// candidate slug. This recovers the ~32k GSC 404 cohort from JobBoard's
// SPA `<a href>` tags that point at `/{section}/{prefix}-{slug}/` URLs
// for keywords that were previously below the cut.
//
// Why this is now safe (was a hard NO until 2026-05-07):
//   - SEQUENTIAL_PROFILE=1 is now the always-on default in deploy.yml
//     (commit 022c6e1808). Plugins no longer run concurrently in
//     closeBundle, so peak heap is bounded by the largest single
//     plugin instead of the sum of overlapping working sets. The
//     previous floor=1 attempts (a7f28ce129 → 18.7k clusters → OOM
//     exit 143; 1e41209124 → 40-min hang → cancel) were all caused
//     by parallel-mode contention, NOT by this plugin's own emit.
//   - In sequential mode, this plugin emitted 1581 pages in 19.1s on
//     the GH free-tier runner. Linear scaling to ~52k candidates
//     puts the cluster phase at ~10 min — well within the build
//     budget, and plugin-isolated so it can't poison other plugins.
//   - Per-page MIN_MATCHING_JOBS=3 quality gate (combined AND-tier +
//     OR-fill) is still enforced below — clusters that genuinely have
//     <3 listing matches are skipped, no thin content emitted.
const MIN_JOB_COUNT = 1;
const MIN_MATCHING_JOBS = 3;
const MAX_JOBS_PER_PAGE = 30;
const HUB_PAGE_SIZE = 200;

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
const CACHE_VERSION = 'v3';

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

  // The sitemap fragment carries a `<lastmod>` per URL; refresh today's date
  // so the master sitemap signals freshness even when the body is unchanged.
  const sitemapPath = path.join(distDir, 'sitemap-search-clusters.xml');
  if (fs.existsSync(sitemapPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const xml = fs.readFileSync(sitemapPath, 'utf-8')
      .replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
    fs.writeFileSync(sitemapPath, xml, 'utf-8');
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
// computed once with a full O(jobs) substring scan, then reused across every
// candidate that contains the same token. Across the candidate corpus there
// are ~13.6k unique (locale, token) pairs vs ~53k candidates × 1.9k jobs
// for the naive nested scan — a measured ~4× ceiling on the inner loop.
//
// Substring semantics are preserved exactly: each posting list contains
// jobIdx for every job whose locale-specific haystack contains `token` as a
// substring — the same `haystack.includes(token)` condition the prior
// per-candidate scan applied via queryMatchScore. Stemming is intentionally
// skipped (matches plurals/feminines via substring, like the SPA filter).
class TokenIndex {
  private haystacksByLocale = new Map<Locale, string[]>();
  private postingsByLocale = new Map<Locale, Map<string, number[]>>();
  private readonly jobs: ReadonlyArray<RawJob>;

  constructor(jobs: ReadonlyArray<RawJob>) {
    this.jobs = jobs;
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
    const list: number[] = [];
    for (let i = 0; i < haystacks.length; i++) {
      if (haystacks[i].includes(token)) list.push(i);
    }
    perLocale.set(token, list);
    return list;
  }

  /** Free the haystack + postings cache once index queries are complete. */
  clear(): void {
    this.haystacksByLocale.clear();
    this.postingsByLocale.clear();
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
  // TokenIndex and reused across every candidate that shares it — so the
  // expensive O(jobs) substring scan does NOT repeat per candidate. The
  // resulting AND/OR arrays are byte-identical to the prior naive scan:
  //   - `andMatches` ends up in corpus order (sort by jobIdx ascending),
  //   - `orMatches` ends up sorted by score desc with ties broken by
  //     corpus order (jobIdx ascending) — the same ordering produced by
  //     a stable sort over jobs[]-iteration-order entries.
  const fullScore = tokens.length;

  const scoreByIdx = new Map<number, number>();
  for (const tok of tokens) {
    const list = index.postings(candidate.locale, tok);
    for (const idx of list) scoreByIdx.set(idx, (scoreByIdx.get(idx) || 0) + 1);
  }

  const andIdx: number[] = [];
  const orEntries: { idx: number; score: number }[] = [];
  for (const [idx, score] of scoreByIdx) {
    if (score === fullScore) andIdx.push(idx);
    else orEntries.push({ idx, score });
  }
  andIdx.sort((a, b) => a - b);
  orEntries.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const matching: RawJob[] = [];
  for (const idx of andIdx) {
    if (matching.length >= MAX_JOBS_PER_PAGE) break;
    matching.push(jobs[idx]);
  }
  for (const { idx } of orEntries) {
    if (matching.length >= MAX_JOBS_PER_PAGE) break;
    matching.push(jobs[idx]);
  }

  if (matching.length < MIN_MATCHING_JOBS) return null;

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

/** Build the meta description (120-160 chars). */
function buildDescription(ctx: ClusterContext, locale: Locale): string {
  const tagline = COPY[locale].taglineSingular(ctx.matchingJobs.length, ctx.keyword, ctx.city);
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
  const sectionUrl = `${BASE_URL}${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');

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

  // FAQPage from AI-enriched data (when present).
  if (enriched?.faqs && enriched.faqs.length >= 1) {
    out.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: enriched.faqs.map((q) => ({
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: { '@type': 'Answer', text: q.answer },
      })),
    }));
  }

  // Commuter-context FAQPage: a separate JSON-LD object containing the
  // 4 frontaliere-relevant Q&A from `renderJobBoardCommuterContext`.
  // Google merges multiple FAQPage entries on the same page, so emitting
  // both alongside the AI block is safe and surfaces more rich-result
  // candidates.
  out.push(buildJobBoardCommuterFaqLd({
    locale: locale as 'it' | 'en' | 'de' | 'fr',
    location: commuterLocation,
    sectorOrType: sectorLabel,
  }));

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

/** Render a single cluster page. */
function renderClusterPage(inputs: PageInputs): PageOutput {
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
  const regionPart = ctx.city ? '' : ` ${chrome.regionH1Suffix}`;
  const headlineH1 = `${headline} — ${ctx.matchingJobs.length} ${copy.jobsHeading.toLowerCase()}${regionPart}`;

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
    ? `<p style="margin:0 0 14px;line-height:1.65">${esc(enriched.intro)}</p>`
    : renderSearchQueryIntro(
        locale as 'it' | 'en' | 'de' | 'fr',
        ctx.keyword,
        ctx.matchingJobs.length,
        ctx.topCompanies,
        topCities,
      );

  // AI-enriched FAQ block (when available). Rendered as <dl> for clarity;
  // FAQPage JSON-LD for these is emitted separately via `buildJsonLd`.
  const aiFaqHtml = enriched?.faqs && enriched.faqs.length > 0
    ? `<section style="margin:24px 0 0">
        <h3 style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 10px">${esc(copy.faqSummary)}</h3>
        ${enriched.faqs.map((q) =>
          `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px;padding:12px 14px;margin-bottom:6px"><summary style="font-weight:600;cursor:pointer;color:var(--color-heading)">${esc(q.question)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${esc(q.answer)}</p></details>`,
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
    ? `<nav aria-label="${esc(copy.relatedHeading)}" class="rsc-related" style="margin:24px 0 0;padding:18px 0;border-top:1px solid var(--color-edge)">
        <h3 style="margin:0 0 10px;font-size:18px;font-weight:700;color:var(--color-heading)">${esc(copy.relatedHeading)}</h3>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px">${related.map((r) => `<li><a href="${esc(r.url)}" style="${LINK_ACCENT_STYLE};display:inline-block;padding:4px 10px;background:var(--color-surface);border:1px solid var(--color-edge);border-radius:9999px;font-size:13px">${esc(r.keyword)}</a></li>`).join('')}</ul>
      </nav>`
    : '';

  const seoContextBlock = `<details class="cluster-seo-context" style="margin:32px 0 0;padding:0;border-top:1px solid var(--color-edge)">
    <summary style="margin-top:18px;padding:10px 14px;cursor:pointer;color:var(--color-link);font-weight:600;font-size:15px;list-style:none">${esc(chrome.contextSummary)}</summary>
    <div style="padding:8px 0 0">
      <section style="max-width:860px;margin:0;color:var(--color-body);line-height:1.65;font-size:15px">
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
  url: string;
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
      links.push(`<span style="padding:6px 10px;border-radius:8px;background:var(--color-accent);color:var(--color-on-accent);font-weight:700">${p}</span>`);
    } else {
      links.push(`<a href="${esc(url)}" style="${LINK_ACCENT_STYLE};padding:6px 10px;border-radius:8px;border:1px solid var(--color-edge);background:var(--color-surface)">${p}</a>`);
    }
  }
  return `<nav aria-label="${esc(copy.pageNavigatorLabel)}" style="display:flex;flex-wrap:wrap;gap:6px;margin:24px 0">${links.join('')}</nav>`;
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
    return `<section style="margin:0 0 22px">
      <h3 style="margin:0 0 8px;font-size:18px">${esc(city)}</h3>
      <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px">${list.map((it) => `<li><a href="${esc(it.url)}" style="${LINK_ACCENT_STYLE}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
    </section>`;
  }).join('');

  const sortedUncat = [...uncategorized].sort((a, b) => a.keyword.localeCompare(b.keyword, locale));
  const uncatBlock = sortedUncat.length > 0
    ? `<section style="margin:0 0 22px">
        <h3 style="margin:0 0 8px;font-size:18px">${esc(copy.alphabeticalLabel)}</h3>
        <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px">${sortedUncat.map((it) => `<li><a href="${esc(it.url)}" style="${LINK_ACCENT_STYLE}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
      </section>`
    : '';

  const navigator = renderPageNavigator(locale, totalPages, page);
  const sectionUrl = `${BASE_URL}${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');

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
      numberOfItems: items.length,
      itemListElement: items.slice(0, 100).map((it, i) => ({
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

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:24px 16px 56px;color:var(--color-body)">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.homeBreadcrumb)}</a>
      <span> / </span>
      <a href="${esc(sectionUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.jobsBreadcrumb)}</a>
      <span> / </span>
      <span>${esc(copy.searchBreadcrumb)}</span>
    </nav>
    <header style="margin-bottom:18px">
      <h1 style="margin:0 0 10px;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.18">${esc(copy.hubH1)}${page > 1 ? ` — ${copy.pageNavigatorLabel} ${page}` : ''}</h1>
      <p class="lede" style="margin:0;color:var(--color-body);font-size:16px;line-height:1.55;max-width:820px">${esc(copy.hubIntro(items.length))}</p>
      <p style="margin:6px 0 0;color:var(--color-subtle);font-size:13px">${esc(dateStamp)}</p>
    </header>
    ${sortedCities.length > 0 ? `<section style="margin:0 0 12px"><h2 style="margin:0 0 12px;font-size:22px">${esc(copy.citySectionLabel)}</h2>${cityBlocks}</section>` : ''}
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
      return `<details class="hub-seo-context" style="margin:32px 0 0;padding:0;border-top:1px solid var(--color-edge)">
        <summary style="margin-top:18px;padding:10px 14px;cursor:pointer;color:var(--color-link);font-weight:600;font-size:15px;list-style:none">${summary}</summary>
        <div style="padding:8px 0 0">
          <section style="max-width:860px;margin:0;color:var(--color-body);line-height:1.65;font-size:15px">
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
    hreflangHtml: '',
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

  const linkBlock = `<nav data-related-search-hub-link="1" aria-label="${esc(copy.searchBreadcrumb)}" style="max-width:1100px;margin:24px auto 0;padding:0 16px"><a href="${esc(hubUrl)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.hubH1)} →</a></nav>`;

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

async function writeSitemap(distDir: string, allLocs: ReadonlyArray<string>, dateStamp: string): Promise<void> {
  // Wait for jobsSeoPagesPlugin to flush its buffered writes (notably the
  // previousSlugs bridge HTML) before scanning dist/ HTML for canonical
  // mismatches. Vite/Rollup runs closeBundle hooks in parallel by default
  // (commit 15536b1d94 — `parallel closeBundle is now the default`), so
  // without this barrier the cluster sitemap is written while bridge files
  // are still buffered and bridge URLs whose canonical points elsewhere
  // leak into sitemap-search-clusters.xml — audit:sitemap-canonicals fails.
  await jobsSeoPagesFlushed;
  const locs = dropOverwrittenLocs(distDir, allLocs);
  if (locs.length === 0) return;
  const entries = locs.map((loc) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
  const sitemapPath = path.join(distDir, 'sitemap-search-clusters.xml');
  try {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(sitemapPath, xml, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m sitemap write failed:', err);
    return;
  }
  patchMasterSitemap(distDir, dateStamp);
}

/**
 * Register the cluster sitemap in `dist/sitemap.xml` (master sitemap index).
 * Idempotent: refreshes the lastmod when the entry already exists, otherwise
 * appends a new <sitemap> entry. Always re-runs even on cache hit because
 * `dist/sitemap.xml` is owned by another plugin and is regenerated each
 * build.
 */
function patchMasterSitemap(distDir: string, dateStamp: string): void {
  const masterPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterPath)) return;
  try {
    let idx = fs.readFileSync(masterPath, 'utf-8');
    if (idx.includes('sitemap-search-clusters.xml')) {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-search-clusters\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    } else {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-search-clusters.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    }
    fs.writeFileSync(masterPath, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to patch master sitemap:', err);
  }
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
      const cacheKey = cacheEnabled ? computeCacheKey(rootDir) : '';
      if (cacheEnabled) {
        const restored = await tryRestoreFromCache(rootDir, distDir, cacheKey);
        if (restored) {
          // Re-run the cross-plugin patches against THIS build's dist.
          for (const { locale, url } of restored.hubs) {
            injectHubLinkIntoSectionLanding(distDir, locale, url, COPY[locale]);
          }
          patchMasterSitemap(distDir, dateStamp);
          console.log(
            `\x1b[36m[related-search-clusters]\x1b[0m cache HIT (key=${cacheKey}): ${restored.emittedCount} files restored in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          );
          return;
        }
        console.log(`\x1b[36m[related-search-clusters]\x1b[0m cache MISS (key=${cacheKey}): full emit`);
      }

      const candidates = filterAndDedupeCandidates(loadCandidates(rootDir));
      if (candidates.length === 0) {
        console.log('\x1b[36m[related-search-clusters]\x1b[0m 0 candidates after filtering — nothing to emit');
        return;
      }
      const enriched = loadEnriched(rootDir);
      const jobs = loadJobs(rootDir);
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
      for (const cand of candidates) {
        const ctx = buildClusterContext(cand, tokenIndex, jobs);
        if (ctx) contexts.push(ctx);
      }
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${contexts.length} clusters survived match-≥${MIN_MATCHING_JOBS} filter`);
      tokenIndex.clear(); // GC haystacks + posting lists before the render/emit loop runs

      if (contexts.length === 0) return;

      // Group by (normalized keyword + city) for cross-locale hreflang lookup.
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

      // Group by locale + city for related-link suggestions.
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

      const collector = new WriteCollector({ distDir, pluginName: 'relatedSearchClustersPlugin' });
      const sitemapLocs: string[] = [];
      const emittedFiles: string[] = []; // dist-relative paths for cache save
      const cachedHubs: { locale: Locale; url: string }[] = [];

      // ── Per-cluster pages ─────────────────────────────────────────────
      for (const ctx of contexts) {
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
      }

      // ── Per-locale hub pages ──────────────────────────────────────────
      for (const [locale, list] of byLocale.entries()) {
        const items: HubItem[] = list.map((ctx) => ({
          keyword: ctx.keyword,
          city: ctx.city,
          slug: ctx.candidate.slug,
          url: `${BASE_URL}${buildClusterPath(locale, ctx.candidate.slug)}`,
        }));
        const totalPages = Math.max(1, Math.ceil(items.length / HUB_PAGE_SIZE));

        for (let page = 1; page <= totalPages; page++) {
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
          collector.add(flatPath, out.html);
          emittedFiles.push(path.relative(distDir, indexPath));
          emittedFiles.push(path.relative(distDir, flatPath));
          sitemapLocs.push(out.loc);
        }

        const hubUrl = `${BASE_URL}${buildHubPath(locale, 1)}`;
        cachedHubs.push({ locale, url: hubUrl });
        injectHubLinkIntoSectionLanding(distDir, locale, hubUrl, COPY[locale]);
      }

      const written = await collector.flush();
      await writeSitemap(distDir, sitemapLocs, dateStamp);
      emittedFiles.push('sitemap-search-clusters.xml');

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
          const cached = saveToCache(rootDir, distDir, cacheKey, emittedFiles, cachedHubs, sitemapLocs);
          console.log(`\x1b[36m[related-search-clusters]\x1b[0m saved ${cached} files to cache (${cacheKey})`);
        } catch (err) {
          console.warn('\x1b[33m[related-search-clusters]\x1b[0m cache save failed:', err);
        }
      }

      console.log(
        `\x1b[36m[related-search-clusters]\x1b[0m emitted ${ctxCount} cluster pages + ${hubCount} hubs (${written} files) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    },
  };
}
