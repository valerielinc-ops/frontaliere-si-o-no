import { GSC_SEARCH_ANALYTICS_ROW_LIMIT } from './gsc-query-limits.mjs';
import {
  GSC_FINAL_WINDOW_DAYS,
  GSC_FINAL_WINDOW_LOOKBACK_DAYS,
  gscCalendarDay,
  normalizeGscFirstIncompleteDate,
  selectLatestGscFinalWindow,
  shiftGscDay,
} from './gsc-final-window.mjs';
import { segmentPrefilterRegex } from './seo-ctr-query-segments.mjs';
import { createGscRecoverySnapshot } from './gsc-recovery-report.mjs';
import { GSC_SITE_PROPERTY } from './gsc-property.mjs';

export const GSC_QUERY_ROW_LIMIT = GSC_SEARCH_ANALYTICS_ROW_LIMIT;
export const GSC_QUERY_MAX_PAGES = 8;
export const GSC_RECOVERY_QUERY_REGEX = segmentPrefilterRegex();

async function querySearchAnalytics(token, body, fetchImpl = fetch) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE_PROPERTY)}/searchAnalytics/query`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GSC API request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

/** Fetch a Search Analytics result set completely or fail instead of publishing a truncated ranking. */
export async function fetchGscSearchAnalyticsRows(token, body, {
  fetchImpl = fetch,
  maxPages = GSC_QUERY_MAX_PAGES,
} = {}) {
  const rows = [];
  let metadata = null;
  for (let page = 0; page < maxPages; page += 1) {
    const startRow = page * GSC_QUERY_ROW_LIMIT;
    const data = await querySearchAnalytics(token, {
      ...body,
      rowLimit: GSC_QUERY_ROW_LIMIT,
      startRow,
    }, fetchImpl);
    const batch = Array.isArray(data.rows) ? data.rows : [];
    rows.push(...batch);
    metadata ||= data.metadata || null;
    if (batch.length < GSC_QUERY_ROW_LIMIT) {
      return { rows, metadata, complete: true, returnedRows: rows.length };
    }
  }
  throw new Error(`GSC response incomplete: safety cap reached at ${rows.length} rows`);
}

async function fetchFinalDateAvailability(token, { today, lookbackDays, fetchImpl }) {
  const startDate = shiftGscDay(today, -(lookbackDays - 1));
  const probeBody = {
    startDate,
    endDate: today,
    dimensions: ['date'],
    dataState: 'final',
  };
  const [finalProbe, allProbe] = await Promise.all([
    querySearchAnalytics(token, { ...probeBody, rowLimit: GSC_QUERY_ROW_LIMIT }, fetchImpl),
    querySearchAnalytics(token, { ...probeBody, dataState: 'all', rowLimit: GSC_QUERY_ROW_LIMIT }, fetchImpl),
  ]);
  const metadata = normalizeGscFirstIncompleteDate(allProbe.metadata);
  return {
    startDate,
    availableDates: (Array.isArray(finalProbe.rows) ? finalProbe.rows : [])
      .map((row) => row?.keys?.[0])
      .filter((date) => typeof date === 'string'),
    firstIncompleteDate: metadata.firstIncompleteDate,
    metadataError: metadata.error,
  };
}

export async function selectGscRecoveryWindows(token, {
  today = gscCalendarDay(),
  days = GSC_FINAL_WINDOW_DAYS,
  lookbackDays = GSC_FINAL_WINDOW_LOOKBACK_DAYS,
  fetchImpl = fetch,
} = {}) {
  const probe = await fetchFinalDateAvailability(token, { today, lookbackDays, fetchImpl });
  return selectLatestGscFinalWindow({
    today,
    days,
    lookbackDays,
    availableDates: probe.availableDates,
    firstIncompleteDate: probe.firstIncompleteDate,
    metadataError: probe.metadataError,
  });
}

async function fetchRecoverySnapshot(token, assessment, {
  fetchImpl,
  queryRowsMaxPages,
} = {}) {
  if (assessment?.status !== 'measurable' || assessment?.complete !== true || !assessment.window) {
    return createGscRecoverySnapshot({ assessment, pageRowsComplete: false, pageRowsError: assessment?.reason || 'window is unmeasurable' });
  }
  const { start, end } = assessment.window;
  const pageResult = await fetchGscSearchAnalyticsRows(token, {
    startDate: start,
    endDate: end,
    dimensions: ['page'],
    dataState: 'final',
  }, { fetchImpl });

  let queryRows = [];
  let queryRowsComplete = false;
  let queryRowsError = null;
  try {
    const queryResult = await fetchGscSearchAnalyticsRows(token, {
      startDate: start,
      endDate: end,
      dimensions: ['page', 'query'],
      dataState: 'final',
      dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: GSC_RECOVERY_QUERY_REGEX }] }],
    }, { fetchImpl, maxPages: queryRowsMaxPages ?? GSC_QUERY_MAX_PAGES });
    queryRows = queryResult.rows;
    queryRowsComplete = queryResult.complete;
  } catch (error) {
    queryRowsError = error instanceof Error ? error.message : String(error);
  }

  return createGscRecoverySnapshot({
    assessment,
    pageRows: pageResult.rows,
    queryRows,
    pageRowsComplete: pageResult.complete,
    queryRowsComplete,
    queryRowsError,
  });
}

/** Select and fetch two verified complete, equal-length final windows. */
export async function fetchGscRecoveryInputs(token, {
  today = gscCalendarDay(),
  days = GSC_FINAL_WINDOW_DAYS,
  lookbackDays = GSC_FINAL_WINDOW_LOOKBACK_DAYS,
  baselineSnapshot = null,
  fetchImpl = fetch,
  queryRowsMaxPages = GSC_QUERY_MAX_PAGES,
} = {}) {
  const selection = await selectGscRecoveryWindows(token, { today, days, lookbackDays, fetchImpl });
  if (selection.status !== 'measurable' || !selection.window) {
    const current = createGscRecoverySnapshot({ assessment: selection, pageRowsComplete: false, pageRowsError: selection.reason });
    return { selection, current, baseline: baselineSnapshot, baselineSource: baselineSnapshot ? 'immutable-snapshot' : 'previous-final-window' };
  }

  const current = await fetchRecoverySnapshot(token, selection, { fetchImpl, queryRowsMaxPages });
  if (baselineSnapshot) {
    return { selection, current, baseline: baselineSnapshot, baselineSource: 'immutable-snapshot' };
  }
  const baseline = await fetchRecoverySnapshot(token, selection.previous, { fetchImpl, queryRowsMaxPages });
  return { selection, current, baseline, baselineSource: 'previous-final-window' };
}
