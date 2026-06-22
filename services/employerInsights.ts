/**
 * employerInsights — typed data contract + fetch stub for the per-company
 * "wow" traffic report (cold-outreach conversion centrepiece).
 *
 * The data lives in Firestore `employer_insights/{companyKey}` and is served
 * through a Cloud Function (token-gated, per-company). This module is the SPA
 * boundary: `EmployerInsightsPage` imports `fetchInsights` and the types from
 * here, so the page never talks to Firestore/HTTP directly.
 *
 * NOTE: `fetchInsights` is intentionally a STUB. The real implementation
 * (CF endpoint URL + token validation + Firestore read) is wired separately —
 * see the TODO below. Keep the signature stable: the page depends on it.
 */

/** A single live ad row for the employer. `lost` = interested visitors who did NOT apply. */
export interface EmployerAd {
  slug: string;
  title: string;
  path: string;
  views: number;
  visitors: number;
  applies: number;
  lost: number;
}

/** Aggregate totals across all of the company's ads for the report window. */
export interface EmployerInsightsTotals {
  views: number;
  visitors: number;
  candidates: number;
  adsCount: number;
  /** Interested visitors who did NOT become candidates (the loss-aversion hook). */
  lost: number;
  /** Fraction (0–1), e.g. 0.0138 = 1.38%. */
  conversionRate: number;
}

/** The full per-company report payload. */
export interface EmployerInsights {
  companyKey: string;
  companyName: string;
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  periodDays: number;
  totals: EmployerInsightsTotals;
  topAd: { slug: string; title: string; views: number } | null;
  /** Sorted by views desc, up to 100. */
  ads: EmployerAd[];
  /** Weekly buckets, oldest → newest. */
  trend: { week: string; views: number }[];
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
const FUNCTIONS_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';

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
