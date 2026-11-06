import {
  countInclusiveUtcDays,
  fmtUtcDate,
  settledEndDate,
  settledWindow,
} from './analytics-settled-window.mjs';
import { AD_PAGE_DIAG_GA4_CUSTOM_METRICS } from './ga4-ad-page-diag-definitions.mjs';
import { OFFER_ADS_SNAPSHOT_GA4_CUSTOM_METRICS } from './ga4-offer-ads-snapshot-definitions.mjs';

export const ADSENSE_LOW_SAMPLE_REQUESTS = 1_000;
export const GA4_LOW_SAMPLE_EVENTS = 100;
export const GA4_REPORT_ROW_LIMIT = 1_000;

export const GA4_LIFECYCLE_EVENTS = Object.freeze([
  Object.freeze({ name: 'ad_request', stage: 'request', instrumentation: 'manual AdSense slot request; request_id is excluded' }),
  Object.freeze({ name: 'ad_waiting', stage: 'waiting_for_response', instrumentation: 'manual slot response deadline; not a no-fill verdict' }),
  Object.freeze({ name: 'ad_filled', stage: 'fill', instrumentation: 'manual AdSense and GPT slot fill events' }),
  Object.freeze({ name: 'ad_unfilled', stage: 'unfilled', instrumentation: 'manual AdSense reports data-ad-status=unfilled' }),
  Object.freeze({ name: 'ad_collapsed', stage: 'collapsed', instrumentation: 'manual AdSense and GPT collapsed slots' }),
  Object.freeze({ name: 'ad_measurable', stage: 'measurable', instrumentation: 'manual iframe geometry; not AdSense Active View measurability' }),
  Object.freeze({ name: 'ad_viewable', stage: 'viewable', instrumentation: 'manual 50%/1s and GPT viewability events; network distinguishes where registered' }),
]);

export const GA4_OFFERWALL_SNAPSHOT_EVENTS = Object.freeze([
  'rewarded_offer_ads_open',
  'rewarded_offer_ads_offerwall',
  'rewarded_offer_ads_return',
]);

export const GA4_AD_PAGE_DIAG_EVENTS = Object.freeze(['ad_page_diag']);

export const GA4_AD_EVENT_DIMENSIONS = Object.freeze([
  'deviceCategory',
  'customEvent:slot',
  'customEvent:placement',
  'customEvent:render_path',
  'customEvent:page_template',
  'customEvent:network',
]);

export const GA4_OFFERWALL_SNAPSHOT_METRICS = Object.freeze(
  OFFER_ADS_SNAPSHOT_GA4_CUSTOM_METRICS.map(({ parameterName }) => `customEvent:${parameterName}`),
);

export const GA4_AD_PAGE_DIAG_DIMENSIONS = Object.freeze([
  'deviceCategory',
  'customEvent:page_template',
  'customEvent:ad_path',
]);

export const GA4_AD_PAGE_DIAG_METRICS = Object.freeze(
  AD_PAGE_DIAG_GA4_CUSTOM_METRICS.map(({ parameterName }) => `customEvent:${parameterName}`),
);

// runReport accepts at most 10 metrics. Keep eventCount plus this bounded P0
// diagnostic set; the remaining registered metrics are listed as unqueried.
const AD_PAGE_DIAG_QUERY_METRIC_NAMES = Object.freeze([
  'slots_total',
  'slots_filled',
  'slots_unfilled',
  'slots_collapsed',
  'auto_placed',
  'vignette_ready',
  'first_fill_ms',
  'cmp_shown',
  'ad_blocked',
]);
export const GA4_AD_PAGE_DIAG_QUERY_METRICS = Object.freeze(
  AD_PAGE_DIAG_QUERY_METRIC_NAMES.map((name) => `customEvent:${name}`),
);
export const GA4_AD_PAGE_DIAG_UNQUERIED_METRICS = Object.freeze(
  GA4_AD_PAGE_DIAG_METRICS.filter((name) => !GA4_AD_PAGE_DIAG_QUERY_METRICS.includes(name)),
);

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return fmtUtcDate(parsed) === value ? parsed : null;
}

/** Build an inclusive report window that ends at least `lagDays` before now. */
export function resolveAdsReportWindow({ startDate, endDate, days = 30, now = new Date(), lagDays = 2 } = {}) {
  const hasStart = startDate !== undefined && startDate !== null;
  const hasEnd = endDate !== undefined && endDate !== null;
  if (hasStart !== hasEnd) throw new Error('provide both --start and --end, or neither');

  let window;
  if (hasStart) {
    const start = parseIsoDate(startDate);
    const end = parseIsoDate(endDate);
    if (!start || !end) throw new Error('dates must use a valid YYYY-MM-DD format');
    if (end < start) throw new Error('--end must be on or after --start');
    const latestSettled = settledEndDate(now, lagDays);
    if (end > latestSettled) {
      throw new Error(`--end must be on or before ${fmtUtcDate(latestSettled)} (${lagDays}-day processing lag)`);
    }
    window = { start: startDate, end: endDate };
  } else {
    const dayCount = Number(days);
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 366) {
      throw new Error('--days must be an integer from 1 to 366');
    }
    window = settledWindow({ days: dayCount, now, lagDays });
  }

  const inclusiveDays = countInclusiveUtcDays(window.start, window.end);
  if (!inclusiveDays) throw new Error('report window is invalid');
  return {
    start: window.start,
    end: window.end,
    inclusive: true,
    settled: true,
    processingLagDays: lagDays,
    inclusiveDays,
    dateBasis: 'UTC calendar dates; each API uses its own reporting time zone',
  };
}

/** Missing, zero and low-sample values remain distinct. Low-sample is descriptive only. */
export function classifyMetricValue(value, {
  available = true,
  sampleSize = null,
  lowSampleBelow = null,
} = {}) {
  if (!available || value === null || value === undefined || value === '') return 'missing';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'missing';
  if (number === 0) return 'zero';
  if (lowSampleBelow !== null && lowSampleBelow !== undefined && sampleSize !== null && sampleSize !== undefined) {
    const sample = Number(sampleSize);
    if (Number.isFinite(sample) && sample < lowSampleBelow) return 'low_sample';
  }
  return 'available';
}

/** Add explicit status fields to the validated, complete AdSense helper result. */
export function buildAdsenseUnitReport(report, { lowSampleRequests = ADSENSE_LOW_SAMPLE_REQUESTS } = {}) {
  if (!report || !['complete', 'complete_with_warnings'].includes(report.status)) {
    return { status: 'unavailable', dataStatus: 'missing', error: report?.reason || 'AdSense unit report unavailable', rows: [] };
  }
  const rows = (report.rows || []).map((row) => ({
    slotId: row.slot,
    adUnitId: row.adUnitId,
    adUnitName: row.adUnitName,
    device: row.device,
    domain: row.domain,
    surfaceAliases: row.placements,
    surfaceAttribution: row.sharedUnit ? 'shared_registry_aliases' : row.registeredManualUnit ? 'registry_alias' : 'unmapped_unit',
    requests: row.requests,
    matchedRequests: row.matched,
    impressions: row.impressions,
    measurabilityRatio: row.measurableRatio,
    viewabilityRatio: row.viewableRatio,
    measurableCount: null,
    viewableCount: null,
    estimatedEarnings: row.estimatedEarnings,
    currencyCode: row.currencyCode,
    requestSampleStatus: classifyMetricValue(row.requests, {
      sampleSize: row.requests,
      lowSampleBelow: lowSampleRequests,
    }),
    matchedRequestsStatus: classifyMetricValue(row.matched),
    impressionsStatus: classifyMetricValue(row.impressions),
    measurabilityStatus: classifyMetricValue(row.measurableRatio),
    viewabilityStatus: classifyMetricValue(row.viewableRatio),
    revenueStatus: classifyMetricValue(row.estimatedEarnings),
  }));
  const status = report.status === 'complete_with_warnings' ? 'partial' : 'ok';
  return {
    status,
    dataStatus: rows.length ? 'available' : 'zero',
    source: report.source,
    sourceUrl: report.sourceUrl,
    account: report.account,
    domain: report.domain,
    currencyCode: report.currencyCode,
    window: report.window,
    fetchedAt: report.fetchedAt,
    returnedRows: report.returnedRows,
    totalMatchedRows: report.totalMatchedRows,
    complete: report.status === 'complete',
    warnings: report.warnings,
    dimensions: report.dimensions,
    metrics: report.metrics,
    rows,
    attributionLimit: report.attributionLimit,
    revenueBasis: report.revenueBasis,
    metricLimit: report.activeViewCountAvailability,
  };
}

function parseRowCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function buildGa4Rows(data, dimensionNames, metricNames = ['eventCount'], {
  lowSampleEvents = GA4_LOW_SAMPLE_EVENTS,
} = {}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return rows.map((row) => {
    const values = Object.fromEntries(dimensionNames.map((name, index) => [
      name,
      row?.dimensionValues?.[index]?.value ?? null,
    ]));
    const metrics = Object.fromEntries(metricNames.map((name, index) => {
      const raw = row?.metricValues?.[index]?.value;
      const number = raw === undefined || raw === null || raw === '' ? null : Number(raw);
      return [name, Number.isFinite(number) ? number : null];
    }));
    const eventCount = metrics.eventCount;
    return {
      eventName: values.eventName || null,
      device: values.deviceCategory || null,
      slot: values['customEvent:slot'] || null,
      placement: values['customEvent:placement'] || null,
      renderPath: values['customEvent:render_path'] || null,
      pageTemplate: values['customEvent:page_template'] || null,
      adPath: values['customEvent:ad_path'] || null,
      network: values['customEvent:network'] || null,
      eventCount,
      eventCountStatus: classifyMetricValue(eventCount, {
        sampleSize: eventCount,
        lowSampleBelow: lowSampleEvents,
      }),
      customMetrics: Object.fromEntries(metricNames
        .filter((name) => name.startsWith('customEvent:'))
        .map((name) => [name.slice('customEvent:'.length), metrics[name]])),
    };
  });
}

export function buildLifecycleSummary(rows, {
  sourceAvailable = true,
  complete = true,
  lowSampleEvents = GA4_LOW_SAMPLE_EVENTS,
} = {}) {
  const counts = new Map();
  const incompleteEvents = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.eventName) continue;
    if (row.eventCount === null || row.eventCount === undefined || row.eventCount === ''
      || !Number.isFinite(Number(row.eventCount))) {
      incompleteEvents.add(row.eventName);
      continue;
    }
    counts.set(row.eventName, (counts.get(row.eventName) || 0) + Number(row.eventCount));
  }
  return GA4_LIFECYCLE_EVENTS.map((definition) => {
    const eventComplete = sourceAvailable && complete && !incompleteEvents.has(definition.name);
    const count = !sourceAvailable ? null
      : incompleteEvents.has(definition.name) ? null
        : counts.has(definition.name) ? counts.get(definition.name)
          : complete ? 0 : null;
    return {
      ...definition,
      eventCount: count,
      dataStatus: classifyMetricValue(count, {
        available: sourceAvailable,
        sampleSize: count,
        lowSampleBelow: lowSampleEvents,
      }),
      completenessStatus: eventComplete ? 'complete' : 'partial',
    };
  });
}

/** Aggregate snapshot metrics by event and device; no user, click, or request join. */
export function buildSnapshotRows(rows, eventNames, metricNames, {
  sourceAvailable = true,
  complete = true,
  lowSampleEvents = GA4_LOW_SAMPLE_EVENTS,
  dimensions = ['eventName', 'deviceCategory'],
} = {}) {
  const entries = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!eventNames.includes(row?.eventName)) continue;
    const key = `${row.eventName}\u0000${row.device || '(not set)'}\u0000${row.pageTemplate || '(not set)'}\u0000${row.adPath || '(not set)'}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        eventName: row.eventName,
        device: dimensions.includes('deviceCategory') ? (row.device || '(not set)') : null,
        pageTemplate: dimensions.includes('customEvent:page_template') ? row.pageTemplate : null,
        adPath: dimensions.includes('customEvent:ad_path') ? row.adPath : null,
        eventCount: 0,
        eventCountObserved: false,
        eventCountMissing: false,
        sums: {},
        missingMetrics: new Set(),
      };
      entries.set(key, entry);
    }
    if (row.eventCount !== null && row.eventCount !== undefined && row.eventCount !== ''
      && Number.isFinite(Number(row.eventCount))) {
      entry.eventCount += Number(row.eventCount);
      entry.eventCountObserved = true;
    } else {
      entry.eventCountMissing = true;
    }
    for (const metricName of metricNames) {
      const field = metricName.slice('customEvent:'.length);
      const value = row.customMetrics?.[field];
      if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
        entry.sums[field] = (entry.sums[field] || 0) + Number(value);
      } else {
        entry.missingMetrics.add(field);
      }
    }
  }

  const groups = eventNames.flatMap((eventName) => {
    const observed = [...entries.values()].filter((row) => row.eventName === eventName);
    if (!sourceAvailable) return [{ eventName, device: null, eventCount: null, eventCountStatus: 'missing', averages: {} }];
    if (observed.length === 0) return [{
      eventName,
      device: null,
      eventCount: complete ? 0 : null,
      eventCountStatus: complete ? 'zero' : 'missing',
      completenessStatus: complete ? 'complete' : 'partial',
      averages: Object.fromEntries(metricNames.map((name) => [name.slice('customEvent:'.length), {
        value: null,
        status: 'missing',
        aggregation: 'custom_metric_sum / eventCount; aggregate mean only',
      }])),
    }];
    return observed.map((row) => {
      const eventCount = row.eventCountObserved && !row.eventCountMissing ? row.eventCount : null;
      const rowComplete = complete && eventCount !== null;
      return {
        eventName,
        device: row.device,
        pageTemplate: row.pageTemplate,
        adPath: row.adPath,
        eventCount,
        eventCountStatus: classifyMetricValue(eventCount, {
          sampleSize: eventCount,
          lowSampleBelow: lowSampleEvents,
        }),
        completenessStatus: rowComplete ? 'complete' : 'partial',
        averages: Object.fromEntries(metricNames.map((metricName) => {
          const field = metricName.slice('customEvent:'.length);
          const sum = row.sums[field];
          const isFirstFillMetric = field === 'first_fill_ms';
          const value = !isFirstFillMetric && eventCount !== null && eventCount > 0
            && sum !== undefined && !row.missingMetrics.has(field)
            ? Number((sum / eventCount).toFixed(3)) : null;
          return [field, {
            value,
            status: classifyMetricValue(value),
            aggregation: isFirstFillMetric
              ? 'withheld: aggregate data cannot exclude the -1 no-fill sentinel from the mean'
              : 'custom_metric_sum / eventCount; aggregate mean only',
          }];
        })),
      };
    });
  });
  return groups;
}

export function ga4ReportCompleteness(data, returnedRows = Array.isArray(data?.rows) ? data.rows.length : 0) {
  const metadata = data?.metadata || {};
  const rowCount = parseRowCount(data?.rowCount);
  const warnings = [];
  if (rowCount === null) warnings.push('GA4 rowCount is unavailable; completeness is unknown');
  else if (rowCount !== returnedRows) warnings.push(rowCount > returnedRows
    ? 'rowCount exceeds returned rows; results are truncated'
    : 'rowCount is lower than returned rows; report completeness is inconsistent');
  if (metadata.dataLossFromOtherRow) warnings.push('GA4 grouped lower-volume values into the other row');
  if (metadata.subjectToThresholding) warnings.push('GA4 applied thresholding');
  if (Array.isArray(metadata.dataTruncationReasons) && metadata.dataTruncationReasons.length) {
    warnings.push('GA4 reported data truncation');
  }
  if (Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.some((sample) => {
    const read = Number(sample.samplesReadCount);
    const space = Number(sample.samplingSpaceSize);
    return Number.isFinite(read) && Number.isFinite(space) && read < space;
  })) warnings.push('GA4 sampled the report');
  return {
    complete: warnings.length === 0,
    returnedRows,
    rowCount,
    rowLimit: GA4_REPORT_ROW_LIMIT,
    warnings,
  };
}

export function renderAdsPerformanceMarkdown(report) {
  const out = [
    '# Ads performance report',
    '',
    `Window: **${report.window.start}–${report.window.end}** (inclusive, settled; ${report.window.inclusiveDays} days).`,
    `Generated: ${report.generatedAt}.`,
    '',
    '## AdSense estimated earnings by unit, device and surface aliases',
    '',
  ];

  const adsense = report.adsense;
  out.push(`Source status: **${adsense.status}**; data status: **${adsense.dataStatus || 'missing'}**.`);
  if (adsense.window?.accountTimeZone) out.push(`AdSense account time zone: ${adsense.window.accountTimeZone}.`);
  if (adsense.currencyCode) out.push(`AdSense earnings currency: ${adsense.currencyCode}.`);
  if (adsense.error) out.push(`Unavailable detail: ${adsense.error}.`);
  if (adsense.warnings?.length) out.push(`AdSense warnings: ${adsense.warnings.join('; ')}.`);
  if (adsense.rows?.length) {
    out.push('', '| Unit | Device | Domain | Registry surface aliases | Requests | Matched | Impressions | Measurability | Viewability | Estimated earnings | Request sample |',
      '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const row of adsense.rows) {
      out.push(`| ${escapeCell(row.adUnitName || row.slotId || 'Unknown')} (${escapeCell(row.slotId || 'n/a')})` +
        ` | ${escapeCell(row.device || 'missing')} | ${escapeCell(row.domain || 'missing')}` +
        ` | ${escapeCell(row.surfaceAliases.length ? row.surfaceAliases.join(', ') : 'unmapped')}` +
        ` | ${formatValue(row.requests)} | ${formatValue(row.matchedRequests)} | ${formatValue(row.impressions)}` +
        ` | ${formatPercent(row.measurabilityRatio)} | ${formatPercent(row.viewabilityRatio)}` +
        ` | ${formatMoney(row.estimatedEarnings, row.currencyCode)} | ${row.requestSampleStatus} |`);
    }
  }
  if (adsense.attributionLimit) out.push('', adsense.attributionLimit);
  if (adsense.revenueBasis) out.push(adsense.revenueBasis);
  if (adsense.metricLimit) out.push(adsense.metricLimit);

  const ga4 = report.ga4;
  out.push('', '## GA4 ad lifecycle', '', `Source status: **${ga4.status}**.`);
  if (ga4.metadataStatus !== 'available') {
    out.push('GA4 metadata discovery unavailable; custom dimension and metric availability is unknown.');
  }
  if (ga4.error) out.push(`Unavailable detail: ${ga4.error}.`);
  if (ga4.lifecycle?.length) {
    out.push('', '| Event | Stage | Event count | Data status | Completeness | Instrumentation |',
      '|---|---|---:|---|---|---|');
    for (const row of ga4.lifecycle) {
      out.push(`| ${row.name} | ${row.stage} | ${formatValue(row.eventCount)} | ${row.dataStatus} | ${row.completenessStatus} | ${row.instrumentation} |`);
    }
    out.push('', 'GA4 event counts are aggregate counts. They do not identify unique requests or request-to-viewable cohorts. `ad_measurable` is a client iframe-geometry signal; AdSense Active View measurability remains a separate API ratio.');
  }
  if (ga4.dimensions?.length) {
    out.push('', 'Aggregate event rows; no page URL, job/company identifier or request ID is requested:', '',
      '| Event | Device | Slot | Placement | Render path | Page template | Network | Events | Sample |',
      '|---|---|---|---|---|---|---|---:|---|');
    for (const row of ga4.dimensions) {
      out.push(`| ${escapeCell(row.eventName || 'missing')} | ${escapeCell(row.device || 'missing')}` +
        ` | ${escapeCell(row.slot || 'missing')} | ${escapeCell(row.placement || 'missing')}` +
        ` | ${escapeCell(row.renderPath || 'missing')} | ${escapeCell(row.pageTemplate || 'missing')}` +
        ` | ${escapeCell(row.network || 'missing')} | ${formatValue(row.eventCount)} | ${row.eventCountStatus} |`);
    }
  }
  if (ga4.offerwallSnapshots) {
    out.push('', '## Offerwall ads snapshots', '',
      `Source status: **${ga4.offerwallSnapshots.status}**; report rows ${formatValue(ga4.offerwallSnapshots.returnedRows)} / ${formatValue(ga4.offerwallSnapshots.rowCount)}.`,
      'These are aggregate diagnostic snapshots. Their event counts and mean metrics cannot be joined to an individual browser, click, request ID or Offerwall outcome.',
      '', '| Snapshot event | Device | Events | Sample | Mean ads total | Mean ads visible | Mean anchor visible |',
      '|---|---|---:|---|---:|---:|---:|');
    for (const row of ga4.offerwallSnapshots.rows || []) {
      const averages = row.averages || {};
      out.push(`| ${row.eventName} | ${escapeCell(row.device || 'all devices')}` +
        ` | ${formatValue(row.eventCount)} | ${row.eventCountStatus}` +
        ` | ${formatValue(averages.ads_total?.value)} | ${formatValue(averages.ads_visible?.value)}` +
        ` | ${formatValue(averages.anchor_visible?.value)} |`);
    }
    if (ga4.offerwallSnapshots.error) out.push('', ga4.offerwallSnapshots.error);
    if (ga4.offerwallSnapshots.warnings?.length) out.push('', `Offerwall snapshot coverage warnings: ${ga4.offerwallSnapshots.warnings.join('; ')}.`);
    if (ga4.offerwallSnapshots.missingMetrics?.length) {
      out.push('', `Offerwall snapshot metrics missing or incompatible: ${ga4.offerwallSnapshots.missingMetrics.map((name) => name.replace('customEvent:', '')).join(', ')}.`);
    }
    if (ga4.offerwallSnapshots.note) out.push('', ga4.offerwallSnapshots.note);
  }
  if (ga4.adPageDiag) {
    out.push('', '## GA4 ad page diagnostics', '',
      `Source status: **${ga4.adPageDiag.status}**; diagnostic rows ${formatValue(ga4.adPageDiag.returnedRows)} / ${formatValue(ga4.adPageDiag.rowCount)}.`,
      '', '| Device | Page template | Ad path | Events | Sample | Mean slots | Mean filled | Mean unfilled | Mean collapsed | Mean auto-placed | First-fill mean (withheld: -1 no-fill sentinel) |',
      '|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|');
    for (const row of ga4.adPageDiag.rows || []) {
      const metrics = row.averages || {};
      out.push(`| ${escapeCell(row.device || 'all devices')} | ${escapeCell(row.pageTemplate || 'missing')}` +
        ` | ${escapeCell(row.adPath || 'missing')} | ${formatValue(row.eventCount)} | ${row.eventCountStatus}` +
        ` | ${formatValue(metrics.slots_total?.value)} | ${formatValue(metrics.slots_filled?.value)}` +
        ` | ${formatValue(metrics.slots_unfilled?.value)} | ${formatValue(metrics.slots_collapsed?.value)}` +
        ` | ${formatValue(metrics.auto_placed?.value)} | ${formatValue(metrics.first_fill_ms?.value)} |`);
    }
    if (ga4.adPageDiag.error) out.push('', ga4.adPageDiag.error);
    if (ga4.adPageDiag.warnings?.length) out.push('', `Diagnostic coverage warnings: ${ga4.adPageDiag.warnings.join('; ')}.`);
    if (ga4.adPageDiag.missingMetrics?.length) {
      out.push('', `Diagnostic metrics missing or incompatible: ${ga4.adPageDiag.missingMetrics.map((name) => name.replace('customEvent:', '')).join(', ')}.`);
    }
    if (ga4.adPageDiag.unqueriedMetrics?.length) {
      out.push('', `Registered diagnostic metrics not queried because GA4 runReport accepts at most 10 metrics including eventCount: ${ga4.adPageDiag.unqueriedMetrics.map((name) => name.replace('customEvent:', '')).join(', ')}.`);
    }
  }
  if (ga4.completenessWarnings?.length) out.push('', `GA4 lifecycle coverage warnings: ${ga4.completenessWarnings.join('; ')}.`);
  out.push('', 'Low-sample labels are descriptive volume thresholds, not statistical significance tests.', '');
  return out.join('\n');
}

function formatValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'missing';
  return new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(Number(value));
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'missing';
  return `${new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${currency || 'currency unavailable'}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'missing';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
}
