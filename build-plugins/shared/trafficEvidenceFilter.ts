// trafficEvidenceFilter.ts
//
// Build-time filter that decides whether to emit each URL as a FULL page
// (current behavior, large) or as a THIN shell (≥50 words static + SPA
// hydration, ~70% smaller). Drives the artifact-shrink Fase 1 pipeline.
//
// Inputs (read once at build start, defaults to "full" on any missing input):
//
//   data/evidence-index.json
//     - gsc.queries[query].topLandingPage  → URLs that own a search query
//     - ga4.pages[path].sessions           → URLs with ≥3 sessions in 90d
//     - posthog.pages[path]                → either newsletterSignups OR
//                                            pageviews (or both); key
//                                            presence alone qualifies as
//                                            "has traffic"
//
//   data/thin-page-promotions-active.json
//     - { urls: [path, ...], generatedAt }
//     - Self-healing feedback: a URL that fired `thin_page_view` from a
//       JS-enabled client in the last 30 days (refreshed hourly by
//       .github/workflows/refresh-thin-promotions.yml).
//
//   data/url-pruning-approved-patterns.json
//     - { patterns: [ { urlClass, action, minAgeDays?, ... } ] }
//     - Empty array = filter is dormant (every emit is 'full'). User-curated.
//
// Semantics
//
//   For a candidate URL (path, urlClass):
//     1. Find approved pattern matching urlClass.
//        No pattern → 'full'.
//     2. Check evidence:
//        URL ∈ ga4.pages ∪ topLandingPages ∪ posthog.pages ∪ promotions.urls
//        → 'full' (URL has real traffic, keep current full HTML).
//     3. URL ∉ evidence + pattern says action='thin' → 'thin'.
//     4. (Future: action='skip' for tier 3.)
//
// Self-healing
//
//   A thin page that gets a click fires window.__THIN_SHELL__-triggered
//   `thin_page_view` events on PostHog + Firebase Analytics (App.tsx mount
//   effect). The hourly workflow lifts that URL into
//   thin-page-promotions-active.json. Next build, the filter returns 'full'
//   for it. Latency: ≤1h refresh + ≤24h deploy = ≤25h to self-correct.

import fs from 'node:fs';
import path from 'node:path';

export type UrlClass =
  | 'previousSlug'
  | 'soft-landing-expired'
  | 'cluster'
  | string;

export type FilterAction = 'full' | 'thin' | 'skip';

export interface FilterDecision {
  action: FilterAction;
  reason?: string;
}

interface ApprovedPattern {
  id: string;
  urlClass: UrlClass;
  action: Exclude<FilterAction, 'full'>;
  /**
   * Grace window in days from `data/url-first-seen.json[path]`. When set
   * and the URL's first-seen timestamp is within `minAgeDays` of now,
   * decideMulti returns `full` with reason `grace`. Protects freshly-
   * emitted URLs from being indexed thin before evidence has had time
   * to accumulate.
   */
  minAgeDays?: number;
}

interface ApprovedConfig {
  version: number;
  patterns: ApprovedPattern[];
}

interface EvidenceIndex {
  gsc?: {
    queries?: Record<string, { topLandingPage?: string }>;
  };
  ga4?: {
    pages?: Record<string, { sessions?: number }>;
  };
  posthog?: {
    pages?: Record<string, { pageviews?: number }>;
  };
}

interface ThinPromotions {
  generatedAt?: string;
  urls?: string[];
}

function normalizePath(p: string): string {
  if (!p) return '';
  let s = p;
  // Strip protocol + host (some traffic-source files store absolute URLs
  // with or without `www`, e.g. `gsc-job-urls.json`). Everything we
  // store in the traffic set is path-only so the comparison is
  // host-agnostic.
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function tryRead<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[traffic-evidence-filter] could not read ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

export class TrafficEvidenceFilter {
  private readonly trafficSet: Set<string>;
  private readonly patternsByClass: Map<UrlClass, ApprovedPattern[]>;
  private readonly active: boolean;

  private decisionsFull = 0;
  private decisionsThin = 0;
  private decisionsSkip = 0;

  private readonly firstSeen: Map<string, number>;

  constructor(rootDir: string) {
    const evidencePath = path.join(rootDir, 'data', 'evidence-index.json');
    const promotionsPath = path.join(rootDir, 'data', 'thin-page-promotions-active.json');
    const approvedPath = path.join(rootDir, 'data', 'url-pruning-approved-patterns.json');
    const indexedClusterPath = path.join(rootDir, 'data', 'indexed-cluster-urls.json');
    const gscJobUrlsPath = path.join(rootDir, 'data', 'gsc-job-urls.json');
    const gscOrphanSlugsPath = path.join(rootDir, 'data', 'gsc-orphan-job-slugs.json');
    const orphanEnrichedPath = path.join(rootDir, 'data', 'orphan-enriched-data.json');
    const firstSeenPath = path.join(rootDir, 'data', 'url-first-seen.json');

    // Build a single normalized "has traffic" set from every signal source.
    const trafficSet = new Set<string>();
    let evGa4 = 0, evPosthog = 0, evGscTop = 0, evIndexed = 0, evGscJobs = 0,
        evOrphanSlugs = 0, evOrphanEnriched = 0, evPromo = 0;
    const addToSet = (raw: string | null | undefined, counter: () => void): void => {
      if (!raw) return;
      const norm = normalizePath(raw);
      if (!norm) return; // skip malformed inputs that normalize to ''
      if (!trafficSet.has(norm)) counter();
      trafficSet.add(norm);
    };
    const ev = tryRead<EvidenceIndex>(evidencePath);
    if (ev) {
      for (const p of Object.keys(ev.ga4?.pages ?? {})) addToSet(p, () => evGa4++);
      for (const p of Object.keys(ev.posthog?.pages ?? {})) addToSet(p, () => evPosthog++);
      for (const q of Object.values(ev.gsc?.queries ?? {})) {
        if (q?.topLandingPage) addToSet(q.topLandingPage, () => evGscTop++);
      }
    }
    // PR #743 follow-up: `data/indexed-cluster-urls.json` is the merged
    // GSC + GA4 + PostHog union of cluster URLs Google has indexed in
    // the last 90 d, populated by .github/workflows/refresh-indexed-
    // cluster-urls.yml. It carries ~4.9 k URLs vs the ~300 cluster
    // URLs that surface as GSC `topLandingPage` in evidence-index.json
    // (which thresholds at min 5 impressions and keeps only the
    // top-1 landing per query). Without this source the cluster
    // filter false-thinned ~all cluster pages that rank #2+ for any
    // query — the cluster's own `indexedClusterUrlsByKey` lookup uses
    // the same file for mirror promotion, so the data is already
    // production-trusted.
    const indexedCluster = tryRead<{ indexedPaths?: string[] }>(indexedClusterPath);
    if (Array.isArray(indexedCluster?.indexedPaths)) {
      for (const p of indexedCluster.indexedPaths) addToSet(p, () => evIndexed++);
    }
    // PR #746 follow-up: `data/gsc-job-urls.json` is the job-page analog
    // of indexed-cluster-urls.json — a flat array of full URLs (with or
    // without `www`) that GSC has seen for active or expired job-detail
    // pages. ~2 k entries on 2026-05-28. Without this, bridge +
    // soft-landing filtering false-negatives on slugs that still get
    // GSC impressions despite not being top-1 for any query.
    const gscJobUrls = tryRead<unknown>(gscJobUrlsPath);
    if (Array.isArray(gscJobUrls)) {
      for (const u of gscJobUrls) {
        if (typeof u === 'string') addToSet(u, () => evGscJobs++);
      }
    }
    // Reviewer MEDIUM #5: `data/gsc-orphan-job-slugs.json` (array of IT
    // job slugs) and `data/orphan-enriched-data.json` (array of
    // {locale, slug, path, queries[]}) are produced by the GSC orphan-
    // discovery pipeline. Each entry represents a URL Google has
    // already indexed (with at least one impression or click) but
    // that's not in our active inventory. The soft-landing path is
    // emitted for these slugs, so they MUST be in trafficSet — otherwise
    // pattern `zero-traffic-soft-landing-expired` thins them despite
    // confirmed Google interest.
    const gscOrphanSlugs = tryRead<unknown>(gscOrphanSlugsPath);
    if (Array.isArray(gscOrphanSlugs)) {
      for (const slug of gscOrphanSlugs) {
        if (typeof slug !== 'string' || !slug) continue;
        // Construct the IT canton-aware URL the soft-landing emits at.
        // Non-IT locale variants are added by the cross-locale candidate
        // sweep at the plugin's decideMulti call site.
        addToSet(`/cerca-lavoro-ticino/${slug}/`, () => evOrphanSlugs++);
      }
    }
    const orphanEnriched = tryRead<unknown>(orphanEnrichedPath);
    if (Array.isArray(orphanEnriched)) {
      for (const entry of orphanEnriched) {
        if (!entry || typeof entry !== 'object') continue;
        const p = (entry as { path?: unknown }).path;
        if (typeof p === 'string') addToSet(p, () => evOrphanEnriched++);
      }
    }
    const promo = tryRead<ThinPromotions>(promotionsPath);
    if (promo?.urls) {
      for (const u of promo.urls) addToSet(u, () => evPromo++);
    }
    this.trafficSet = trafficSet;

    // Reviewer HIGH #3: minAgeDays grace window for freshly-emitted
    // URLs. `data/url-first-seen.json` is a flat `{ path: ISO-date }`
    // map populated by `scripts/refresh-url-first-seen.mjs` (run from
    // the deploy workflow after build). When a URL first appears in
    // sitemap-jobs.xml or sitemap-search-clusters-*.xml the script
    // stamps it with today's date. Each pattern's `minAgeDays` is
    // checked against this map: URL's age < minAgeDays → return `full`
    // with reason `grace`. Missing file → grace check is a no-op
    // (filter behaves as before — safe default until the workflow runs).
    const firstSeenRaw = tryRead<Record<string, string>>(firstSeenPath) || {};
    const firstSeen = new Map<string, number>();
    for (const [k, v] of Object.entries(firstSeenRaw)) {
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) firstSeen.set(normalizePath(k), ts);
    }
    this.firstSeen = firstSeen;

    const approved = tryRead<ApprovedConfig>(approvedPath);
    this.patternsByClass = new Map();
    if (approved && Array.isArray(approved.patterns)) {
      for (const p of approved.patterns) {
        if (!p?.urlClass || !p.action) continue;
        const arr = this.patternsByClass.get(p.urlClass) ?? [];
        arr.push(p);
        this.patternsByClass.set(p.urlClass, arr);
      }
    }
    this.active = trafficSet.size > 0 && this.patternsByClass.size > 0;

    if (this.active) {
      const patternCount = approved?.patterns?.length ?? 0;
      console.log(
        `[traffic-evidence-filter] traffic-set=${trafficSet.size} paths, ${patternCount} approved patterns, ` +
        `${firstSeen.size} first-seen timestamps ` +
        `(sources: ga4=${evGa4} posthog=${evPosthog} gsc-top=${evGscTop} ` +
        `indexed-cluster=${evIndexed} gsc-jobs=${evGscJobs} ` +
        `orphan-slugs=${evOrphanSlugs} orphan-enriched=${evOrphanEnriched} ` +
        `promotions=${evPromo})`
      );
    } else {
      console.log(
        `[traffic-evidence-filter] dormant (traffic-set=${trafficSet.size}, ` +
        `patterns=${approved?.patterns?.length ?? 0}) — all emits proceed as 'full'`
      );
    }
  }

  decide(urlPath: string, urlClass: UrlClass): FilterDecision {
    return this.decideMulti([urlPath], urlClass);
  }

  /**
   * Multi-path variant: when a single piece of content is emitted at
   * multiple URLs (canonical + locale mirrors + legacy-canton mirrors),
   * traffic may land at ANY of them — typically the historically-
   * indexed mirror, not the freshly-promoted canonical. Check every
   * candidate path against the traffic-set; if ANY matches we keep the
   * content full.
   *
   * Critical for relatedSearchClustersPlugin: cluster pages
   * canonicalize to `/cerca-lavoro-svizzera/ricerca-X/` but GSC + GA4
   * see traffic at the legacy `/cerca-lavoro-ticino/ricerca-X/`
   * mirrors. A `decide(canonical, …)` call alone would falsely report
   * zero traffic for ~all clusters.
   */
  decideMulti(urlPaths: readonly string[], urlClass: UrlClass): FilterDecision {
    if (!this.active) {
      this.decisionsFull++;
      return { action: 'full', reason: 'filter-dormant' };
    }
    const patterns = this.patternsByClass.get(urlClass);
    if (!patterns || patterns.length === 0) {
      this.decisionsFull++;
      return { action: 'full', reason: 'no-pattern' };
    }
    for (const p of urlPaths) {
      if (this.trafficSet.has(normalizePath(p))) {
        this.decisionsFull++;
        return { action: 'full', reason: 'has-traffic' };
      }
    }
    // No path in the candidate set has traffic. Apply grace window
    // before falling through to the pattern action. Reviewer HIGH #3:
    // freshly-emitted URLs (no evidence yet) get thinned and indexed
    // thin before evidence has time to accumulate. minAgeDays protects
    // against that — when the URL's first-seen timestamp is within the
    // grace window, override to `full`.
    const pattern = patterns[0];
    const minAgeDays = pattern.minAgeDays ?? 0;
    if (minAgeDays > 0 && this.firstSeen.size > 0) {
      const cutoffMs = Date.now() - minAgeDays * 86_400_000;
      for (const p of urlPaths) {
        const seenAt = this.firstSeen.get(normalizePath(p));
        // URL absent from url-first-seen.json → behave as `cutoff − ε`
        // (no grace). The refresh script adds entries lazily; without
        // it the file may be empty and grace is a no-op. Safer than
        // assuming brand-new URLs (which would over-protect everything
        // on a fresh-checkout build).
        if (seenAt !== undefined && seenAt > cutoffMs) {
          this.decisionsFull++;
          return { action: 'full', reason: 'grace' };
        }
      }
    }
    if (pattern.action === 'thin') this.decisionsThin++;
    else if (pattern.action === 'skip') this.decisionsSkip++;
    return { action: pattern.action, reason: pattern.id };
  }

  /**
   * Direct traffic-set lookup. Returns true iff the URL appears in the
   * merged GSC topLandingPage / GA4 sessions / PostHog pages / hourly
   * thin-page-promotions set. Use only for diagnostic/audit code —
   * production plugins should call `decide()` or `decideMulti()` to
   * get a complete tier decision (pattern matching + grace windows
   * once implemented).
   */
  hasTraffic(urlPath: string): boolean {
    return this.trafficSet.has(normalizePath(urlPath));
  }

  summary(): string {
    if (!this.active) {
      return `[traffic-evidence-filter] dormant — no decisions taken`;
    }
    return (
      `[traffic-evidence-filter] full=${this.decisionsFull} ` +
      `thin=${this.decisionsThin} skip=${this.decisionsSkip}`
    );
  }
}

let _singleton: TrafficEvidenceFilter | null = null;

export function getTrafficEvidenceFilter(rootDir: string): TrafficEvidenceFilter {
  if (!_singleton) _singleton = new TrafficEvidenceFilter(rootDir);
  return _singleton;
}

export function _resetForTests(): void { _singleton = null; }
