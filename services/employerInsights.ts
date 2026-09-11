/**
 * employerInsights — typed data contract + HTTP client for the per-company
 * "wow" traffic report (cold-outreach insights centrepiece).
 *
 * The data lives in Firestore `employer_insights/{companyKey}` and is served
 * through a Cloud Function (token-gated, per-company). This module is the SPA
 * boundary: `EmployerInsightsPage` imports `fetchInsights` and the types from
 * here, so the page never talks to Firestore/HTTP directly.
 *
 * The Cloud Function owns token validation and the Firestore read; this module
 * keeps that transport boundary stable for the page.
 */

import { FUNCTIONS_BASE } from './functionsBase';

export interface EmployerInsightsWindow {
  from: string;
  to: string;
  timezone?: string;
  kind?: string;
  inclusive?: string;
}

/** A single ad row for the employer. */
export interface EmployerAd {
  jobId?: string;
  slug: string;
  title: string;
  path: string;
  views: number;
  visitors: number;
  applyClicks: number;
  /** Provider-observed user units associated with apply clicks; not a global unique union. */
  applyClickUsers?: number | null;
  applications: number | null;
  applicationsStatus?: string;
  eventsObserved?: number;
  eventTypes?: Record<string, number>;
  forwardedAt?: string | null;
  delivery?: string | null;
  trend?: { week: string; views: number }[];
}

/** Aggregate totals across all of the company's ads for the report window. */
export interface EmployerInsightsTotals {
  views: number;
  visitors: number;
  profileViews?: number | null;
  profileVisitors?: number | null;
  applyClicks?: number | null;
  /** Provider-observed user units associated with apply clicks; never PII or a global unique count. */
  applyClickUsers?: number | null;
  applications?: number | null;
  applicationsStatus?: string;
  adsCount: number;
  forwardedAt?: string | null;
  delivery?: string | null;
}

export interface EmployerApplicationsCoverage {
  source?: string | null;
  status?: string;
  available?: boolean;
  observed?: number;
  attributed?: number;
  residuals?: Record<string, number>;
  residualTotal?: number;
  technicalDuplicatesRemoved?: number;
  retentionDays?: number;
  window?: EmployerInsightsWindow | null;
  invariant?: boolean;
}

/**
 * Event-coverage block written by scripts/build-employer-insights.mjs. Only the
 * fields the report reads are typed; the builder writes more (residual ledger,
 * identity resolution) and the endpoint forwards the document whole.
 */
export interface EmployerEventsCoverage {
  source?: string | null;
  status?: string;
  /**
   * Whether the observed counts are provably free of technical duplicates.
   * `status: 'available'` is the only value that proves it; anything else —
   * including an absent block on a pre-ledger payload — leaves the counts
   * observed but not proven unique.
   */
  deduplication?: {
    key?: string;
    status?: string;
    unavailableCount?: number;
  };
  [key: string]: unknown;
}

export interface EmployerInsightsWindowSummary {
  window: EmployerInsightsWindow;
  totals: EmployerInsightsTotals;
  trend: { week: string; views: number }[];
  coverage?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

/** The full per-company report payload. */
export interface EmployerInsights {
  schemaVersion?: number;
  companyKey: string;
  companyName: string;
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  source?: string | null;
  window?: EmployerInsightsWindow | null;
  totals: EmployerInsightsTotals;
  topAd: { slug: string; title: string; views: number } | null;
  /** Sorted by views desc. */
  ads: EmployerAd[];
  /** Weekly buckets, oldest → newest. */
  trend: { week: string; views: number }[];
  profileTrend?: { week: string; views: number }[];
  coverage?: EmployerEventsCoverage;
  applicationsCoverage?: EmployerApplicationsCoverage;
  provenance?: {
    source?: string | null;
    window?: EmployerInsightsWindow | null;
    [key: string]: unknown;
  };
  additionalWindows?: Record<string, EmployerInsightsWindowSummary>;
}

/**
 * Outcome of a fetch. The page renders one of: loading | ok | not-found | error.
 * - `ok`        → data present, render the report.
 * - `not-found` → companyKey/token valid but no data yet (graceful empty state).
 * - `error`     → invalid/expired token, network failure, etc. (friendly IT message).
 */
export type FetchInsightsResult =
  | { status: 'ok'; data: EmployerInsights }
  | { status: 'not-found' }
  | { status: 'error'; reason?: 'invalid-token' | 'expired' | 'network' | 'unknown' };

// HMAC-gated read API. Token scheme lives server-side
// (functions/src/employerInsights.js) + scripts/lib/employer-insights-token.mjs;
// the client only forwards the `t` token it received in the cold-email link.

/**
 * Fetch a company's insights by key + access token via the employerInsights
 * Cloud Function. Never throws — returns a discriminated result the page renders.
 */
export async function fetchInsights(
  companyKey: string,
  token: string,
): Promise<FetchInsightsResult> {
  if (!companyKey || !token) return { status: 'error', reason: 'invalid-token' };
  try {
    const url = `${FUNCTIONS_BASE}/employerInsights?c=${encodeURIComponent(companyKey)}&t=${encodeURIComponent(token)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return { status: 'error', reason: 'invalid-token' };
    if (res.status === 404) return { status: 'not-found' };
    if (!res.ok) return { status: 'error', reason: 'network' };
    const data = (await res.json()) as EmployerInsights;
    return data?.totals ? { status: 'ok', data } : { status: 'not-found' };
  } catch {
    return { status: 'error', reason: 'network' };
  }
}
