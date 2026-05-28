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
//     - posthog.pages[path].pageviews      → (currently empty in production,
//                                            kept here so a future fix to
//                                            scripts/build-evidence-index.mjs
//                                            picks it up automatically)
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
  /** Reserved for future use. Currently ignored — evidence absence is the gate. */
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

  constructor(rootDir: string) {
    const evidencePath = path.join(rootDir, 'data', 'evidence-index.json');
    const promotionsPath = path.join(rootDir, 'data', 'thin-page-promotions-active.json');
    const approvedPath = path.join(rootDir, 'data', 'url-pruning-approved-patterns.json');

    // Build a single normalized "has traffic" set from every signal source.
    const trafficSet = new Set<string>();
    const ev = tryRead<EvidenceIndex>(evidencePath);
    if (ev) {
      for (const path of Object.keys(ev.ga4?.pages ?? {})) {
        trafficSet.add(normalizePath(path));
      }
      for (const path of Object.keys(ev.posthog?.pages ?? {})) {
        trafficSet.add(normalizePath(path));
      }
      for (const q of Object.values(ev.gsc?.queries ?? {})) {
        if (q?.topLandingPage) trafficSet.add(normalizePath(q.topLandingPage));
      }
    }
    const promo = tryRead<ThinPromotions>(promotionsPath);
    if (promo?.urls) {
      for (const u of promo.urls) trafficSet.add(normalizePath(u));
    }
    this.trafficSet = trafficSet;

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
        `[traffic-evidence-filter] traffic-set=${trafficSet.size} paths, ${patternCount} approved patterns`
      );
    } else {
      console.log(
        `[traffic-evidence-filter] dormant (traffic-set=${trafficSet.size}, ` +
        `patterns=${approved?.patterns?.length ?? 0}) — all emits proceed as 'full'`
      );
    }
  }

  decide(urlPath: string, urlClass: UrlClass): FilterDecision {
    if (!this.active) {
      this.decisionsFull++;
      return { action: 'full', reason: 'filter-dormant' };
    }
    const patterns = this.patternsByClass.get(urlClass);
    if (!patterns || patterns.length === 0) {
      this.decisionsFull++;
      return { action: 'full', reason: 'no-pattern' };
    }
    const norm = normalizePath(urlPath);
    if (this.trafficSet.has(norm)) {
      this.decisionsFull++;
      return { action: 'full', reason: 'has-traffic' };
    }
    // URL has zero traffic AND matches a pattern. First pattern wins.
    const pattern = patterns[0];
    if (pattern.action === 'thin') this.decisionsThin++;
    else if (pattern.action === 'skip') this.decisionsSkip++;
    return { action: pattern.action, reason: pattern.id };
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
