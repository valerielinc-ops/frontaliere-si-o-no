/**
 * Shared Cloudflare GraphQL Analytics primitives.
 *
 * Extracted (AGENTS.md #6 — no literal duplication of funnel-critical
 * constructs across sibling scripts) so the two CF-analytics consumers share
 * one implementation instead of drifting copies:
 *   - scripts/cf-status-report.mjs        (human/JSON status-code report)
 *   - scripts/discover-404s-via-cloudflare.mjs (feeds 404 paths to the
 *                                              seo-404-compat reconciler)
 *
 * Free-plan facts baked in:
 *   - The httpRequestsAdaptiveGroups dataset accepts a time range of AT MOST
 *     1 day per query → callers must keep windows under MAX_HOURS.
 *   - Retention on the free plan is short (~3 days); older windows return empty.
 *
 * Auth: every function takes a Cloudflare API token with Zone→Analytics→Read on
 * the target zone (stored in Firebase Remote Config as CF_API_TOKEN). These
 * helpers THROW on error (libraries must not process.exit); callers decide how
 * to surface failures.
 */

export const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const REST_BASE = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_ZONE_NAME = 'frontaliereticino.ch';

// Stay safely under the free-plan 1-day-per-query cap (clock skew once tripped
// "1d96ms > 1d").
export const MAX_HOURS = 23.9;

/** POST a GraphQL query; return `data` or throw with the CF error message. */
export async function cfGraphQL(token, query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Cloudflare GraphQL returned non-JSON (HTTP ${res.status}).`);
  if (json.errors && json.errors.length) {
    throw new Error(`Cloudflare GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

/** Resolve a zone id from its name (or return the override if provided). */
export async function resolveZoneId(token, zoneName = DEFAULT_ZONE_NAME, zoneIdOverride) {
  if (zoneIdOverride) return zoneIdOverride;
  const res = await fetch(`${REST_BASE}/zones?name=${encodeURIComponent(zoneName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.success || !json.result?.length) {
    throw new Error(`Could not resolve Cloudflare zone id for ${zoneName} (check token scope).`);
  }
  return json.result[0].id;
}

const ERROR_PATHS_QUERY = `
query($zone:String!,$limit:Int!,$filter:ZoneHttpRequestsAdaptiveGroupsFilter_InputObject){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(limit:$limit,filter:$filter,orderBy:[count_DESC]){
      count dimensions{ edgeResponseStatus clientRequestHTTPHost clientRequestPath }
    }
  }}
}`;

/**
 * Fetch `(status, host, path, count)` rows for requests with
 * edgeResponseStatus >= minStatus over a single sub-1-day window.
 *
 * @param {string} token   CF API token (Analytics:Read)
 * @param {string} zoneId  resolved zone tag
 * @param {object} [opts]
 * @param {number} [opts.hours=MAX_HOURS]  lookback window (clamped to MAX_HOURS)
 * @param {number} [opts.minStatus=404]    floor on edgeResponseStatus (>=)
 * @param {number} [opts.maxStatus]        ceiling on edgeResponseStatus (<=).
 *                                         Set this (e.g. minStatus=maxStatus=404)
 *                                         to capture ONLY 404s — a >= filter
 *                                         alone also sweeps in 5xx, which would
 *                                         poison a 404-only consumer.
 * @param {string} [opts.host]             filter to one clientRequestHTTPHost
 * @param {number} [opts.limit=10000]      max distinct rows
 * @param {Date|string} [opts.until=now]   window end (for day-by-day looping)
 * @returns {Promise<Array<{status:number,host:string,path:string,count:number}>>}
 */
export async function fetchErrorPaths(token, zoneId, opts = {}) {
  const hours = Math.min(opts.hours ?? MAX_HOURS, MAX_HOURS);
  const minStatus = opts.minStatus ?? 404;
  const limit = opts.limit ?? 10000;
  const until = opts.until ? new Date(opts.until) : new Date();
  const sinceISO = new Date(until.getTime() - hours * 3600 * 1000).toISOString();
  const filter = {
    datetime_geq: sinceISO,
    datetime_leq: until.toISOString(),
    edgeResponseStatus_geq: minStatus,
  };
  if (opts.maxStatus != null) filter.edgeResponseStatus_leq = opts.maxStatus;
  if (opts.host) filter.clientRequestHTTPHost = opts.host;

  const data = await cfGraphQL(token, ERROR_PATHS_QUERY, { zone: zoneId, limit, filter });
  const rows = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  return rows.map((r) => ({
    status: r.dimensions.edgeResponseStatus,
    host: r.dimensions.clientRequestHTTPHost,
    path: r.dimensions.clientRequestPath,
    count: r.count,
  }));
}
