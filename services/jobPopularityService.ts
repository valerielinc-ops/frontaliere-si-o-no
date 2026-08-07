// jobPopularityService.ts
//
// Runtime loader for the {slug: viewCount} job-popularity map that powers the
// JobBoard "trending" strip (services/personalizationScoring.ts
// getTrendingByLocation → components/community/TrendingSection.tsx).
//
// WHY THIS EXISTS — issue #5001, /cerca-lavoro-ticino/ measured perf 0.03 on
// mobile (LHCI run 31177021266, the worst template on the site).
// components/community/JobBoard.tsx used to `import popularityData from
// '@/data/job-popularity.json'`. A static JSON import is inlined by Rollup into
// the importing chunk, so the map shipped INSIDE assets/JobBoard.js. Measured
// on production 2026-08-07:
//
//   assets/JobBoard.js            4,103,109 B raw / 811,767 B transferred
//   └─ inlined popularity map     3,598,764 B raw  (88% of the chunk)
//      48,890 entries, of which 31,878 have exactly 1 view
//
// and build-plugins/staticPagesPlugin.ts maps that page's section slug to the
// JobBoard chunk (sectionChunks), so it emits a `modulepreload` for it in the
// static shell — i.e. the browser fetches all 812 KB at HIGH priority, before
// anything the page paints with. The map's entire job is to rank a 4-card strip
// that renders below the fold and only when 3+ matches exist.
//
// Fetching it instead keeps the data byte-identical (the file is copied to
// dist/data/ by build-plugins/adminDataPlugin.ts, then served from the CDN by
// the deploy's `cp -r dist/data` + offload) and moves it off the critical path.
//
// FAIL-SOFT: every failure path resolves to `{}`. getTrendingByLocation()
// returns [] for an empty map and TrendingSection only renders at 3+ jobs, so a
// CDN miss degrades to "no trending strip", never to a broken board. A failed
// load is NOT cached, so a later mount retries.
//
// FRESHNESS: the map changes only when refresh-job-popularity.yml commits it,
// i.e. only via a deploy — so it needs no cdnFreshUrl() rotation (that helper is
// for files a publisher rewrites BETWEEN deploys).

import { cdnDataUrl } from './cdnDataBase';

/** Same-origin path; cdnDataUrl() resolves it to the CDN when offloaded. */
export const JOB_POPULARITY_DATA_URL = '/data/job-popularity.json';

/** Stable identity for "not loaded yet" — reused so React memo deps don't churn. */
export const EMPTY_JOB_POPULARITY: Record<string, number> = Object.freeze({});

let cached: Record<string, number> | null = null;
let inFlight: Promise<Record<string, number>> | null = null;

/**
 * Load the popularity map. Cached after the first successful load; concurrent
 * callers share one request. Never throws.
 */
export async function loadJobPopularity(): Promise<Record<string, number>> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<Record<string, number>> => {
    try {
      const res = await fetch(cdnDataUrl(JOB_POPULARITY_DATA_URL));
      if (!res.ok) return {};
      const data: unknown = await res.json();
      // Guard the shape: a 200 serving an HTML error page (or the array shape of
      // a different data file) must not be handed to the scorer as a map.
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      cached = data as Record<string, number>;
      return cached;
    } catch {
      return {};
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test-only: drop the module-level cache between cases. */
export function __resetJobPopularityCache(): void {
  cached = null;
  inFlight = null;
}
