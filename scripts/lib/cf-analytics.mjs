/**
 * Shared Cloudflare GraphQL Analytics primitives.
 *
 * Extracted (AGENTS.md #6 — no literal duplication of funnel-critical
 * constructs across sibling scripts) so the CF-analytics consumers share
 * one implementation instead of drifting copies:
 *   - scripts/cf-status-report.mjs        (human/JSON status-code report)
 *   - scripts/discover-404s-via-cloudflare.mjs (feeds 404 paths to the
 *                                              seo-404-compat reconciler)
 *   - scripts/build-cf-hot-404s.mjs       (bounded job-detail hot-list for
 *                                          cfHot404BridgePlugin)
 * The latter two both need the FULL distinct-path universe, not just the
 * top 10k by count — see sweepErrorPathsWindowed() below.
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
 * @param {string|null} [opts.requestSource='eyeball']  filter on requestSource.
 *                                         Default 'eyeball' = real client
 *                                         requests ONLY. Pass null to include
 *                                         Worker-internal rows — almost never
 *                                         what you want: the locale-router's
 *                                         former Cache API usage logged every
 *                                         cache.match() MISS as a synthetic
 *                                         `edgeWorkerCacheAPI` 504 (~124k/day,
 *                                         empty UA, originResponseDurationMs 0)
 *                                         and every cache.put() as a 204 —
 *                                         phantom rows misread as a real
 *                                         outage three PRs in a row
 *                                         (#1791/#1814/#1830).
 * @returns {Promise<Array<{status:number,host:string,path:string,count:number}>>}
 */
export async function fetchErrorPaths(token, zoneId, opts = {}) {
  const hours = Math.min(opts.hours ?? MAX_HOURS, MAX_HOURS);
  const minStatus = opts.minStatus ?? 404;
  const limit = opts.limit ?? 10000;
  const until = opts.until ? new Date(opts.until) : new Date();
  const sinceISO = new Date(until.getTime() - hours * 3600 * 1000).toISOString();
  const requestSource = opts.requestSource === undefined ? 'eyeball' : opts.requestSource;
  const filter = {
    datetime_geq: sinceISO,
    datetime_leq: until.toISOString(),
    edgeResponseStatus_geq: minStatus,
  };
  if (requestSource) filter.requestSource = requestSource;
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

/**
 * Time-sliced sweep across `windowCount` contiguous `windowHours` windows,
 * summing per-path counts. A single httpRequestsAdaptiveGroups query is
 * capped at 10k rows ordered by count_DESC, so one day-long window only ever
 * surfaces the 10k HOTTEST paths — the long tail of distinct lower-frequency
 * 404 paths (each hit a handful of times, but numerous) never enters the
 * result and is silently lost, every call, forever. CF's free-plan adaptive
 * retention is ~3 days, so sweeping the last `windowCount` contiguous narrow
 * windows and summing non-overlapping per-path counts reconstructs each
 * path's true multi-window hit total: a path outside one window's top-10k
 * still surfaces in another.
 *
 * Extracted from build-cf-hot-404s.mjs (AGENTS.md #6 — no literal
 * duplication of a funnel-critical construct across sibling scripts) so
 * every CF-sweep consumer shares ONE windowing implementation instead of
 * drifting copies:
 *   - scripts/build-cf-hot-404s.mjs         (bounded non-Ticino job-detail
 *                                            hot-list, cfHot404BridgePlugin)
 *   - scripts/discover-404s-via-cloudflare.mjs (general seo-404-compat
 *     accumulator feed — previously a single un-windowed 10k-row query that
 *     saturated its cap every single day, silently truncating the long tail
 *     of real content 404s before they could ever reach the compat
 *     accumulator / prune / bridge pipeline)
 *
 * @param {string} token   CF API token (Analytics:Read)
 * @param {string} zoneId  resolved zone tag
 * @param {object} [opts]
 * @param {number} [opts.windowHours=1]   size of each window, in hours
 * @param {number} [opts.windowCount=48]  number of contiguous windows to sweep
 * @param {number} [opts.minStatus=404]   floor on edgeResponseStatus (>=)
 * @param {number} [opts.maxStatus]       ceiling on edgeResponseStatus (<=)
 * @param {string} [opts.host]            filter to one clientRequestHTTPHost
 * @param {Date|string} [opts.until=now]  end of the most recent window
 * @returns {Promise<{rows:Array<{path:string,count:number}>, windowsOk:number, windowCount:number}>}
 *   `rows` — normalized (trailing-slash-stripped) path + summed count across
 *   all windows. `windowsOk` — windows that returned successfully (a single
 *   failed window is skipped, not fatal, to tolerate transient CF 5xx).
 */
export async function sweepErrorPathsWindowed(token, zoneId, opts = {}) {
  const windowHours = opts.windowHours ?? 1;
  const windowCount = opts.windowCount ?? 48;
  const until = opts.until ? new Date(opts.until) : new Date();
  const nowMs = until.getTime();
  const swept = new Map(); // normalized path -> summed count across windows
  let windowsOk = 0;
  for (let i = 0; i < windowCount; i++) {
    const windowUntil = new Date(nowMs - i * windowHours * 3600 * 1000);
    let windowRows;
    try {
      windowRows = await fetchErrorPaths(token, zoneId, {
        hours: windowHours,
        minStatus: opts.minStatus ?? 404,
        maxStatus: opts.maxStatus,
        host: opts.host,
        limit: 10000,
        until: windowUntil,
      });
    } catch {
      // A single failed window (transient CF 5xx / retention edge) must not
      // abort the sweep — skip it, keep everything gathered so far.
      continue;
    }
    windowsOk++;
    if (windowRows.length >= 10000) {
      const windowLabel = `${windowUntil.toISOString().slice(0, 13)}h (window ${i})`;
      console.warn(
        `[cf-sweep] window saturated: ${windowLabel} hit 10k cap — sub-window split may be needed`,
      );
    }
    for (const r of windowRows) {
      const norm = r.path.replace(/\/+$/, '');
      swept.set(norm, (swept.get(norm) || 0) + r.count);
    }
  }
  const rows = [...swept.entries()].map(([path, count]) => ({ path, count }));
  return { rows, windowsOk, windowCount };
}
