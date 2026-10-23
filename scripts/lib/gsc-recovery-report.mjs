import { createHash } from 'node:crypto';
import { countInclusiveUtcDays } from './analytics-settled-window.mjs';
import { classifyAnalyticsRecoveryPath } from './analytics-opportunity-utils.mjs';
import { CTR_MEASURE_VERSION, segmentFamilyRows } from './seo-ctr-query-segments.mjs';
import { compareGscMetric, rankRecoveryQueue } from './gsc-opportunity-scoring.mjs';
import { GSC_SITE_URL } from './gsc-property.mjs';

export const GSC_RECOVERY_SNAPSHOT_VERSION = 1;
export const GSC_RECOVERY_PAGE_MEASURE = 'gsc-searchanalytics:web:page:final';

const JOB_QUERY_SEGMENTS = Object.freeze(['operator', 'promo']);
const EDITORIAL_CONTENT_GROUPS = new Set(['articles', 'guides', 'stats', 'tools', 'reference', 'core']);

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function gscRecoverySnapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify(stableValue(snapshot))).digest('hex');
}

function normalizePagePath(value, siteUrl = GSC_SITE_URL) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const expectedHost = new URL(siteUrl).hostname.replace(/^www\./i, '');
      if (url.hostname.replace(/^www\./i, '') !== expectedHost) return null;
      raw = url.pathname;
    }
  } catch {
    return null;
  }
  raw = raw.split('#', 1)[0].split('?', 1)[0].replace(/\/{2,}/g, '/');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function pageRowPath(row) {
  return row?.path || row?.page || row?.keys?.[0] || '';
}

function normalizePageRow(row, siteUrl) {
  const path = normalizePagePath(pageRowPath(row), siteUrl);
  if (!path) return null;
  const clicks = row?.clicks;
  const impressions = row?.impressions;
  const position = row?.position === null || row?.position === undefined ? null : row.position;
  if (typeof clicks !== 'number' || !Number.isFinite(clicks) || clicks < 0
    || typeof impressions !== 'number' || !Number.isFinite(impressions) || impressions < 0) {
    return { path, invalid: true };
  }
  if (position !== null && (typeof position !== 'number' || !Number.isFinite(position) || position < 0)) return { path, invalid: true };
  return { path, clicks, impressions, position };
}

function normalizeQueryRow(row, siteUrl) {
  const path = normalizePagePath(row?.path || row?.keys?.[0] || '', siteUrl);
  const query = String(row?.query ?? row?.keys?.[1] ?? '').trim();
  if (!path || !query) return null;
  const clicks = row?.clicks;
  const impressions = row?.impressions;
  const position = row?.position === null || row?.position === undefined ? null : row.position;
  if (typeof clicks !== 'number' || !Number.isFinite(clicks) || clicks < 0
    || typeof impressions !== 'number' || !Number.isFinite(impressions) || impressions < 0) return null;
  if (position !== null && (typeof position !== 'number' || !Number.isFinite(position) || position < 0)) return null;
  return { path, query, clicks, impressions, position };
}

/** Create a versioned snapshot without mutating the API rows supplied by the caller. */
export function createGscRecoverySnapshot({
  assessment,
  pageRows = [],
  queryRows = [],
  pageRowsComplete = false,
  queryRowsComplete = false,
  pageRowsError = null,
  queryRowsError = null,
  source = 'gsc-search-analytics',
  snapshotId = null,
  siteUrl = GSC_SITE_URL,
} = {}) {
  const normalizedPageRows = pageRows.map((row) => normalizePageRow(row, siteUrl)).filter(Boolean);
  const normalizedQueryRows = queryRows.map((row) => normalizeQueryRow(row, siteUrl)).filter(Boolean);
  const malformedPageRows = normalizedPageRows.length !== pageRows.length || normalizedPageRows.some((row) => row.invalid);
  const malformedQueryRows = normalizedQueryRows.length !== queryRows.length;
  const normalizedPageRowsComplete = pageRowsComplete === true && !malformedPageRows;
  const normalizedQueryRowsComplete = queryRowsComplete === true && !malformedQueryRows;
  return {
    snapshotVersion: GSC_RECOVERY_SNAPSHOT_VERSION,
    snapshotId: snapshotId || null,
    source,
    measure: GSC_RECOVERY_PAGE_MEASURE,
    assessment: cloneJson(assessment) || null,
    pageRowsComplete: normalizedPageRowsComplete,
    pageRowsError: pageRowsError
      ? String(pageRowsError)
      : malformedPageRows
        ? `discarded or rejected ${pageRows.length - normalizedPageRows.filter((row) => !row.invalid).length} malformed page row(s)`
        : null,
    pageRows: normalizedPageRows,
    queryRowsComplete: normalizedQueryRowsComplete,
    queryRowsError: queryRowsError
      ? String(queryRowsError)
      : malformedQueryRows
        ? `discarded ${queryRows.length - normalizedQueryRows.length} malformed query row(s)`
        : null,
    queryMeasureVersion: CTR_MEASURE_VERSION,
    queryRows: normalizedQueryRows,
  };
}

function snapshotWindow(snapshot) {
  return snapshot?.assessment?.window || snapshot?.window || null;
}

function validMetricRow(row) {
  return typeof row?.path === 'string'
    && row.path.startsWith('/')
    && Number.isFinite(row.clicks)
    && row.clicks >= 0
    && Number.isFinite(row.impressions)
    && row.impressions >= 0
    && (row.position === null || (Number.isFinite(row.position) && row.position >= 0));
}

function validQueryMetricRow(row) {
  return validMetricRow(row) && typeof row.query === 'string' && row.query.trim() !== '';
}

function validateSnapshot(snapshot, label) {
  const assessment = snapshot?.assessment;
  if (!assessment || assessment.status !== 'measurable' || assessment.complete !== true) {
    return `${label} window is not verified complete${assessment?.reason ? `: ${assessment.reason}` : ''}`;
  }
  const window = snapshotWindow(snapshot);
  const days = countInclusiveUtcDays(window?.start, window?.end);
  if (!days) return `${label} window has invalid dates`;
  if (snapshot?.measure !== GSC_RECOVERY_PAGE_MEASURE) return `${label} uses an incompatible GSC page measure`;
  if (snapshot?.pageRowsComplete !== true) {
    return `${label} page rows are incomplete${snapshot?.pageRowsError ? `: ${snapshot.pageRowsError}` : ''}`;
  }
  if (!Array.isArray(snapshot?.pageRows) || snapshot.pageRows.some((row) => !validMetricRow(row))) {
    return `${label} page rows are malformed`;
  }
  return null;
}

/** Check that current and baseline rows can be compared as the same measurement. */
export function assessGscRecoveryComparability(current, baseline) {
  const currentError = validateSnapshot(current, 'current');
  if (currentError) return { status: 'unmeasurable', reason: currentError, days: null };
  const baselineError = validateSnapshot(baseline, 'baseline');
  if (baselineError) return { status: 'unmeasurable', reason: baselineError, days: null };

  const currentWindow = snapshotWindow(current);
  const baselineWindow = snapshotWindow(baseline);
  const currentDays = countInclusiveUtcDays(currentWindow.start, currentWindow.end);
  const baselineDays = countInclusiveUtcDays(baselineWindow.start, baselineWindow.end);
  if (currentDays !== baselineDays) {
    return { status: 'unmeasurable', reason: `window durations differ (${currentDays} vs ${baselineDays} days)`, days: null };
  }
  if (baselineWindow.end >= currentWindow.start) {
    return { status: 'unmeasurable', reason: 'baseline must end before the current window starts', days: null };
  }
  if (current?.measure !== baseline?.measure) {
    return { status: 'unmeasurable', reason: 'current and baseline GSC page measures differ', days: null };
  }
  return {
    status: 'measurable',
    reason: null,
    days: currentDays,
    currentWindow: cloneJson(currentWindow),
    baselineWindow: cloneJson(baselineWindow),
  };
}

function aggregateRowsByPath(rows = []) {
  const byPath = new Map();
  for (const row of rows) {
    const current = byPath.get(row.path) || { path: row.path, clicks: 0, impressions: 0, weightedPosition: 0, positionImpressions: 0 };
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    if (row.position !== null && row.impressions > 0) {
      current.weightedPosition += row.position * row.impressions;
      current.positionImpressions += row.impressions;
    }
    byPath.set(row.path, current);
  }
  return new Map([...byPath.entries()].map(([path, row]) => [path, {
    path,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    position: row.positionImpressions > 0 ? row.weightedPosition / row.positionImpressions : null,
  }]));
}

function segmentSnapshotCtr(snapshot) {
  if (snapshot?.queryRowsComplete !== true) {
    return { status: 'unmeasurable', reason: snapshot?.queryRowsError || 'query-segment rows are incomplete', rows: new Map() };
  }
  if (snapshot?.queryMeasureVersion !== CTR_MEASURE_VERSION) {
    return { status: 'unmeasurable', reason: 'query-segment measure version differs from this report', rows: new Map() };
  }
  if (!Array.isArray(snapshot?.queryRows) || snapshot.queryRows.some((row) => !validQueryMetricRow(row))) {
    return { status: 'unmeasurable', reason: 'query-segment rows are malformed', rows: new Map() };
  }
  const pages = aggregateRowsByPath(snapshot.pageRows);
  const pageRows = [...pages.values()];
  const queryRows = snapshot.queryRows;
  const jobs = pageRows.filter((row) => classifyAnalyticsRecoveryPath(row.path).contentGroup === 'jobs');
  const other = pageRows.filter((row) => classifyAnalyticsRecoveryPath(row.path).contentGroup !== 'jobs');
  const jobPaths = new Set(jobs.map((row) => row.path));
  const jobQueryRows = queryRows.filter((row) => jobPaths.has(row.path));
  const otherQueryRows = queryRows.filter((row) => !jobPaths.has(row.path));
  const segmentedJobs = segmentFamilyRows(jobs, jobQueryRows, { segments: JOB_QUERY_SEGMENTS });
  const segmentedOther = segmentFamilyRows(other, otherQueryRows, { segments: ['operator'] });
  const rows = new Map();
  for (const row of segmentedJobs.rows) rows.set(row.path, { ...row, measureVersion: segmentedJobs.measureVersion });
  for (const row of segmentedOther.rows) rows.set(row.path, { ...row, measureVersion: segmentedOther.measureVersion });
  return { status: 'measurable', reason: null, rows };
}

function pageConfidence(context, current, baseline) {
  const reasons = [];
  const knownTemplate = context.contentGroup !== 'other';
  if (!knownTemplate) reasons.push('template non registrato');
  if (context.contentGroup === 'jobs' && !context.canton) reasons.push('cantone non risolto dal registro canonico');
  const currentVolume = Number(current?.impressions || 0);
  const baselineVolume = Number(baseline?.impressions || 0);
  if (currentVolume < 100 || baselineVolume < 100) reasons.push('volume sotto 100 impressioni in almeno una finestra');
  const level = knownTemplate && (context.contentGroup !== 'jobs' || context.canton) && currentVolume >= 100 && baselineVolume >= 100
    ? 'high'
    : knownTemplate && currentVolume > 0 && baselineVolume > 0
      ? 'medium'
      : 'low';
  return { level, reasons };
}

function metricSet(current, baseline, currentCtr, baselineCtr) {
  return {
    clicks: compareGscMetric(current.clicks, baseline.clicks),
    impressions: compareGscMetric(current.impressions, baseline.impressions),
    position: compareGscMetric(current.position, baseline.position),
    ctr: compareGscMetric(current.ctr, baseline.ctr),
    segmentedCtr: compareGscMetric(currentCtr?.ctr, baselineCtr?.ctr),
  };
}

function knownIndexabilityIssue(evidence) {
  const status = Number(evidence?.httpStatus ?? evidence?.statusCode);
  const redirect = Number.isFinite(status) && status >= 300 && status < 400;
  const redirectTargetStatus = Number(evidence?.redirectTargetStatus);
  const redirectTargetVerified = evidence?.redirectTargetVerified === true
    && Number.isFinite(redirectTargetStatus)
    && redirectTargetStatus >= 200
    && !(redirectTargetStatus >= 300 && redirectTargetStatus < 400);
  if (redirect && !redirectTargetVerified) {
    return {
      state: 'unknown',
      code: 'redirect_target_unverified',
      reason: 'redirect target was not verified as HTTP 200',
      confidence: 'low',
    };
  }
  if (redirect && redirectTargetVerified) {
    if (redirectTargetStatus === 200) return { state: 'verified_good', code: 'redirect_target_200', reason: null, confidence: 'high' };
    return { state: 'indexability', code: 'redirect_target_non_200', reason: `verified redirect target returned HTTP ${redirectTargetStatus}`, confidence: 'high' };
  }
  if (Number.isFinite(status) && status !== 200) {
    return { state: 'indexability', code: 'non_200', reason: `HTTP ${status}`, confidence: 'high' };
  }
  const inspection = String(
    evidence?.coverageState || evidence?.indexingState || evidence?.verdict || evidence?.reason || '',
  ).trim().toLowerCase();
  if (/redirect/.test(inspection)) {
    return {
      state: 'unknown',
      code: 'redirect_target_unverified',
      reason: 'inspection reports a redirect without a verified target',
      confidence: 'low',
    };
  }
  if (/(not indexed|not-indexed|excluded|blocked|soft 404|error|duplicate)/.test(inspection) || inspection === 'fail') {
    return { state: 'indexability', code: 'not_indexed', reason: inspection || 'inspection verdict fail', confidence: 'high' };
  }
  if (status === 200 && /(indexed|pass)/.test(inspection)) {
    return { state: 'verified_good', code: 'indexed_200', reason: null, confidence: 'high' };
  }
  return { state: 'unknown', code: 'insufficient_evidence', reason: 'no verified HTTP or indexing verdict', confidence: 'low' };
}

function normalizeIndexabilityEvidence(evidence = [], siteUrl = GSC_SITE_URL) {
  const issues = [];
  const unknown = [];
  for (const item of evidence) {
    const path = normalizePagePath(item?.path || item?.page || item?.url || '', siteUrl);
    if (!path) continue;
    const result = knownIndexabilityIssue(item);
    const context = classifyAnalyticsRecoveryPath(path);
    const entry = {
      path,
      locale: context.contentLocale,
      template: context.pageTemplate,
      canton: context.canton || null,
      status: result.state,
      code: result.code,
      reason: result.reason,
      confidence: result.confidence,
      evidence: {
        httpStatus: Number.isFinite(Number(item?.httpStatus ?? item?.statusCode)) ? Number(item.httpStatus ?? item.statusCode) : null,
        inspectionState: item?.coverageState || item?.indexingState || item?.verdict || null,
        ...(result.code === 'redirect_target_unverified' ? { redirectTarget: 'unknown' } : {}),
        ...(item?.redirectTargetVerified === true ? {
          redirectTargetVerified: true,
          redirectTargetStatus: Number(item.redirectTargetStatus),
        } : {}),
      },
    };
    if (result.state === 'indexability') issues.push(entry);
    else if (result.state === 'unknown') unknown.push(entry);
  }
  return { issues, unknown };
}

/**
 * Build separate evidence-backed queues from two complete GSC windows.
 * The inputs are read-only: their serialized form is hashed before the report
 * is built and no nested array or metric object is changed.
 */
export function buildGscRecoveryReport({
  current,
  baseline,
  baselineSource = 'previous-final-window',
  indexabilityEvidence = [],
  generatedAt = new Date().toISOString(),
  siteUrl = GSC_SITE_URL,
} = {}) {
  const baselineHash = baseline ? gscRecoverySnapshotHash(baseline) : null;
  const comparability = assessGscRecoveryComparability(current, baseline);
  const indexability = normalizeIndexabilityEvidence(indexabilityEvidence, siteUrl);
  const queues = {
    indexability: indexability.issues,
    visibilityLoss: [],
    ctrContent: [],
    unknown: indexability.unknown,
  };
  if (comparability.status !== 'measurable') {
    return {
      schemaVersion: GSC_RECOVERY_SNAPSHOT_VERSION,
      generatedAt,
      status: 'unmeasurable',
      reason: comparability.reason,
      comparability,
      baseline: baseline ? { source: baselineSource, window: cloneJson(snapshotWindow(baseline)), snapshotHash: baselineHash } : null,
      summary: { pages: 0, indexability: queues.indexability.length, visibilityLoss: 0, ctrContent: 0, unknown: queues.unknown.length },
      pages: [],
      queues,
    };
  }

  const currentPages = aggregateRowsByPath(current.pageRows);
  const baselinePages = aggregateRowsByPath(baseline.pageRows);
  const evidencePaths = [...indexability.issues, ...indexability.unknown].map((entry) => entry.path);
  const unresolvedRedirects = new Set(indexability.unknown
    .filter((entry) => entry.code === 'redirect_target_unverified')
    .map((entry) => entry.path));
  const indexabilityIssuePaths = new Set(indexability.issues.map((entry) => entry.path));
  const paths = [...new Set([...currentPages.keys(), ...baselinePages.keys(), ...evidencePaths])].sort();
  const currentCtr = segmentSnapshotCtr(current);
  const baselineCtr = segmentSnapshotCtr(baseline);
  const ctrStatus = currentCtr.status !== 'measurable'
    ? currentCtr
    : baselineCtr.status !== 'measurable'
      ? baselineCtr
      : current.queryMeasureVersion !== baseline.queryMeasureVersion
        ? { status: 'unmeasurable', reason: 'query-segment measure versions differ' }
        : { status: 'measurable', reason: null };
  const pages = [];

  for (const path of paths) {
    const currentMetrics = currentPages.get(path) || { path, clicks: 0, impressions: 0, ctr: null, position: null };
    const baselineMetrics = baselinePages.get(path) || { path, clicks: 0, impressions: 0, ctr: null, position: null };
    const context = classifyAnalyticsRecoveryPath(path);
    const currentSegmented = currentCtr.rows.get(path) || null;
    const baselineSegmented = baselineCtr.rows.get(path) || null;
    const metrics = metricSet(currentMetrics, baselineMetrics, currentSegmented, baselineSegmented);
    const confidence = pageConfidence(context, currentMetrics, baselineMetrics);
    const page = {
      path,
      locale: context.contentLocale,
      section: context.siteSection,
      template: context.pageTemplate,
      canton: context.canton || null,
      contentGroup: context.contentGroup,
      confidence: confidence.level,
      confidenceReasons: confidence.reasons,
      metrics,
      querySegments: {
        status: ctrStatus.status,
        reason: ctrStatus.reason,
        measureVersion: currentSegmented?.measureVersion || baselineSegmented?.measureVersion || null,
      },
    };
    pages.push(page);

    const lostClicks = Math.max(0, -(metrics.clicks.delta || 0));
    const lostImpressions = Math.max(0, -(metrics.impressions.delta || 0));
    const worsenedPosition = metrics.position.delta !== null && metrics.position.delta > 0;
    if (!indexabilityIssuePaths.has(path) && !unresolvedRedirects.has(path) && (lostImpressions > 0 || worsenedPosition)) {
      queues.visibilityLoss.push({
        ...page,
        estimatedLostClicks: Number(lostClicks.toFixed(2)),
        lostImpressions,
        positionWorsenedBy: worsenedPosition ? metrics.position.delta : 0,
        signals: [
          ...(lostImpressions > 0 ? ['impressions_down'] : []),
          ...(worsenedPosition ? ['average_position_worse'] : []),
        ],
      });
    }

    const segmentedCtrDelta = metrics.segmentedCtr.delta;
    const eligibleForContent = EDITORIAL_CONTENT_GROUPS.has(context.contentGroup) || context.contentGroup === 'jobs';
    if (
      ctrStatus.status === 'measurable'
      && eligibleForContent
      && !indexabilityIssuePaths.has(path)
      && !unresolvedRedirects.has(path)
      && segmentedCtrDelta !== null
      && segmentedCtrDelta < 0
    ) {
      const currentSegmentedImpressions = Number(currentSegmented?.impressions || 0);
      const estimatedLostClicks = Math.max(0, -segmentedCtrDelta * currentSegmentedImpressions);
      queues.ctrContent.push({
        ...page,
        estimatedLostClicks: Number(estimatedLostClicks.toFixed(2)),
        ctrDrop: Number((-segmentedCtrDelta).toFixed(6)),
        ctrMeasureVersion: currentSegmented.measureVersion,
      });
    }
  }

  const pageByPath = new Map(pages.map((page) => [page.path, page]));
  const attachPageMetrics = (entry) => {
    const page = pageByPath.get(entry.path);
    if (!page) return entry;
    return {
      ...page,
      ...entry,
      metrics: page.metrics,
      querySegments: page.querySegments,
      metricConfidence: page.confidence,
      confidenceReasons: page.confidenceReasons,
    };
  };
  queues.indexability = queues.indexability.map(attachPageMetrics);
  queues.unknown = queues.unknown.map(attachPageMetrics);
  queues.indexability.sort((a, b) => a.path.localeCompare(b.path));
  queues.unknown.sort((a, b) => a.path.localeCompare(b.path));
  queues.visibilityLoss = rankRecoveryQueue(queues.visibilityLoss);
  queues.ctrContent = rankRecoveryQueue(queues.ctrContent);
  return {
    schemaVersion: GSC_RECOVERY_SNAPSHOT_VERSION,
    generatedAt,
    status: 'measurable',
    reason: null,
    comparability: {
      ...comparability,
      baselineSource,
      querySegments: {
        status: ctrStatus.status,
        reason: ctrStatus.reason,
        measureVersion: CTR_MEASURE_VERSION,
      },
    },
    baseline: { source: baselineSource, window: cloneJson(snapshotWindow(baseline)), snapshotHash: baselineHash },
    summary: {
      pages: pages.length,
      indexability: queues.indexability.length,
      visibilityLoss: queues.visibilityLoss.length,
      ctrContent: queues.ctrContent.length,
      unknown: queues.unknown.length,
    },
    pages,
    queues,
  };
}

function metricCell(metric, percent = false) {
  if (metric?.delta === null || metric?.delta === undefined) return 'n/a';
  if (percent) return `${(metric.delta * 100).toFixed(1)} pp`;
  return metric.delta > 0 ? `+${metric.delta}` : String(metric.delta);
}

function tableForQueue(title, rows, includeCtr = false) {
  const columns = includeCtr
    ? ['Pagina', 'Lingua', 'Template', 'Clic', 'Impressioni', 'Posizione', 'CTR segmentata', 'Confidenza']
    : ['Pagina', 'Lingua', 'Template', 'Clic', 'Impressioni', 'Posizione', 'Confidenza'];
  const lines = [`## ${title}`, '', `Voci: ${rows.length}`, '', `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`];
  for (const row of rows) {
    const cells = [
      `\`${row.path}\``,
      row.locale,
      row.template,
      metricCell(row.metrics?.clicks),
      metricCell(row.metrics?.impressions),
      metricCell(row.metrics?.position),
      ...(includeCtr ? [metricCell(row.metrics?.segmentedCtr, true)] : []),
      row.confidence,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

export function renderGscRecoveryMarkdown(report, { limit = 50 } = {}) {
  const selected = (rows) => (rows || []).slice(0, limit);
  const lines = [
    '# GSC SEO recovery report',
    '',
    `Stato: **${report.status}** · Generato: ${report.generatedAt}`,
    report.reason ? `Motivo: ${report.reason}` : '',
    `Finestra corrente: ${report.comparability?.currentWindow?.start || 'n/a'} → ${report.comparability?.currentWindow?.end || 'n/a'}`,
    `Baseline (${report.baseline?.source || 'n/a'}): ${report.baseline?.window?.start || 'n/a'} → ${report.baseline?.window?.end || 'n/a'} · SHA-256: \`${report.baseline?.snapshotHash || 'n/a'}\``,
    '',
    ...tableForQueue('Non-200 e indexability', selected(report.queues?.indexability)),
    '',
    ...tableForQueue('Perdita di visibilità', selected(report.queues?.visibilityLoss)),
    '',
    ...tableForQueue('CTR e contenuto', selected(report.queues?.ctrContent), true),
    '',
    ...tableForQueue('Evidenza unknown', selected(report.queues?.unknown)),
    '',
    'I redirect senza target verificato restano `unknown`; nessuna destinazione viene dedotta.',
    '',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}
