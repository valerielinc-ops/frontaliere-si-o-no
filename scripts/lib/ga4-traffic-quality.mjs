import { buildTargetMarketCountryFilter, TARGET_MARKET_COUNTRIES, TRAFFIC_HOSTNAME } from './ga4-target-market.mjs';
import { fetchDailyEngagementVerdict } from './ga4-engagement-reliability.mjs';
import { classifyAnalyticsPath } from './analytics-opportunity-utils.mjs';

export { TRAFFIC_HOSTNAME };
export const QUALIFIED_MEDIA = Object.freeze(['organic', 'email', 'newsletter']);

export function buildTrafficFilter(qualified = false) {
  const hostname = { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: TRAFFIC_HOSTNAME } } };
  return qualified ? { andGroup: { expressions: [hostname, buildTargetMarketCountryFilter(), {
    filter: { fieldName: 'sessionMedium', inListFilter: { values: [...QUALIFIED_MEDIA], caseSensitive: false } },
  }] } } : hostname;
}

const PAGE_METRICS = ['screenPageViews', 'sessions', 'engagedSessions', 'totalUsers', 'averageSessionDuration', 'totalAdRevenue'];
const SUMMARY_METRICS = PAGE_METRICS;
const names = (values) => values.map((name) => ({ name }));

function metadataReasons(data) {
  const reasons = [];
  if (data.metadata?.subjectToThresholding) reasons.push('thresholding');
  if (data.metadata?.dataLossFromOtherRow) reasons.push('other_row');
  if (data.metadata?.dataTruncationReasons?.length) reasons.push('data_truncation');
  if (data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.length) reasons.push('restricted_metrics');
  if (data.metadata?.samplingMetadatas?.some((sample) => Number(sample.samplesReadCount) < Number(sample.samplingSpaceSize))) reasons.push('sampling');
  return reasons;
}

function decodeRows(data, dimensions, metrics) {
  const restricted = new Set((data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions || []).map((entry) => entry.metricName));
  return (data.rows || []).map((row) => Object.fromEntries([
    ...dimensions.map((key, i) => [key, row.dimensionValues?.[i]?.value ?? '(not set)']),
    ...metrics.map((key, i) => [key, restricted.has(key) ? null : Number(row.metricValues?.[i]?.value ?? 0)]),
  ]));
}

// Keep partial results visible, but never present them as complete populations.
async function readReport(runReport, request, dimensions, metrics, maxRows = 250_000) {
  const rows = [];
  const reasons = new Set();
  let totalRows = null;
  let currency = null;
  let timeZone = null;
  try {
    while (rows.length < maxRows) {
      const limit = Math.min(10_000, maxRows - rows.length);
      const response = await runReport({ ...request, dimensions: names(dimensions), metrics: names(metrics), offset: rows.length, limit });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const reported = Number(data.rowCount ?? 0);
      if (totalRows !== null && totalRows !== reported) reasons.add('row_count_changed_during_pagination');
      totalRows = reported;
      currency = data.metadata?.currencyCode || currency;
      timeZone = data.metadata?.timeZone || timeZone;
      for (const reason of metadataReasons(data)) reasons.add(reason);
      const batch = decodeRows(data, dimensions, metrics);
      if (batch.some((row) => dimensions.some((key) => row[key] === '(other)'))) reasons.add('other_row');
      rows.push(...batch);
      if (!batch.length || rows.length >= totalRows) break;
    }
    if (rows.length < totalRows) reasons.add('truncated');
    if (!rows.length) reasons.add('no_rows');
  } catch (error) {
    reasons.add(error.message);
  }
  return { status: reasons.size ? (rows.length ? 'partial' : 'unavailable') : 'complete', reasons: [...reasons], totalRows, returnedRows: rows.length, currency, timeZone, rows };
}

function pageTemplateForPath(pagePath) {
  const path = String(pagePath || '').trim();
  // GA4's synthetic buckets are not real URLs. Keep them unknown instead of
  // silently classifying them as generic pages and inflating that template.
  if (!path || path === '(not set)' || path === '(other)') return '(not set)';
  return classifyAnalyticsPath(path).pageTemplate;
}

function adRevenuePerThousandViews(adRevenue, views) {
  return adRevenue !== null && adRevenue !== undefined && views > 0
    ? Number(((adRevenue / views) * 1_000).toFixed(4))
    : null;
}

function pageRanking(rows, metric) {
  return [...rows].sort((a, b) => b[metric] - a[metric] || a.pagePath.localeCompare(b.pagePath)).slice(0, 50).map((row, index) => ({
    rank: index + 1, path: row.pagePath, views: row.screenPageViews, sessions: row.sessions,
    engagedSessions: row.engagedSessions, users: row.totalUsers, avgDuration: row.averageSessionDuration,
    pageTemplate: pageTemplateForPath(row.pagePath),
    adRevenue: row.totalAdRevenue,
    adRevenuePerThousandViews: adRevenuePerThousandViews(row.totalAdRevenue, row.screenPageViews),
  }));
}

function templateViews(rows, { coverageStatus = 'complete', coverageReasons = [] } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const template = pageTemplateForPath(row.pagePath);
    const current = groups.get(template) || {
      pageTemplate: template,
      views: 0,
      paths: 0,
      adRevenue: 0,
      revenueRows: 0,
      missingRevenueRows: 0,
    };
    current.views += row.screenPageViews;
    current.paths += 1;
    if (row.totalAdRevenue === null || row.totalAdRevenue === undefined) {
      current.missingRevenueRows += 1;
    } else {
      current.adRevenue += row.totalAdRevenue;
      current.revenueRows += 1;
    }
    groups.set(template, current);
  }
  // Only page views are additive across paths: never sum users or sessions.
  return [...groups.values()]
    .sort((a, b) => b.views - a.views)
    .map((entry) => {
      const hasRevenue = entry.revenueRows > 0;
      const revenueComplete = hasRevenue
        && entry.missingRevenueRows === 0
        && coverageStatus === 'complete'
        && !coverageReasons.includes('restricted_metrics');
      return {
        pageTemplate: entry.pageTemplate,
        views: entry.views,
        paths: entry.paths,
        adRevenue: hasRevenue ? Number(entry.adRevenue.toFixed(4)) : null,
        adRevenuePerThousandViews: hasRevenue
          ? adRevenuePerThousandViews(entry.adRevenue, entry.views)
          : null,
        revenueStatus: !hasRevenue ? 'missing' : revenueComplete ? 'complete' : 'partial',
      };
    });
}

async function readScope(runReport, dateRanges, qualified) {
  const dimensionFilter = buildTrafficFilter(qualified);
  const request = { dateRanges, dimensionFilter };
  const pages = await readReport(runReport, { ...request, orderBys: [
    { metric: { metricName: qualified ? 'engagedSessions' : 'screenPageViews' }, desc: true },
    { dimension: { dimensionName: 'pagePath' } },
  ] }, ['pagePath'], PAGE_METRICS);
  const totals = await readReport(runReport, request, [], SUMMARY_METRICS, 1);
  const dailyLimitations = new Set();
  const daily = await fetchDailyEngagementVerdict({ runReport: async (body) => {
    const response = await runReport(body);
    if (!response.ok) return response;
    const data = await response.json();
    for (const reason of metadataReasons(data)) dailyLimitations.add(reason);
    return { ok: true, json: async () => data };
  }, dateRanges, dimensionFilter });
  if (dailyLimitations.size) {
    daily.reliable = false;
    daily.reason = `Daily report limited: ${[...dailyLimitations].join(', ')}`;
  }
  const summary = totals.rows[0] || null;
  const { rows: _pageRows, ...pageCoverage } = pages;
  const { rows: _totalRows, ...totalCoverage } = totals;
  const reliable = pages.status === 'complete' && totals.status === 'complete' && daily.reliable;
  return {
    dimensionFilter, pageCoverage, totalCoverage, engagement: daily,
    status: reliable ? 'complete' : 'limited',
    summary: summary && {
      ...summary,
      currency: totals.currency,
      engagementRate: reliable && summary.sessions > 0 ? summary.engagedSessions / summary.sessions : null,
      adRevenuePerSession: totals.status === 'complete' && summary.sessions >= 30 && totals.currency ? summary.totalAdRevenue / summary.sessions : null,
    },
    top50: pageRanking(pages.rows, qualified ? 'engagedSessions' : 'screenPageViews'),
    pageViewsByTemplate: templateViews(pages.rows, {
      coverageStatus: pages.status,
      coverageReasons: pages.reasons,
    }),
  };
}

/** Same settled dates for both populations; no inferred bot removal or engaged-only pageview claim. */
export async function fetchTrafficQuality({ runReport, dateRanges, generatedAt = new Date().toISOString(), build = null }) {
  const raw = await readScope(runReport, dateRanges, false);
  const qualified = await readScope(runReport, dateRanges, true);
  const segments = await readReport(runReport, {
    dateRanges, dimensionFilter: buildTrafficFilter(),
    orderBys: ['deviceCategory', 'country', 'sessionSourceMedium'].map((dimensionName) => ({ dimension: { dimensionName } })),
  }, ['deviceCategory', 'country', 'sessionSourceMedium'], PAGE_METRICS);
  return {
    source: 'GA4 Data API', hostname: TRAFFIC_HOSTNAME, generatedAt, build, dateRanges,
    qualification: { countries: [...TARGET_MARKET_COUNTRIES], media: [...QUALIFIED_MEDIA], rankingMetric: 'engagedSessions' },
    interpretation: 'La vista qualificata include tutte le sessioni IT/CH organic/email/newsletter. Le pageview non sono filtrate alle sole sessioni engaged. Utenti e sessioni per pagina non sono additivi. Il ricavo GA4 `totalAdRevenue` viene letto per `pagePath` e aggregato al template con il classifier condiviso: è un’attribuzione derivata dalla pagina, non un ricavo inviato dal parametro `page_template`.',
    revenueAttribution: {
      metric: 'totalAdRevenue',
      sourceDimension: 'pagePath',
      method: 'page_path_to_page_template',
      unit: 'derived',
    },
    raw, qualified,
    segments: { ...segments, rows: segments.rows.map((row) => ({ ...row,
      engagementRate: row.sessions > 0 ? row.engagedSessions / row.sessions : null,
      reviewReason: segments.status === 'complete' && raw.engagement.reliable && row.sessions >= 1000 && row.engagedSessions / row.sessions < 0.1 && row.averageSessionDuration < 10 ? 'high_volume_short_sessions_not_bot_classification' : null,
    })) },
  };
}
