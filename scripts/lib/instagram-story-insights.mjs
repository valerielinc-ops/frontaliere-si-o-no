import { sleep } from './ga4-service-account.mjs';
import { GRAPH_API } from './instagram-graph-constants.mjs';
import {
  INSTAGRAM_STORY_MEASUREMENT_WINDOWS,
  INSTAGRAM_STORY_METRIC_FIELDS,
} from './instagram-story-contract.mjs';

const METRIC_NAMES = Object.freeze([...new Set(Object.values(INSTAGRAM_STORY_METRIC_FIELDS))]);
const METRIC_FIELDS_BY_NAME = Object.freeze(Object.fromEntries(METRIC_NAMES.map((metric) => [
  metric,
  Object.freeze(Object.entries(INSTAGRAM_STORY_METRIC_FIELDS)
    .filter(([, apiMetric]) => apiMetric === metric)
    .map(([field]) => field)),
])));
export const INSTAGRAM_STORY_INSIGHTS_REQUEST_TIMEOUT_MS = 5_000;
export const INSTAGRAM_STORY_INSIGHTS_MAX_RETRIES = 1;
export const INSTAGRAM_STORY_INSIGHTS_MAX_CONCURRENT_METRICS = 3;
const RETRYABLE_HTTP_STATUS = (status) => status === 429 || status >= 500;
const RETRYABLE_GRAPH_ERROR_CODES = new Set([4, 17, 32, 613]);

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function metricRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function metricValue(item, metric) {
  if (record(item?.total_value)) {
    const breakdownRows = Array.isArray(item.total_value.breakdowns)
      ? item.total_value.breakdowns.flatMap((breakdown) => (
        Array.isArray(breakdown?.results) ? breakdown.results : []
      ))
      : [];
    if (metric === 'navigation' && breakdownRows.length) return breakdownRows;
    if (Array.isArray(item?.values)) return item.values.at(-1)?.value;
    if (breakdownRows.length) return breakdownRows;
    if (Object.prototype.hasOwnProperty.call(item.total_value, 'value')) return item.total_value.value;
  }
  if (Array.isArray(item?.values)) return item.values.at(-1)?.value;
  return item?.value;
}

function navigationCounts(value) {
  const counts = {};
  const rows = Array.isArray(value)
    ? value
    : record(value) && Array.isArray(value.results)
      ? value.results
      : record(value)
        ? Object.entries(value).map(([key, count]) => ({ key, value: count }))
        : [];
  for (const row of rows) {
    if (!record(row)) continue;
    const dimensionValue = Array.isArray(row.dimension_values) ? row.dimension_values[0]
      : Array.isArray(row.dimensionValues) ? row.dimensionValues[0]
        : null;
    const key = String(row.key || row.action_type || row.name || dimensionValue || '').trim().toLowerCase().replace(/[^a-z]/gu, '');
    const metricValues = Array.isArray(row.metric_values) ? row.metric_values[0]
      : Array.isArray(row.metricValues) ? row.metricValues[0]
        : null;
    const count = finiteCount(row.value ?? row.count ?? (record(metricValues) ? metricValues.value : metricValues));
    const field = ({
      tapforward: 'tapsForward',
      tapsforward: 'tapsForward',
      tapback: 'tapsBack',
      tapsback: 'tapsBack',
      tapexit: 'exits',
      exit: 'exits',
      swipeforward: 'swipesForward',
      swipesforward: 'swipesForward',
    })[key];
    if (field && count !== null) counts[field] = count;
  }
  return counts;
}

function errorStatus(body, response) {
  const graphCode = Number(body?.error?.code);
  const graphSubcode = Number(body?.error?.error_subcode);
  if (graphCode === 100 && graphSubcode !== 33) return 'metric-unavailable';
  return 'unavailable';
}

async function readMetric(storyId, accessToken, metric, fetchImpl, sleepImpl) {
  const url = new URL(`${GRAPH_API}/${encodeURIComponent(storyId)}/insights`);
  url.searchParams.set('metric', metric);
  if (metric === 'navigation') url.searchParams.set('breakdown', 'story_navigation_action_type');
  let response;
  let body;
  let requestAttempts = 0;
  for (let attempt = 0; attempt <= INSTAGRAM_STORY_INSIGHTS_MAX_RETRIES; attempt += 1) {
    requestAttempts += 1;
    try {
      // A new AbortSignal per attempt is required: a timed-out signal cannot be reused by retries.
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(INSTAGRAM_STORY_INSIGHTS_REQUEST_TIMEOUT_MS),
      });
      body = await response.json().catch(() => null);
      const graphCode = Number(body?.error?.code);
      const retryable = RETRYABLE_HTTP_STATUS(response.status) || RETRYABLE_GRAPH_ERROR_CODES.has(graphCode);
      if (retryable && attempt < INSTAGRAM_STORY_INSIGHTS_MAX_RETRIES) {
        const retryAfterHeader = response.headers?.get?.('retry-after');
        const retryAfterSeconds = retryAfterHeader === null || retryAfterHeader === undefined
          ? NaN
          : Number(retryAfterHeader);
        const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.min(retryAfterSeconds * 1000, 2_000)
          : 500 * (attempt + 1);
        await sleepImpl(retryDelay);
        continue;
      }
      break;
    } catch {
      if (attempt >= INSTAGRAM_STORY_INSIGHTS_MAX_RETRIES) {
        return { status: 'unavailable', requestAttempts };
      }
      await sleepImpl(250 * (attempt + 1));
    }
  }
  if (!response) return { status: 'unavailable', requestAttempts };
  if (!response.ok || body?.error) return { status: errorStatus(body, response), requestAttempts };
  const item = metricRows(body).find((row) => record(row) && row.name === metric);
  if (!item) return { status: 'metric-unavailable', requestAttempts };
  return { status: 'available', value: metricValue(item, metric), requestAttempts };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function newMetricDocument() {
  return {
    metrics: {
      views: null,
      reach: null,
      totalInteractions: null,
      replies: null,
      shares: null,
      follows: null,
      profileVisits: null,
      tapsForward: null,
      tapsBack: null,
      exits: null,
      swipesForward: null,
    },
    metricStatus: {
      views: 'unavailable',
      reach: 'unavailable',
      totalInteractions: 'unavailable',
      replies: 'unavailable',
      shares: 'unavailable',
      follows: 'unavailable',
      profileVisits: 'unavailable',
      tapsForward: 'unavailable',
      tapsBack: 'unavailable',
      exits: 'unavailable',
      swipesForward: 'unavailable',
    },
    availableMetrics: [],
  };
}

function metricDocument(existing) {
  const empty = newMetricDocument();
  const metrics = { ...empty.metrics, ...(record(existing?.metrics) ? existing.metrics : {}) };
  const metricStatus = { ...empty.metricStatus, ...(record(existing?.metricStatus) ? existing.metricStatus : {}) };
  return {
    metrics,
    metricStatus,
    availableMetrics: Object.keys(metrics).filter((field) => metricStatus[field] === 'available'),
  };
}

/** Collect exact-ID Story observations while the Story is still available to the Graph API. */
export async function collectInstagramStoryInsights({
  publications = [],
  existing = [],
  accessToken,
  asOf = new Date(),
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new TypeError('asOf must be a valid date');
  if (!accessToken) {
    return {
      status: 'credentials-missing',
      additions: [],
      candidates: 0,
      attempted: 0,
      requestAttempts: 0,
      unavailable: 0,
    };
  }

  const existingRows = Array.isArray(existing) ? existing.filter(record) : [];
  const existingByWindow = new Map(existingRows.map((row) => [
    `${row.storyId}\u0000${row.measurementWindow}`,
    row,
  ]));
  const additions = [];
  let candidates = 0;
  let attempted = 0;
  let requestAttempts = 0;
  let unavailable = 0;
  let retryableUnavailable = 0;
  let noDataCandidates = 0;
  for (const publication of Array.isArray(publications) ? publications : []) {
    const storyId = String(publication?.storyId || '').trim();
    const publishedMs = Date.parse(String(publication?.publishedAt || ''));
    if (!storyId || !Number.isFinite(publishedMs) || publishedMs > asOfMs) continue;
    const ageHours = (asOfMs - publishedMs) / 3_600_000;
    const window = INSTAGRAM_STORY_MEASUREMENT_WINDOWS.find((item) => ageHours >= item.minHours && ageHours < item.maxHours);
    if (!window) continue;
    const key = `${storyId}\u0000${window.id}`;
    const previous = existingByWindow.get(key);
    const row = metricDocument(previous);
    const metricsToFetch = METRIC_NAMES.filter((metric) => (
      METRIC_FIELDS_BY_NAME[metric].some((field) => row.metricStatus[field] === 'unavailable')
    ));
    if (previous && metricsToFetch.length === 0) {
      if (row.availableMetrics.length === 0) {
        candidates += 1;
        noDataCandidates += 1;
      }
      continue;
    }
    candidates += 1;
    const metricResults = await mapWithConcurrency(
      metricsToFetch,
      INSTAGRAM_STORY_INSIGHTS_MAX_CONCURRENT_METRICS,
      (metric) => readMetric(storyId, accessToken, metric, fetchImpl, sleepImpl),
    );
    for (const [index, result] of metricResults.entries()) {
      const metric = metricsToFetch[index];
      const fields = METRIC_FIELDS_BY_NAME[metric];
      attempted += 1;
      requestAttempts += result.requestAttempts || 0;
      if (result.status !== 'available') {
        unavailable += fields.length;
        if (result.status === 'unavailable') retryableUnavailable += fields.length;
        for (const field of fields) row.metricStatus[field] = result.status;
        continue;
      }
      if (metric === 'navigation') {
        const counts = navigationCounts(result.value);
        for (const field of fields) {
          if (Object.prototype.hasOwnProperty.call(counts, field)) {
            row.metrics[field] = counts[field];
            row.metricStatus[field] = 'available';
          } else {
            row.metrics[field] = null;
            row.metricStatus[field] = 'metric-unavailable';
            unavailable += 1;
          }
        }
      } else {
        const field = fields[0];
        const value = finiteCount(result.value);
        if (field && value !== null) {
          row.metrics[field] = value;
          row.metricStatus[field] = 'available';
        } else if (field) {
          row.metrics[field] = null;
          row.metricStatus[field] = 'metric-unavailable';
          unavailable += 1;
        }
      }
    }
    row.availableMetrics = Object.keys(row.metrics).filter((field) => row.metricStatus[field] === 'available');
    if (row.availableMetrics.length === 0) noDataCandidates += 1;
    additions.push({
      storyId,
      publishedAt: new Date(publishedMs).toISOString(),
      snapshotAt: new Date(asOfMs).toISOString(),
      // Keep the stored value inside the window's exclusive upper bound after rounding.
      snapshotAgeHours: Math.floor(ageHours * 1000) / 1000,
      measurementWindow: window.id,
      ...row,
      sourceMediaId: publication.sourceMediaId ?? null,
      followUpFormat: publication.followUpFormat ?? null,
      copyPackId: publication.copyPackId ?? null,
      copyTemplateId: publication.copyTemplateId ?? null,
      copyAngleId: publication.copyAngleId ?? null,
      copyPillarId: publication.copyPillarId ?? null,
      copyRevisionId: publication.copyRevisionId ?? null,
    });
    existingByWindow.set(key, row);
  }
  const hasAvailableMetrics = additions.some((row) => row.availableMetrics.length > 0);
  const hasTerminalUnavailableMetrics = additions.some((row) => Object.values(row.metricStatus)
    .some((status) => status === 'metric-unavailable'));
  const status = candidates === 0
    ? 'no-ready-stories'
    : noDataCandidates > 0 && !hasAvailableMetrics
      ? 'metrics-unavailable'
      : retryableUnavailable > 0 && !hasAvailableMetrics
        ? 'metrics-unavailable'
        : retryableUnavailable > 0 || hasTerminalUnavailableMetrics
          ? 'partial-metrics'
          : 'snapshots-added';
  return {
    status,
    additions,
    candidates,
    attempted,
    requestAttempts,
    unavailable,
    retryableUnavailable,
  };
}
