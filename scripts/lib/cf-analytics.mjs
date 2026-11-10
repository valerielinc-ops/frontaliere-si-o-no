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

const DEFAULT_CF_ANALYTICS_TIMEOUT_MS = 30_000;
const MAX_CF_ANALYTICS_TIMEOUT_MS = 120_000;
const DEFAULT_SWEEP_WINDOW_HOURS = 1;
const DEFAULT_SWEEP_WINDOW_COUNT = 48;
// The free plan retains only a short rolling window. Keep the sweep bounded
// even when a workflow override is accidentally much larger than the useful
// retention horizon.
const MAX_SWEEP_LOOKBACK_HOURS = 72;
const MAX_SWEEP_WINDOWS = 72;

function boundedTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_CF_ANALYTICS_TIMEOUT_MS;
  return Math.min(Math.max(1, numeric), MAX_CF_ANALYTICS_TIMEOUT_MS);
}

export const CF_ANALYTICS_TIMEOUT_MS = boundedTimeoutMs(
  process.env.CF_ANALYTICS_TIMEOUT_MS || DEFAULT_CF_ANALYTICS_TIMEOUT_MS,
);

// Stay safely under the free-plan 1-day-per-query cap (clock skew once tripped
// "1d96ms > 1d").
export const MAX_HOURS = 23.9;
/** Cloudflare's maximum result rows for one httpRequestsAdaptiveGroups query. */
export const CF_ANALYTICS_MAX_ROWS = 10_000;

function boundedPositiveNumber(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, max);
}

function boundedPositiveInteger(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, max);
}

function boundedHours(value, fallback = MAX_HOURS) {
  return boundedPositiveNumber(value, fallback, MAX_HOURS);
}

function boundedRows(value) {
  return boundedPositiveInteger(value, CF_ANALYTICS_MAX_ROWS, CF_ANALYTICS_MAX_ROWS);
}

function normalizeSweepOptions(opts) {
  const windowHours = boundedHours(opts.windowHours, DEFAULT_SWEEP_WINDOW_HOURS);
  const maxWindowsForRetention = Math.max(1, Math.floor(MAX_SWEEP_LOOKBACK_HOURS / windowHours));
  const windowCount = Math.min(
    boundedPositiveInteger(opts.windowCount, DEFAULT_SWEEP_WINDOW_COUNT, MAX_SWEEP_WINDOWS),
    maxWindowsForRetention,
  );
  return { windowHours, windowCount };
}

function normalizePath(pathValue) {
  if (typeof pathValue !== 'string') return null;
  const normalized = pathValue.trim().replace(/\/+$/, '');
  return normalized || '/';
}

/**
 * POST a GraphQL query; return `data` or throw with the CF error message.
 *
 * `fetchImpl` is injectable so bounded callers can account for every network
 * request in their cycle budget; existing consumers keep the global fetch
 * default.
 */
export async function cfGraphQL(
  token,
  query,
  variables,
  fetchImpl = fetch,
  timeoutMs = CF_ANALYTICS_TIMEOUT_MS,
) {
  const { res, json } = await fetchJsonWithDeadline(
    GRAPHQL_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
    fetchImpl,
    timeoutMs,
  );
  if (!json) throw new Error(`Cloudflare GraphQL returned non-JSON (HTTP ${res.status}).`);
  if (json.errors && json.errors.length) {
    throw new Error(`Cloudflare GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

/**
 * Fetch JSON with one deadline covering both response headers and body.
 * `fetchImpl` remains injectable so consumers can test without Cloudflare.
 */
async function fetchJsonWithDeadline(url, init, fetchImpl, timeoutMs) {
  const effectiveTimeoutMs = boundedTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeoutError = () => {
    const error = new Error(`Cloudflare API ${url} timed out after ${effectiveTimeoutMs}ms`);
    error.name = 'TimeoutError';
    error.code = 'CF_ANALYTICS_TIMEOUT';
    return error;
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, effectiveTimeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    const json = await Promise.race([res.json().catch(() => null), deadline]);
    return { res, json };
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Resolve a zone id from its name (or return the override if provided).
 * @param {typeof fetch} [fetchImpl=fetch] network implementation
 */
export async function resolveZoneId(
  token,
  zoneName = DEFAULT_ZONE_NAME,
  zoneIdOverride,
  fetchImpl = fetch,
  timeoutMs = CF_ANALYTICS_TIMEOUT_MS,
) {
  if (zoneIdOverride) return zoneIdOverride;
  const { res, json } = await fetchJsonWithDeadline(
    `${REST_BASE}/zones?name=${encodeURIComponent(zoneName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    fetchImpl,
    timeoutMs,
  );
  const httpStatus = Number.isInteger(res?.status) ? `HTTP ${res.status}` : 'HTTP status sconosciuto';
  if (!json) {
    throw new Error(`Cloudflare zone lookup returned non-JSON (${httpStatus}).`);
  }
  if (!json || !json.success || !json.result?.length) {
    const apiErrors = Array.isArray(json.errors) && json.errors.length > 0
      ? `: ${json.errors.map((error) => error?.message || JSON.stringify(error)).join('; ')}`
      : '';
    throw new Error(`Could not resolve Cloudflare zone id for ${zoneName} (${httpStatus}; check token scope${apiErrors}).`);
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

// See fetchErrorDiagnostics(). The three extra dimensions (hour, origin status, cache
// outcome) were verified against the live zone before any code was written on top of them:
// the adaptive dataset exposes all three, returning e.g.
// `edge=502 origin=0 cache=none host=cdn.…` alongside `edge=502 origin=502 cache=bypass`.
const ERROR_DIAGNOSTICS_QUERY = `
query($zone:String!,$limit:Int!,$filter:ZoneHttpRequestsAdaptiveGroupsFilter_InputObject){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(limit:$limit,filter:$filter,orderBy:[count_DESC]){
      count dimensions{ datetimeHour edgeResponseStatus originResponseStatus cacheStatus clientRequestHTTPHost }
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
 * @param {typeof fetch} [opts.fetchImpl=fetch] network implementation
 * @returns {Promise<Array<{status:number,host:string,path:string,count:number}>>}
 */
export async function fetchErrorPaths(token, zoneId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hours = boundedHours(opts.hours ?? MAX_HOURS);
  const minStatus = opts.minStatus ?? 404;
  const limit = boundedRows(opts.limit ?? CF_ANALYTICS_MAX_ROWS);
  const until = opts.until ? new Date(opts.until) : new Date();
  if (!Number.isFinite(until.getTime())) throw new Error('Invalid Cloudflare analytics window end.');
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

  const data = await cfGraphQL(token, ERROR_PATHS_QUERY, { zone: zoneId, limit, filter }, fetchImpl);
  const zones = data?.viewer?.zones;
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('Cloudflare analytics returned no matching zone.');
  }
  const rows = zones[0]?.httpRequestsAdaptiveGroups;
  if (!Array.isArray(rows)) throw new Error('Cloudflare analytics returned an unknown path result.');
  return rows.map((r) => ({
    status: r?.dimensions?.edgeResponseStatus ?? null,
    host: r?.dimensions?.clientRequestHTTPHost ?? null,
    path: r?.dimensions?.clientRequestPath ?? null,
    count: r?.count ?? null,
  }));
}

/**
 * 5xx rows grouped by HOUR and by the dimensions that explain *why*.
 *
 * `fetchErrorPaths()` above answers "which URLs failed". This answers the two questions it
 * cannot, and that cost a wrong diagnosis on 2026-08-05:
 *
 *   - `originResponseStatus` — 0 means the origin never answered and the error is
 *     SYNTHESISED by Cloudflare; a real value means the origin itself returned the error.
 *     Opposite remedies.
 *   - `cacheStatus` — says whether a servable copy existed, i.e. whether `serve_stale` had
 *     any material to act on. Without it the mitigation's effectiveness is unmeasurable.
 *
 * Grouping by `datetimeHour` is what makes the never-verified "5xx cluster inside deploy
 * windows" hypothesis testable: cardinality stays tiny (24 hours x a handful of combinations),
 * so the 10k row cap never bites and the windowing of `sweepErrorPathsWindowed()` is not needed.
 *
 * Deliberately does NOT include `clientRequestPath`: mixing path into these dimensions blows
 * up cardinality and puts the query back under the 10k cap. Per-URL detail stays in
 * `fetchErrorPaths()`. Two queries, two purposes, one shared GraphQL construct.
 *
 * @param {string} token
 * @param {string} zoneId
 * @param {object} [opts]
 * @param {number} [opts.hours=23.9]
 * @param {number} [opts.minStatus=500]
 * @param {Date|string} [opts.until=now]
 * @param {string|null} [opts.requestSource='eyeball']  see the anti-phantom note in fetchErrorPaths
 * @param {typeof fetch} [opts.fetchImpl=fetch] network implementation
 * @returns {Promise<Array<{hour:string,edgeStatus:number,originStatus:number|null,cacheStatus:string|null,host:string,count:number}>>}
 */
export async function fetchErrorDiagnostics(token, zoneId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hours = boundedHours(opts.hours ?? MAX_HOURS);
  const minStatus = opts.minStatus ?? 500;
  const until = opts.until ? new Date(opts.until) : new Date();
  if (!Number.isFinite(until.getTime())) throw new Error('Invalid Cloudflare analytics window end.');
  const sinceISO = new Date(until.getTime() - hours * 3600 * 1000).toISOString();
  const requestSource = opts.requestSource === undefined ? 'eyeball' : opts.requestSource;
  const filter = {
    datetime_geq: sinceISO,
    datetime_leq: until.toISOString(),
    edgeResponseStatus_geq: minStatus,
  };
  if (requestSource) filter.requestSource = requestSource;

  const data = await cfGraphQL(token, ERROR_DIAGNOSTICS_QUERY, {
    zone: zoneId,
    limit: CF_ANALYTICS_MAX_ROWS,
    filter,
  }, fetchImpl);
  const zones = data?.viewer?.zones;
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('Cloudflare analytics returned no matching zone.');
  }
  const rows = zones[0]?.httpRequestsAdaptiveGroups;
  if (!Array.isArray(rows)) throw new Error('Cloudflare analytics returned an unknown diagnostics result.');
  return rows.map((r) => ({
    hour: r?.dimensions?.datetimeHour ?? null,
    edgeStatus: r?.dimensions?.edgeResponseStatus ?? null,
    originStatus: r?.dimensions?.originResponseStatus ?? null,
    cacheStatus: r?.dimensions?.cacheStatus ?? null,
    host: r?.dimensions?.clientRequestHTTPHost ?? null,
    count: r?.count ?? null,
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
 * @param {typeof fetch} [opts.fetchImpl=fetch] network implementation
 * @returns {Promise<{rows:Array<{path:string,count:number}>, windowsOk:number, windowCount:number}>}
 *   `rows` — normalized (trailing-slash-stripped) path + summed count across
 *   all windows. `windowsOk` — windows that returned successfully (a single
 *   failed window is skipped, not fatal, to tolerate transient CF 5xx).
 */
export async function sweepErrorPathsWindowed(token, zoneId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { windowHours, windowCount } = normalizeSweepOptions(opts);
  const until = opts.until ? new Date(opts.until) : new Date();
  if (!Number.isFinite(until.getTime())) throw new Error('Invalid Cloudflare analytics sweep end.');
  const nowMs = until.getTime();
  const swept = new Map(); // normalized path -> summed count across windows
  let windowsOk = 0;
  let firstError = null;
  for (let i = 0; i < windowCount; i++) {
    const windowUntil = new Date(nowMs - i * windowHours * 3600 * 1000);
    let windowRows;
    try {
      windowRows = await fetchErrorPaths(token, zoneId, {
        hours: windowHours,
        minStatus: opts.minStatus ?? 404,
        maxStatus: opts.maxStatus,
        host: opts.host,
        limit: CF_ANALYTICS_MAX_ROWS,
        until: windowUntil,
        fetchImpl,
      });
    } catch (error) {
      // A single failed window (transient CF 5xx / retention edge) must not
      // abort the sweep — skip it, keep everything gathered so far.
      firstError ||= error;
      continue;
    }
    windowsOk++;
    if (windowRows.length >= CF_ANALYTICS_MAX_ROWS) {
      const windowLabel = `${windowUntil.toISOString().slice(0, 13)}h (window ${i})`;
      console.warn(
        `[cf-sweep] window saturated: ${windowLabel} hit 10k cap — sub-window split may be needed`,
      );
    }
    for (const r of windowRows) {
      const status = Number(r?.status);
      const minStatus = Number(opts.minStatus ?? 404);
      const maxStatus = opts.maxStatus == null ? null : Number(opts.maxStatus);
      const count = Number(r?.count);
      if (!Number.isFinite(status) || status < minStatus) continue;
      if (maxStatus !== null && (!Number.isFinite(maxStatus) || status > maxStatus)) continue;
      if (!Number.isFinite(count) || count <= 0) continue;
      const norm = normalizePath(r?.path);
      if (norm === null) continue;
      swept.set(norm, (swept.get(norm) || 0) + count);
    }
  }
  if (windowsOk === 0) {
    if (firstError) throw firstError;
    throw new Error('Cloudflare analytics sweep returned no successful windows.');
  }
  const rows = [...swept.entries()].map(([path, count]) => ({ path, count }));
  return { rows, windowsOk, windowCount };
}
