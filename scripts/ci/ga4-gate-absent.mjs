#!/usr/bin/env node
/**
 * Read-only GA4 report for the Offerwall gate diagnostics.
 *
 * The client emits two events when Funding Choices has not reached the
 * Offerwall gate:
 *   - rewarded_offerwall_gate_absent: the first missing stage at the click;
 *   - rewarded_offerwall_gate_late: the gate state a little later.
 *
 * This report deliberately keeps the raw `reason` distribution and also
 * derives a stable stage by removing the optional `+spa`/`+fcoec` suffixes.
 * A tie is not a dominant stage: choosing one would turn insufficient
 * evidence into a code-change decision.
 *
 * Usage:
 *   node scripts/ci/ga4-gate-absent.mjs [--days N]
 *   node scripts/ci/ga4-gate-absent.mjs --since YYYY-MM-DD --until YYYY-MM-DD
 *
 * Auth is read-only and uses the canonical service-account helper. The
 * command prints JSON to stdout and never writes GA4, the repository, or a
 * report file.
 */
import { parseArgs as parseCliArgs } from 'node:util';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  runGa4Report,
} from '../lib/ga4-service-account.mjs';
import { ANALYTICS_PROCESSING_LAG_DAYS } from '../lib/analytics-settled-window.mjs';

export const GATE_ABSENT_EVENT = 'rewarded_offerwall_gate_absent';
export const GATE_LATE_EVENT = 'rewarded_offerwall_gate_late';
export const GATE_DIAGNOSTIC_EVENTS = Object.freeze([GATE_ABSENT_EVENT, GATE_LATE_EVENT]);
export const GATE_DIAGNOSTIC_DIMENSIONS = Object.freeze([
  'eventName',
  'customEvent:reason',
  'customEvent:gate_status',
  'customEvent:consent_state',
]);
export const GATE_DIAGNOSTIC_METRICS = Object.freeze(['eventCount', 'totalUsers']);
export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 90;
export const REPORT_LIMIT = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const CONSENT_STATES = Object.freeze(['granted', 'denied', 'none']);
const GATE_STATUSES = Object.freeze(['held', 'released', 'suppressed', 'off_board', 'absent']);
const REASON_QUALIFIERS = new Set(['spa', 'fcoec']);
const SPECIAL_DIMENSION_VALUES = new Set(['(not set)', '(other)', '(data not available)']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizedPropertyId(value) {
  const raw = String(value || DEFAULT_GA4_PROPERTY_ID).trim();
  if (!/^\d+$/.test(raw) && !/^properties\/\d+$/.test(raw)) {
    throw new Error(`GA4 property id is invalid: ${raw}`);
  }
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

function parsePositiveInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${label} must be an integer from 1 to ${max}`);
  }
  return number;
}

function parseDate(value, label) {
  if (!DATE_RE.test(String(value || ''))) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} is not a calendar date`);
  return value;
}

export function parseArgs(argv = []) {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      days: { type: 'string' },
      property: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values;
}

export function resolveWindow({ since, until, days }, now = new Date()) {
  if (days !== undefined) {
    const windowDays = parsePositiveInteger(days, '--days', { max: MAX_WINDOW_DAYS });
    if (since !== undefined || until !== undefined) {
      throw new Error('--days cannot be combined with --since or --until');
    }
    const range = ga4DateRange(windowDays, ANALYTICS_PROCESSING_LAG_DAYS, now);
    return { ...range, days: windowDays, lagDays: ANALYTICS_PROCESSING_LAG_DAYS };
  }

  if (since === undefined && until === undefined) {
    const range = ga4DateRange(DEFAULT_WINDOW_DAYS, ANALYTICS_PROCESSING_LAG_DAYS, now);
    return { ...range, days: DEFAULT_WINDOW_DAYS, lagDays: ANALYTICS_PROCESSING_LAG_DAYS };
  }
  if (since === undefined || until === undefined) {
    throw new Error('--since and --until must be provided together');
  }
  const startDate = parseDate(since, '--since');
  const endDate = parseDate(until, '--until');
  if (endDate < startDate) throw new Error('--until cannot precede --since');
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const daysInWindow = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (daysInWindow > MAX_WINDOW_DAYS) throw new Error(`date window cannot exceed ${MAX_WINDOW_DAYS} days`);
  return { startDate, endDate, days: daysInWindow, lagDays: null };
}

function exactEventFilter() {
  return {
    filter: {
      fieldName: 'eventName',
      inListFilter: { values: [...GATE_DIAGNOSTIC_EVENTS], caseSensitive: true },
    },
  };
}

export function buildReportBody({ startDate, endDate }) {
  parseDate(startDate, 'startDate');
  parseDate(endDate, 'endDate');
  if (endDate < startDate) throw new Error('endDate cannot precede startDate');
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: GATE_DIAGNOSTIC_DIMENSIONS.map((name) => ({ name })),
    metrics: GATE_DIAGNOSTIC_METRICS.map((name) => ({ name })),
    dimensionFilter: exactEventFilter(),
    orderBys: GATE_DIAGNOSTIC_DIMENSIONS.map((dimensionName) => ({
      dimension: { dimensionName },
      desc: false,
    })),
    limit: REPORT_LIMIT,
  };
}

function readDimension(row, index, label) {
  const value = row?.dimensionValues?.[index]?.value;
  if (!nonEmptyText(value) || SPECIAL_DIMENSION_VALUES.has(value)) {
    throw new Error(`GA4 row has an unreadable ${label}`);
  }
  return value;
}

function readCount(row, index, label) {
  const value = row?.metricValues?.[index]?.value;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`GA4 row has an invalid ${label}`);
  }
  return count;
}

function stageFromReason(reason) {
  const [stage, ...qualifiers] = reason.split('+');
  if (!nonEmptyText(stage)) throw new Error('GA4 row has an invalid reason stage');
  if (qualifiers.some((qualifier) => !REASON_QUALIFIERS.has(qualifier))) {
    throw new Error(`GA4 row has an unexpected reason qualifier: ${reason}`);
  }
  return stage;
}

function validateMetadata(metadata) {
  if (metadata === undefined) return;
  if (!isRecord(metadata)) throw new Error('GA4 response has invalid metadata');
  if (metadata.dataLossFromOtherRow !== undefined && typeof metadata.dataLossFromOtherRow !== 'boolean') {
    throw new Error('GA4 response has invalid dataLossFromOtherRow metadata');
  }
  if (metadata.subjectToThresholding !== undefined && typeof metadata.subjectToThresholding !== 'boolean') {
    throw new Error('GA4 response has invalid subjectToThresholding metadata');
  }
  for (const key of ['samplingMetadatas', 'dataTruncationReasons']) {
    if (metadata[key] !== undefined && !Array.isArray(metadata[key])) {
      throw new Error(`GA4 response has invalid ${key} metadata`);
    }
  }
  const restrictions = metadata.schemaRestrictionResponse?.activeMetricRestrictions;
  if (restrictions !== undefined && !Array.isArray(restrictions)) {
    throw new Error('GA4 response has invalid metric restriction metadata');
  }
  if (metadata.dataLossFromOtherRow === true
    || metadata.subjectToThresholding === true
    || (Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0)
    || (Array.isArray(metadata.dataTruncationReasons) && metadata.dataTruncationReasons.length > 0)
    || (Array.isArray(restrictions) && restrictions.length > 0)) {
    throw new Error('GA4 response is sampled, thresholded, truncated, or contains an (other) bucket');
  }
}

export function normalizeGa4Rows(response) {
  if (!isRecord(response)) throw new Error('GA4 response is not an object');
  if (!Array.isArray(response.rows)) throw new Error('GA4 response has unreadable rows');
  const rowCount = Number(response.rowCount);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error('GA4 response has unreadable rowCount');
  if (rowCount !== response.rows.length) {
    throw new Error(`GA4 response is truncated (${response.rows.length} of ${rowCount} rows)`);
  }
  validateMetadata(response.metadata);

  return response.rows.map((row, index) => {
    const eventName = readDimension(row, 0, `eventName at row ${index}`);
    const reason = readDimension(row, 1, `reason at row ${index}`);
    const gateStatus = readDimension(row, 2, `gate_status at row ${index}`);
    const consentState = readDimension(row, 3, `consent_state at row ${index}`);
    if (!GATE_DIAGNOSTIC_EVENTS.includes(eventName)) throw new Error(`GA4 row has an unexpected eventName: ${eventName}`);
    if (!GATE_STATUSES.includes(gateStatus)) throw new Error(`GA4 row has an unexpected gate_status: ${gateStatus}`);
    if (!CONSENT_STATES.includes(consentState)) throw new Error(`GA4 row has an unexpected consent_state: ${consentState}`);
    return {
      eventName,
      reason,
      stage: stageFromReason(reason),
      gateStatus,
      consentState,
      eventCount: readCount(row, 0, `eventCount at row ${index}`),
      totalUsers: readCount(row, 1, `totalUsers at row ${index}`),
    };
  });
}

function compareDistribution(a, b) {
  return b.eventCount - a.eventCount
    || b.totalUsers - a.totalUsers
    || a.value.localeCompare(b.value);
}

function distribution(rows, key, outputKey) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    const current = grouped.get(value) || { [outputKey]: value, eventCount: 0, totalUsers: 0 };
    current.eventCount += row.eventCount;
    current.totalUsers += row.totalUsers;
    grouped.set(value, current);
  }
  return [...grouped.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => compareDistribution({ ...a, value: a[outputKey] }, { ...b, value: b[outputKey] }));
}

function eventSummary(rows, eventName) {
  const eventRows = rows.filter((row) => row.eventName === eventName);
  return {
    eventName,
    eventCount: eventRows.reduce((sum, row) => sum + row.eventCount, 0),
    totalUsers: eventRows.reduce((sum, row) => sum + row.totalUsers, 0),
    byReason: distribution(eventRows, 'reason', 'reason'),
    byStage: distribution(eventRows, 'stage', 'stage'),
    byGateStatus: distribution(eventRows, 'gateStatus', 'gate_status'),
  };
}

function consentSummary(rows) {
  return CONSENT_STATES.map((consentState) => {
    const selected = rows.filter((row) => row.consentState === consentState);
    return {
      consent_state: consentState,
      eventCount: selected.reduce((sum, row) => sum + row.eventCount, 0),
      totalUsers: selected.reduce((sum, row) => sum + row.totalUsers, 0),
    };
  });
}

function cohortSummary(rows, label) {
  return {
    label,
    eventCount: rows.reduce((sum, row) => sum + row.eventCount, 0),
    totalUsers: rows.reduce((sum, row) => sum + row.totalUsers, 0),
    byConsentState: consentSummary(rows),
    byEvent: GATE_DIAGNOSTIC_EVENTS.map((eventName) => eventSummary(rows, eventName)),
  };
}

function dominantStage(rows) {
  const absentRows = rows.filter((row) => row.eventName === GATE_ABSENT_EVENT);
  const stages = distribution(absentRows, 'stage', 'stage');
  if (stages.length === 0) {
    return {
      eventName: GATE_ABSENT_EVENT,
      cohort: 'consent_granted',
      basis: 'eventCount',
      status: 'no_observations',
      stage: null,
      candidates: [],
    };
  }
  const topCount = stages[0].eventCount;
  const candidates = stages.filter((stage) => stage.eventCount === topCount);
  if (candidates.length !== 1) {
    return {
      eventName: GATE_ABSENT_EVENT,
      cohort: 'consent_granted',
      basis: 'eventCount',
      status: 'tie',
      stage: null,
      candidates,
    };
  }
  return {
    eventName: GATE_ABSENT_EVENT,
    cohort: 'consent_granted',
    basis: 'eventCount',
    status: 'unique',
    stage: candidates[0].stage,
    candidates,
  };
}

export function buildReport({ response, window, propertyId, query }) {
  const rows = normalizeGa4Rows(response);
  const granted = rows.filter((row) => row.consentState === 'granted');
  const notGranted = rows.filter((row) => row.consentState !== 'granted');
  return {
    schemaVersion: 1,
    report: 'ga4-offerwall-gate-absent',
    source: 'GA4 Data API',
    property: normalizedPropertyId(propertyId),
    metricSemantics: {
      dominantStage: 'eventCount (ties remain ambiguous)',
      totalUsers: 'sum of GA4 row totals; not deduplicated across dimension values',
    },
    window,
    query,
    coverage: {
      rowsReturned: rows.length,
      rowCount: Number(response.rowCount),
      complete: true,
      ...(isRecord(response.metadata) && response.metadata.timeZone
        ? { timeZone: response.metadata.timeZone }
        : {}),
    },
    cohorts: {
      all: cohortSummary(rows, 'all'),
      consent_granted: cohortSummary(granted, 'consent_granted'),
      consent_not_granted: cohortSummary(notGranted, 'consent_not_granted'),
    },
    dominantStage: dominantStage(granted),
  };
}

function credentialsConfigured() {
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

export async function main({
  argv = process.argv.slice(2),
  now = new Date(),
  getTokenImpl = getServiceAccountToken,
  runReportImpl = runGa4Report,
  logger = console,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    logger.log('node scripts/ci/ga4-gate-absent.mjs [--days N] | [--since YYYY-MM-DD --until YYYY-MM-DD]');
    return null;
  }
  const window = resolveWindow(args, now);
  const property = normalizedPropertyId(args.property || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID);
  if (getTokenImpl === getServiceAccountToken && !credentialsConfigured()) {
    throw new Error('GA4 credentials missing: set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON');
  }
  const token = await getTokenImpl([GA4_READONLY_SCOPE], { logInfo: () => {}, logError: logger.error });
  if (!token) throw new Error('GA4 service-account token unavailable');
  const query = buildReportBody(window);
  const response = await runReportImpl({ token, body: query, propertyId: property });
  const report = buildReport({ response, window, propertyId: property, query });
  logger.log(JSON.stringify({ generatedAt: now.toISOString(), ...report }, null, 2));
  return report;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`ga4-gate-absent failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
