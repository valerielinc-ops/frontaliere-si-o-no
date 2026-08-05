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
//     - gsc.pages[path]                    → every URL Google showed ≥1 time
//                                            (page dimension, ~52k paths) —
//                                            the comprehensive page-level
//                                            impression signal (Buco G)
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
//        URL ∈ ga4.pages ∪ topLandingPages ∪ gsc.pages ∪ posthog.pages
//             ∪ indexed-cluster ∪ gsc-job-urls ∪ orphan-slugs
//             ∪ orphan-enriched ∪ promotions.urls
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
import { readOrphanEnriched } from '../../scripts/lib/orphan-enriched-store.mjs';

export type UrlClass =
  | 'previousSlug'
  | 'soft-landing-expired'
  | 'cluster'
  | string;

export type FilterAction = 'full' | 'thin' | 'skip';

export interface FilterDecision {
  action: FilterAction;
  reason?: string;
  /**
   * True when the URL falls in the *inert band*: no traffic evidence in ANY
   * source, and the URL has been discoverable for at least
   * `noindexMinAgeDays` — long enough that "zero impressions" is a statement
   * about the URL rather than about how recently it was published.
   *
   * Orthogonal to `action`. `action` decides how much HTML the page gets;
   * `noindex` decides whether Google is invited to rank it.
   *
   * OPT-IN, unlike `action`: a caller that ignores this field keeps the
   * pre-#5168 behaviour exactly. That asymmetry is deliberate. `urlClass`
   * `gsc-keyword-landing` is shared by four emit sites across two plugins,
   * and only `relatedSearchClustersPlugin` advertises its URLs in
   * sitemap-search-clusters -- the surface the band was measured on. The
   * three sites in `jobsSeoPagesPlugin` advertise theirs in sitemap-jobs,
   * where the same URL shape measures 29 % impressed rather than 2 %, so they
   * read `action` and skip this. Each of them says so in place; grep #5168.
   */
  noindex?: boolean;
  /** Why `noindex` is true — surfaces in build logs, mirrors `reason`. */
  noindexReason?: string;
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
  /**
   * Age gate for the *inert band* (issue #5168). When set, a URL that has no
   * traffic evidence in any source AND whose `data/url-first-seen.json`
   * timestamp is at least this many days old is additionally reported as
   * `noindex` by {@link TrafficEvidenceFilter.decideMulti}.
   *
   * THIS IS THE SINGLE KNOB that sizes the band. Measured against the live
   * cluster surface on 2026-08-05 (292 795 canonical URLs in
   * `sitemap-search-clusters-001…008`, 279 658 of them with zero traffic
   * evidence anywhere):
   *
   *   absent / negative →       0 URLs  (feature off, pre-#5168 behaviour)
   *   90               → 137 935 URLs
   *   60               → 155 867 URLs
   *   30               → 279 658 URLs  (the whole zero-evidence tier)
   *
   * Widening or reverting the band is a one-number edit in
   * `data/url-pruning-approved-patterns.json` -- no code change, no
   * regenerated URLs, no 404s, and the next build restores `index,follow`
   * because the directive is recomputed from scratch every time.
   *
   * Deliberately SEPARATE from (and normally much larger than) `minAgeDays`:
   * `minAgeDays` protects a fresh URL from being served *thin*, which is
   * cheap to get wrong. This one protects a fresh URL from being dropped
   * out of the index on the strength of a 90-day impressions window it has
   * not been alive long enough to have taken part in -- which is the
   * expensive mistake. A URL missing from `url-first-seen.json` is never
   * noindexed: the band requires positive proof of age, not absence of
   * proof of youth.
   */
  noindexMinAgeDays?: number;
}

interface ApprovedConfig {
  version: number;
  patterns: ApprovedPattern[];
}

interface EvidenceIndex {
  gsc?: {
    queries?: Record<string, { topLandingPage?: string }>;
    /**
     * Full page-level impression set: every URL Google showed ≥1 time in
     * the window (page dimension), keyed by path → impression count.
     * Populated by scripts/lib/evidence/gscFetcher.mjs Pass 3. Far broader
     * than `queries[].topLandingPage` (which only surfaces ~one page per
     * query); without it the long tail of impressed pages is invisible to
     * the has-traffic gate and risks being thinned despite Google interest.
     */
    pages?: Record<string, number>;
  };
  ga4?: {
    pages?: Record<string, { sessions?: number }>;
  };
  posthog?: {
    pages?: Record<string, { pageviews?: number }>;
  };
}

export interface DecideOptions {
  /**
   * The URL whose HTML is actually being emitted, when `urlPaths` also
   * carries evidence-only probes (mirrors, cross-locale variants). Used for
   * the inert-band age gate. Defaults to `urlPaths[0]`.
   */
  readonly primaryPath?: string;
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
  private decisionsNoindex = 0;

  private readonly firstSeen: Map<string, number>;

  constructor(rootDir: string) {
    const evidencePath = path.join(rootDir, 'data', 'evidence-index.json');
    const promotionsPath = path.join(rootDir, 'data', 'thin-page-promotions-active.json');
    const approvedPath = path.join(rootDir, 'data', 'url-pruning-approved-patterns.json');
    const indexedClusterPath = path.join(rootDir, 'data', 'indexed-cluster-urls.json');
    const gscJobUrlsPath = path.join(rootDir, 'data', 'gsc-job-urls.json');
    const gscOrphanSlugsPath = path.join(rootDir, 'data', 'gsc-orphan-job-slugs.json');
    const firstSeenPath = path.join(rootDir, 'data', 'url-first-seen.json');

    // Build a single normalized "has traffic" set from every signal source.
    const trafficSet = new Set<string>();
    let evGa4 = 0, evPosthog = 0, evGscTop = 0, evGscPages = 0, evIndexed = 0, evGscJobs = 0,
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
      // Buco G: full GSC page-level impression set. The single largest
      // traffic source — every URL Google showed ≥1 time (page dimension),
      // ~52 k paths vs the ~9 k surfaced via `topLandingPage`. Closes the
      // gap where long-tail impressed pages were invisible to the has-
      // traffic gate and risked being thinned despite confirmed Google
      // interest. Populated by gscFetcher Pass 3.
      for (const p of Object.keys(ev.gsc?.pages ?? {})) addToSet(p, () => evGscPages++);
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
    // job slugs) and the sharded enriched-orphan ledger (records of
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
    const orphanEnriched = readOrphanEnriched(rootDir);
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
        `gsc-pages=${evGscPages} indexed-cluster=${evIndexed} gsc-jobs=${evGscJobs} ` +
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
  decideMulti(
    urlPaths: readonly string[],
    urlClass: UrlClass,
    opts?: DecideOptions,
  ): FilterDecision {
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

    // ── Inert band (issue #5168) ────────────────────────────────────────
    // Reaching this line already means: not one of the candidate paths
    // appears in ANY traffic source (GSC page impressions, GSC top landing
    // pages, GA4 sessions, PostHog pageviews, the indexed-cluster union, the
    // GSC job/orphan sets, or the hourly thin-page promotions), and the
    // action-level grace window has expired. The only thing left to
    // establish before revoking indexation is that the URL has been
    // DISCOVERABLE long enough for that silence to mean something.
    const noindexMinAgeDays = pattern.noindexMinAgeDays ?? -1;
    if (noindexMinAgeDays >= 0) {
      // Age is read from the PRIMARY path -- the URL that actually carries
      // the `<meta name="robots">` we are about to rewrite and that sits in
      // the sitemap. The other entries in `urlPaths` are evidence probes:
      // canton mirrors and cross-locale variants that legitimately went live
      // at other times, so borrowing their age to judge this URL would be a
      // category error in the one direction we cannot afford.
      const primary = normalizePath(opts?.primaryPath ?? urlPaths[0] ?? '');
      const seenAt = primary ? this.firstSeen.get(primary) : undefined;
      // Positive proof of age only. A URL absent from url-first-seen.json is
      // of UNKNOWN age, and unknown must not read as old: the file is
      // populated lazily by scripts/refresh-url-first-seen.mjs, so "absent"
      // is far more likely to mean "the stamper has not caught up" than "this
      // URL predates everything". The action-level grace window deliberately
      // treats absence the other way (absent → no grace) because being wrong
      // there costs a thinner page; being wrong here costs an indexed page.
      if (seenAt !== undefined && seenAt <= Date.now() - noindexMinAgeDays * 86_400_000) {
        this.decisionsNoindex++;
        return {
          action: pattern.action,
          reason: pattern.id,
          noindex: true,
          noindexReason: `inert-${noindexMinAgeDays}d`,
        };
      }
    }
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
      `thin=${this.decisionsThin} skip=${this.decisionsSkip} ` +
      `noindex=${this.decisionsNoindex}`
    );
  }
}

let _singleton: TrafficEvidenceFilter | null = null;

export function getTrafficEvidenceFilter(rootDir: string): TrafficEvidenceFilter {
  if (!_singleton) _singleton = new TrafficEvidenceFilter(rootDir);
  return _singleton;
}

export function _resetForTests(): void { _singleton = null; }
