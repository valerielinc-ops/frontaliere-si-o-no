#!/usr/bin/env node
/**
 * Read-only AdSense and GA4 advertising report.
 *
 * Usage:
 *   node scripts/ads-performance-report.mjs
 *   node scripts/ads-performance-report.mjs --days=28 --markdown
 *   node scripts/ads-performance-report.mjs --start=2026-09-21 --end=2026-10-18 --json
 *   node scripts/ads-performance-report.mjs --days=28 --save
 *
 * `--save` writes local artifacts under the gitignored reports/ directory.
 * This command never changes AdSense settings, GA4 definitions, or ad behavior.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_GA4_PROPERTY_ID, getServiceAccountToken } from './lib/ga4-service-account.mjs';
import { fetchManualSlotReport } from './lib/adsense-manual-slot-report.mjs';
import { resolveAdSenseAccount } from './lib/adsense-account.mjs';
import { getAdSenseToken } from './revenue-monitor.mjs';
import {
  ADSENSE_LOW_SAMPLE_REQUESTS,
  GA4_AD_EVENT_DIMENSIONS,
  GA4_AD_PAGE_DIAG_DIMENSIONS,
  GA4_AD_PAGE_DIAG_EVENTS,
  GA4_AD_PAGE_DIAG_METRICS,
  GA4_AD_PAGE_DIAG_QUERY_METRICS,
  GA4_AD_PAGE_DIAG_UNQUERIED_METRICS,
  GA4_LIFECYCLE_EVENTS,
  GA4_LOW_SAMPLE_EVENTS,
  GA4_OFFERWALL_SNAPSHOT_EVENTS,
  GA4_OFFERWALL_SNAPSHOT_METRICS,
  GA4_REPORT_ROW_LIMIT,
  buildAdsenseUnitReport,
  buildGa4Rows,
  buildLifecycleSummary,
  buildSnapshotRows,
  ga4ReportCompleteness,
  renderAdsPerformanceMarkdown,
  resolveAdsReportWindow,
} from './lib/ads-performance-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, '..');
const SITE_DOMAIN = 'frontaliereticino.ch';
const GOOGLE_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADSENSE_API = 'https://adsense.googleapis.com/v2';
const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
const REQUESTED_GA4_EVENTS = [
  ...GA4_LIFECYCLE_EVENTS.map((event) => event.name),
  ...GA4_OFFERWALL_SNAPSHOT_EVENTS,
  ...GA4_AD_PAGE_DIAG_EVENTS,
];

export function parseCliArgs(args = process.argv.slice(2), now = new Date()) {
  const options = { days: 30, format: 'markdown', save: false, help: false };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--markdown') options.format = 'markdown';
    else if (arg === '--save') options.save = true;
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice('--days='.length));
    else if (arg.startsWith('--start=')) options.startDate = arg.slice('--start='.length);
    else if (arg.startsWith('--end=')) options.endDate = arg.slice('--end='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help) options.window = resolveAdsReportWindow({ ...options, now });
  return options;
}

function timeoutSignal() {
  return AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);
}

function httpError(label, status) {
  const error = new Error(`${label}: HTTP ${status}`);
  error.status = status;
  return error;
}

async function readResponse(response, label) {
  if (!response.ok) throw httpError(label, response.status);
  return response.json();
}

function adSenseAccountName() {
  return resolveAdSenseAccount();
}

export async function fetchAdsenseData({
  window,
  fetchImpl = fetch,
  getTokenImpl = getAdSenseToken,
} = {}) {
  let token;
  try {
    token = await getTokenImpl();
  } catch {
    return { status: 'unavailable', dataStatus: 'missing', error: 'AdSense OAuth token refresh failed', rows: [] };
  }
  if (!token) {
    return { status: 'missing_credentials', dataStatus: 'missing', error: 'AdSense OAuth credentials are not configured', rows: [] };
  }

  const account = adSenseAccountName();
  let metadata;
  try {
    const response = await fetchImpl(`${ADSENSE_API}/${account}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(),
    });
    metadata = await readResponse(response, 'AdSense account request');
  } catch (error) {
    const detail = error.status ? `AdSense account API returned HTTP ${error.status}` : 'AdSense account request failed or timed out';
    return { status: 'unavailable', dataStatus: 'missing', error: detail, rows: [] };
  }

  try {
    const report = await fetchManualSlotReport({
      token,
      account,
      start: window.start,
      end: window.end,
      domain: SITE_DOMAIN,
      accountTimeZone: metadata.timeZone?.id || null,
      fetchImpl,
    });
    return buildAdsenseUnitReport(report);
  } catch (error) {
    const reason = String(error?.message || 'AdSense unit report failed').slice(0, 240);
    const isIncomplete = /truncated|completeness unknown|date window differs|missing column|missing earnings currency/i.test(reason);
    return {
      status: isIncomplete ? 'partial' : 'unavailable',
      dataStatus: 'missing',
      account,
      domain: SITE_DOMAIN,
      currencyCode: null,
      window: {
        start: window.start,
        end: window.end,
        inclusive: true,
        settled: window.settled,
        accountTimeZone: metadata.timeZone?.id || null,
      },
      error: reason,
      rows: [],
    };
  }
}

async function fetchGa4Metadata(property, headers, fetchImpl) {
  const response = await fetchImpl(`${GOOGLE_API}/${property}/metadata`, {
    headers,
    signal: timeoutSignal(),
  });
  return readResponse(response, 'GA4 metadata request');
}

async function checkGa4Compatibility(property, dimensions, metrics, headers, fetchImpl) {
  const response = await fetchImpl(`${GOOGLE_API}/${property}:checkCompatibility`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dimensions: dimensions.map((name) => ({ name })), metrics: metrics.map((name) => ({ name })) }),
    signal: timeoutSignal(),
  });
  return readResponse(response, 'GA4 checkCompatibility request');
}

function compatibleSchema(response, dimensionNames, metricNames) {
  const dimensions = new Map((response.dimensionCompatibilities || []).map((entry) => [
    entry.dimensionMetadata?.apiName,
    entry.compatibility,
  ]));
  const metrics = new Map((response.metricCompatibilities || []).map((entry) => [
    entry.metricMetadata?.apiName,
    entry.compatibility,
  ]));
  return {
    dimensions: dimensionNames.filter((name) => dimensions.get(name) === 'COMPATIBLE'),
    metrics: metricNames.filter((name) => metrics.get(name) === 'COMPATIBLE'),
    incompatibleDimensions: dimensionNames.filter((name) => dimensions.get(name) === 'INCOMPATIBLE'),
    incompatibleMetrics: metricNames.filter((name) => metrics.get(name) === 'INCOMPATIBLE'),
    unknownDimensions: dimensionNames.filter((name) => !dimensions.has(name)),
    unknownMetrics: metricNames.filter((name) => !metrics.has(name)),
  };
}

async function runGa4Report(property, body, headers, fetchImpl, label) {
  const response = await fetchImpl(`${GOOGLE_API}/${property}:runReport`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  });
  return readResponse(response, label);
}

function normalizePropertyId(raw) {
  const property = raw || DEFAULT_GA4_PROPERTY_ID;
  return property.startsWith('properties/') ? property : `properties/${property}`;
}

function getAvailableCustomNames(apiList = []) {
  return new Set(apiList.map((item) => item.apiName).filter(Boolean));
}

function safeApiError(error, prefix) {
  return error?.status ? `${prefix} returned HTTP ${error.status}` : `${prefix} failed or timed out`;
}

export async function fetchGa4Data({
  window,
  fetchImpl = fetch,
  getTokenImpl = () => getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {}, logError: () => {} }),
  propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID,
} = {}) {
  let token;
  try {
    token = await getTokenImpl();
  } catch {
    return { status: 'unavailable', error: 'GA4 service-account token could not be acquired' };
  }
  if (!token) return { status: 'missing_credentials', error: 'GA4 service-account credentials are not configured' };

  const property = normalizePropertyId(propertyId);
  const headers = { Authorization: `Bearer ${token}` };
  let metadata = null;
  let metadataStatus = 'unavailable';
  try {
    metadata = await fetchGa4Metadata(property, headers, fetchImpl);
    metadataStatus = 'available';
  } catch {
    // Continue with built-in dimensions so a metadata API outage does not hide lifecycle totals.
  }

  const availableDimensions = getAvailableCustomNames(metadata?.dimensions);
  const availableMetrics = getAvailableCustomNames(metadata?.metrics);
  const requestedDimensions = ['eventName', 'deviceCategory', ...(metadataStatus === 'available'
    ? GA4_AD_EVENT_DIMENSIONS.filter((name) => name.startsWith('customEvent:') && availableDimensions.has(name))
    : [])];
  const customDimensions = GA4_AD_EVENT_DIMENSIONS
    .filter((name) => name.startsWith('customEvent:') && !availableDimensions.has(name));
  const missingCustomDimensions = metadataStatus === 'available' ? customDimensions : [];
  const unknownCustomDimensions = metadataStatus === 'available' ? [] : customDimensions;
  const missingSnapshotMetrics = metadataStatus === 'available'
    ? GA4_OFFERWALL_SNAPSHOT_METRICS.filter((name) => !availableMetrics.has(name)) : [];
  const unknownSnapshotMetrics = metadataStatus === 'available' ? [] : GA4_OFFERWALL_SNAPSHOT_METRICS;
  const missingAdPageDiagMetrics = metadataStatus === 'available'
    ? GA4_AD_PAGE_DIAG_METRICS.filter((name) => !availableMetrics.has(name)) : [];
  const unknownAdPageDiagMetrics = metadataStatus === 'available' ? [] : GA4_AD_PAGE_DIAG_METRICS;

  let compatibilityStatus = 'available';
  let lifecycleDimensions = requestedDimensions;
  let lifecycleCanQuery = false;
  try {
    const response = await checkGa4Compatibility(property, requestedDimensions, ['eventCount'], headers, fetchImpl);
    const compatible = compatibleSchema(response, requestedDimensions, ['eventCount']);
    lifecycleDimensions = compatible.dimensions;
    if (compatible.incompatibleDimensions.length || compatible.incompatibleMetrics.length
      || compatible.unknownDimensions.length || compatible.unknownMetrics.length) compatibilityStatus = 'partial';
    lifecycleCanQuery = lifecycleDimensions.includes('eventName') && compatible.metrics.includes('eventCount');
  } catch {
    lifecycleDimensions = ['eventName', 'deviceCategory'];
    compatibilityStatus = 'unavailable_fallback_to_builtins';
    lifecycleCanQuery = true;
  }
  if (!lifecycleCanQuery) {
    return { status: 'unavailable', property, compatibilityStatus, error: 'GA4 eventName/eventCount compatibility is missing or incompatible' };
  }
  const missingDimensions = metadataStatus === 'available'
    ? GA4_AD_EVENT_DIMENSIONS.filter((name) => !lifecycleDimensions.includes(name)) : [];
  const unknownDimensions = metadataStatus === 'available' ? [] : customDimensions;

  const lifecycleBody = {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: lifecycleDimensions.map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: REQUESTED_GA4_EVENTS, caseSensitive: true } } },
    orderBys: [{ dimension: { dimensionName: 'eventName' } }, { metric: { metricName: 'eventCount' }, desc: true }],
    limit: GA4_REPORT_ROW_LIMIT,
  };

  let lifecycleData;
  try {
    lifecycleData = await runGa4Report(property, lifecycleBody, headers, fetchImpl, 'GA4 ad lifecycle report');
  } catch (error) {
    return { status: 'unavailable', property, error: safeApiError(error, 'GA4 ad lifecycle report') };
  }
  const lifecycleRows = buildGa4Rows(lifecycleData, lifecycleDimensions);
  const lifecycleQualityBase = ga4ReportCompleteness(lifecycleData);
  const lifecycleHasMissingCounts = lifecycleRows.some((row) => row.eventName && row.eventCount === null);
  const lifecycleQuality = {
    ...lifecycleQualityBase,
    complete: lifecycleQualityBase.complete && !lifecycleHasMissingCounts,
    warnings: lifecycleHasMissingCounts
      ? [...lifecycleQualityBase.warnings, 'GA4 returned rows with missing eventCount values']
      : lifecycleQualityBase.warnings,
  };
  const lifecycle = buildLifecycleSummary(lifecycleRows, { complete: lifecycleQuality.complete });

  const offerwallSnapshots = await fetchAggregateSection({
    property,
    window,
    headers,
    fetchImpl,
    eventNames: GA4_OFFERWALL_SNAPSHOT_EVENTS,
    candidateDimensions: ['eventName', 'deviceCategory'],
    candidateMetrics: ['eventCount', ...GA4_OFFERWALL_SNAPSHOT_METRICS],
    knownMissingMetrics: missingSnapshotMetrics,
    unqueriedMetrics: [],
    metadataStatus,
    availableDimensions,
    availableMetrics,
    sectionName: 'GA4 Offerwall snapshot report',
    renderDimensions: ['eventName', 'deviceCategory'],
  });

  const adPageDiag = await fetchAggregateSection({
    property,
    window,
    headers,
    fetchImpl,
    eventNames: GA4_AD_PAGE_DIAG_EVENTS,
    candidateDimensions: ['eventName', 'deviceCategory', ...GA4_AD_PAGE_DIAG_DIMENSIONS.filter((name) => name.startsWith('customEvent:') && availableDimensions.has(name))],
    candidateMetrics: ['eventCount', ...GA4_AD_PAGE_DIAG_QUERY_METRICS],
    knownMissingMetrics: missingAdPageDiagMetrics,
    unqueriedMetrics: metadataStatus === 'available'
      ? GA4_AD_PAGE_DIAG_UNQUERIED_METRICS.filter((name) => availableMetrics.has(name)) : [],
    metadataStatus,
    availableDimensions,
    availableMetrics,
    sectionName: 'GA4 ad page diagnostics report',
    renderDimensions: GA4_AD_PAGE_DIAG_DIMENSIONS,
  });

  const partial = metadataStatus !== 'available'
    || missingDimensions.some((name) => name.startsWith('customEvent:'))
    || compatibilityStatus !== 'available'
    || !lifecycleQuality.complete
    || offerwallSnapshots.status !== 'ok'
    || adPageDiag.status !== 'ok';
  return {
    status: partial ? 'partial' : 'ok',
    property,
    metadataStatus,
    compatibilityStatus,
    availableDimensions: lifecycleDimensions,
    missingDimensions,
    unknownDimensions,
    missingCustomDimensions,
    unknownCustomDimensions,
    missingSnapshotMetrics,
    unknownSnapshotMetrics,
    missingAdPageDiagMetrics,
    unknownAdPageDiagMetrics,
    lifecycle,
    dimensions: lifecycleRows,
    ...lifecycleQuality,
    completenessWarnings: lifecycleQuality.warnings,
    offerwallSnapshots,
    adPageDiag,
    limitations: [
      'Event counts are aggregate counts, not unique requests or event cohorts.',
      'No pagePath, job/company identifier or request_id dimension is requested.',
      'AdSense measurable and viewable ratios are not converted into counts.',
      'Offerwall snapshots and ad_page_diag remain separate aggregate diagnostics.',
    ],
  };
}

async function fetchAggregateSection({
  property,
  window,
  headers,
  fetchImpl,
  eventNames,
  candidateDimensions,
  candidateMetrics,
  knownMissingMetrics = [],
  unqueriedMetrics = [],
  metadataStatus,
  availableDimensions,
  availableMetrics,
  sectionName,
  renderDimensions,
}) {
  const requestedDimensions = [...candidateDimensions];
  const requestedMetrics = [...candidateMetrics];
  let dimensions = requestedDimensions.filter((name) => !name.startsWith('customEvent:') || availableDimensions.has(name));
  let metrics = requestedMetrics.filter((name) => !name.startsWith('customEvent:') || availableMetrics.has(name));
  let compatibilityStatus = 'available';
  try {
    const compatible = await checkGa4Compatibility(property, dimensions, metrics, headers, fetchImpl);
    const selected = compatibleSchema(compatible, dimensions, metrics);
    dimensions = selected.dimensions;
    metrics = selected.metrics;
    if (selected.incompatibleDimensions.length || selected.incompatibleMetrics.length
      || selected.unknownDimensions.length || selected.unknownMetrics.length) compatibilityStatus = 'partial';
  } catch {
    dimensions = dimensions.filter((name) => !name.startsWith('customEvent:'));
    metrics = metrics.filter((name) => name === 'eventCount');
    compatibilityStatus = 'unavailable_fallback_to_builtins';
  }

  if (!dimensions.includes('eventName') || !metrics.includes('eventCount')) {
    return { status: 'unavailable', compatibilityStatus, error: `${sectionName}: eventName/eventCount compatibility missing or incompatible`, rows: [] };
  }
  const body = {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: eventNames, caseSensitive: true } } },
    orderBys: [{ dimension: { dimensionName: 'eventName' } }, { metric: { metricName: 'eventCount' }, desc: true }],
    limit: GA4_REPORT_ROW_LIMIT,
  };
  try {
    const data = await runGa4Report(property, body, headers, fetchImpl, sectionName);
    const parsedRows = buildGa4Rows(data, dimensions, metrics);
    const qualityBase = ga4ReportCompleteness(data);
    const customMetricNames = metrics.filter((name) => name.startsWith('customEvent:'));
    const renderedCustomDimensions = renderDimensions.filter((name) => name.startsWith('customEvent:') && dimensions.includes(name));
    const metricValuesMissing = customMetricNames.filter((name) => parsedRows.some((row) => {
      const value = row.customMetrics?.[name.slice('customEvent:'.length)];
      return value === null || value === undefined || value === '';
    }));
    const eventCountMissing = parsedRows.some((row) => eventNames.includes(row.eventName) && row.eventCount === null);
    const quality = {
      ...qualityBase,
      complete: qualityBase.complete && !eventCountMissing && metricValuesMissing.length === 0,
      warnings: [
        ...qualityBase.warnings,
        ...(eventCountMissing ? ['GA4 returned rows with missing eventCount values'] : []),
        ...(metricValuesMissing.length ? ['GA4 returned rows with missing custom metric values'] : []),
      ],
    };
    const metadataMissingMetrics = metadataStatus === 'available'
      ? requestedMetrics.filter((name) => name.startsWith('customEvent:') && !customMetricNames.includes(name)) : [];
    const missingMetrics = [...new Set([...knownMissingMetrics, ...metadataMissingMetrics, ...metricValuesMissing])];
    const unknownMetrics = metadataStatus === 'available' ? []
      : requestedMetrics.filter((name) => name.startsWith('customEvent:'));
    const missingDimensions = metadataStatus === 'available'
      ? renderDimensions.filter((name) => name.startsWith('customEvent:') && !dimensions.includes(name)) : [];
    const unknownDimensions = metadataStatus === 'available' ? []
      : renderDimensions.filter((name) => name.startsWith('customEvent:'));
    const rows = buildSnapshotRows(parsedRows, eventNames, customMetricNames, {
      complete: quality.complete,
      dimensions: ['eventName', ...dimensions.filter((name) => name !== 'eventName')],
      ...(renderedCustomDimensions.length ? {} : { sourceAvailable: true }),
    });
    const status = quality.complete && metadataStatus === 'available' && compatibilityStatus === 'available'
      && missingMetrics.length === 0 && unqueriedMetrics.length === 0
      ? 'ok' : 'partial';
    return {
      status,
      ...quality,
      compatibilityStatus,
      availableDimensions: dimensions,
      availableMetrics: metrics,
      missingDimensions,
      unknownDimensions,
      missingMetrics,
      missingMetricValues: metricValuesMissing,
      unknownMetrics,
      unqueriedMetrics,
      rows,
      ...(eventNames[0] === 'rewarded_offer_ads_open' ? {
        note: 'Separate aggregate snapshots; no session, click, request_id or Offerwall outcome join is performed or inferred.',
      } : {}),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      error: safeApiError(error, sectionName),
      rows: buildSnapshotRows([], eventNames, [], { sourceAvailable: false }),
    };
  }
}

export async function buildAdsPerformanceReport({ window, fetchImpl = fetch } = {}) {
  const [adsense, ga4] = await Promise.all([
    fetchAdsenseData({ window, fetchImpl }),
    fetchGa4Data({ window, fetchImpl }),
  ]);
  const sourceAvailable = (source) => source.status === 'ok' || source.status === 'partial';
  const availableSources = Number(sourceAvailable(adsense)) + Number(sourceAvailable(ga4));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window,
    thresholds: {
      adsenseRequestsLowSampleBelow: ADSENSE_LOW_SAMPLE_REQUESTS,
      ga4EventsLowSampleBelow: GA4_LOW_SAMPLE_EVENTS,
      interpretation: 'Low-sample labels are descriptive volume thresholds, not statistical significance tests.',
    },
    adsense,
    ga4,
    status: availableSources === 2
      ? (adsense.status === 'ok' && ga4.status === 'ok' ? 'ok' : 'partial')
      : availableSources === 1 ? 'partial' : 'unavailable',
  };
}

function helpText() {
  return [
    'Usage: node scripts/ads-performance-report.mjs [--days=1..366 | --start=YYYY-MM-DD --end=YYYY-MM-DD] [--json|--markdown] [--save]',
    'The end date is inclusive and must be at least two days old.',
    '--save writes a local Markdown and JSON report under the gitignored reports/ directory.',
  ].join('\n');
}

async function main(args = process.argv.slice(2)) {
  const options = parseCliArgs(args);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return { status: 'help' };
  }
  const report = await buildAdsPerformanceReport({ window: options.window });
  const markdown = renderAdsPerformanceMarkdown(report);
  process.stdout.write(`${options.format === 'json' ? JSON.stringify(report, null, 2) : markdown}\n`);

  if (options.save) {
    const outDir = resolve(SITE_ROOT, 'reports');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(resolve(outDir, `ads-performance-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(resolve(outDir, `ads-performance-${stamp}.md`), `${markdown}\n`);
  }
  if (report.status === 'unavailable') process.exitCode = 1;
  return report;
}

const invokedDirectly = process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`ads-performance-report failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
