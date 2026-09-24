#!/usr/bin/env node

/**
 * Read-only L2 demand-to-utility outcome export.
 *
 * GSC supplies the landing-path cohort. GA4 supplies two independent,
 * session-scoped reports: landing-page sessions and the once-per-session
 * useful-action event. The exporter never writes GSC data, landing pages, SEO
 * metadata or any published surface; it only writes a runner-local JSON file
 * consumed by the L2 validator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleDataClient } from './export-loop-outcomes.mjs';
import {
  GA4_READONLY_SCOPE,
  ga4DateRange,
  runGa4Report,
} from '../lib/ga4-service-account.mjs';

export const LOOP_ID = 'L2';
export const DEFAULT_SOURCE_PATH = path.join('data', 'gsc-orphan-queries-clusters.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'l2-demand-outcomes.json');
export const DEFAULT_WINDOW_DAYS = 8;
export const L2_USEFUL_ACTION_EVENT = 'l2_useful_action';
export const L2_USEFUL_ACTION_EVENT_CONTRACT = Object.freeze({
  usefulActionEvent: L2_USEFUL_ACTION_EVENT,
  landingDimension: 'landingPagePlusQueryString',
  sessionMetric: 'sessions',
  sessionJoin: 'GA4 session-scoped landing page',
});

const MAX_LANDING_PATHS = 5_000;
const MAX_GA4_ROWS = 100_000;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
  return absolute;
}

function parseCount(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`GA4 returned invalid ${label}`);
  return parsed;
}

function normalizePathname(value) {
  if (!text(value)) return null;
  let pathname = value.trim();
  try {
    pathname = new URL(pathname, 'https://frontaliereticino.ch').pathname;
  } catch {
    pathname = pathname.split(/[?#]/u, 1)[0];
  }
  const slug = pathname.replace(/^\/+|\/+$/gu, '');
  return slug ? `/${slug}/` : null;
}

/** Normalize a GSC canonical slug into the site's trailing-slash path. */
export function normalizeLandingPath(value) {
  return normalizePathname(value);
}

/** Return every GSC landing path, without silently dropping a malformed row. */
export function landingPathsFromGsc(source) {
  if (!object(source) || !Array.isArray(source.clusters)) {
    throw new Error('GSC snapshot must contain a clusters array');
  }
  const paths = new Set();
  for (const [index, cluster] of source.clusters.entries()) {
    const landingPath = normalizeLandingPath(cluster?.canonicalSlug);
    if (!landingPath) throw new Error(`GSC cluster ${index} has no canonicalSlug`);
    paths.add(landingPath);
  }
  if (paths.size === 0) throw new Error('GSC snapshot has no landing paths');
  if (paths.size > MAX_LANDING_PATHS) {
    throw new Error(`GSC snapshot has ${paths.size} landing paths (max ${MAX_LANDING_PATHS})`);
  }
  return [...paths].sort();
}

/**
 * Build one bounded GA4 session report. The landing dimension is session
 * scoped, so each session contributes to exactly one landing-path row.
 */
export function buildL2LandingSessionReportBody({
  startDate,
  endDate,
  eventName = null,
  limit = MAX_GA4_ROWS,
} = {}) {
  if (!text(startDate) || !text(endDate)) throw new Error('a complete telemetry window is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GA4_ROWS) {
    throw new Error(`GA4 report limit must be between 1 and ${MAX_GA4_ROWS}`);
  }
  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: L2_USEFUL_ACTION_EVENT_CONTRACT.landingDimension }],
    metrics: [{ name: L2_USEFUL_ACTION_EVENT_CONTRACT.sessionMetric }],
    limit,
  };
  if (eventName !== null) {
    if (!text(eventName)) throw new Error('eventName must be a non-empty string');
    body.dimensionFilter = {
      filter: {
        fieldName: 'eventName',
        stringFilter: { value: eventName, matchType: 'EXACT' },
      },
    };
  }
  return body;
}

/** Backwards-compatible descriptive alias for callers that build the report. */
export const buildL2OutcomeQuery = buildL2LandingSessionReportBody;

function reportRows(report, label) {
  if (!object(report) || !Array.isArray(report.rows)) {
    throw new Error(`GA4 ${label} report is missing rows`);
  }
  const rowCount = report.rowCount === undefined ? report.rows.length : Number(report.rowCount);
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new Error(`GA4 ${label} report has invalid rowCount`);
  if (rowCount > report.rows.length) {
    throw new Error(`GA4 ${label} report is truncated (${report.rows.length} of ${rowCount} rows)`);
  }
  if (report.rows.some((row) => row?.dimensionValues?.some((dimension) => dimension?.value === '(other)'))) {
    throw new Error(`GA4 ${label} report contains an (other) bucket`);
  }
  return report.rows;
}

function sessionCountsByLandingPath(report, label) {
  const counts = new Map();
  for (const row of reportRows(report, label)) {
    const rawPath = row?.dimensionValues?.[0]?.value;
    if (rawPath === '(not set)' || rawPath === '(data not available)') continue;
    const landingPath = normalizeLandingPath(rawPath);
    if (!landingPath) throw new Error(`GA4 ${label} report contains an invalid landing path`);
    const sessions = parseCount(row?.metricValues?.[0]?.value, `${label} sessions`);
    counts.set(landingPath, (counts.get(landingPath) || 0) + sessions);
  }
  return counts;
}

/** Join only the GSC cohort; GA4 rows outside that cohort are ignored. */
export function buildL2OutcomeCounts({
  landingPaths,
  landingSessionReport,
  usefulActionReport,
} = {}) {
  if (!Array.isArray(landingPaths) || landingPaths.length === 0) {
    throw new Error('at least one landing path is required');
  }
  const cohort = new Set(landingPaths.map(normalizeLandingPath));
  if (cohort.has(null) || cohort.size !== landingPaths.length) throw new Error('landing paths are invalid');
  const eligibleByPath = sessionCountsByLandingPath(landingSessionReport, 'eligible landing session');
  const usefulByPath = sessionCountsByLandingPath(usefulActionReport, 'useful action');
  const eligibleLandingSessions = [...cohort]
    .reduce((sum, landingPath) => sum + (eligibleByPath.get(landingPath) || 0), 0);
  const usefulActions = [...cohort]
    .reduce((sum, landingPath) => sum + (usefulByPath.get(landingPath) || 0), 0);
  if (usefulActions > eligibleLandingSessions) {
    throw new Error('usefulActions exceeds eligibleLandingSessions');
  }
  return { eligibleLandingSessions, usefulActions };
}

export function buildL2DemandExport(source, {
  eligibleLandingSessions,
  usefulActions,
  generatedAt,
  telemetryWindow,
  eventContract = L2_USEFUL_ACTION_EVENT_CONTRACT,
} = {}) {
  if (!object(source)) throw new Error('GSC source must be an object');
  if (!integer(eligibleLandingSessions) || !integer(usefulActions)) {
    throw new Error('L2 outcome counts must be non-negative integers');
  }
  if (usefulActions > eligibleLandingSessions) throw new Error('usefulActions exceeds eligibleLandingSessions');
  const previousMeta = object(source._meta) ? source._meta : {};
  return {
    ...source,
    generatedAt,
    outcomes: { eligibleLandingSessions, usefulActions },
    telemetryWindow,
    _meta: {
      ...previousMeta,
      generatedAt,
      source: 'GA4 Data API landing-page sessions plus l2_useful_action sessions, read-only live export',
      purpose: 'Fresh eligible landing session and useful action evidence for Loop L2',
      telemetryWindow,
      eventContract: {
        ...eventContract,
      },
      independent: true,
      piiExcluded: true,
      identityExcluded: true,
    },
  };
}

export function buildUnavailableL2DemandExport(source, { now = new Date(), reason = 'live outcome export unavailable' } = {}) {
  const safeSource = object(source) ? { ...source } : { clusters: [] };
  delete safeSource.outcomes;
  if (object(safeSource.metrics)) {
    safeSource.metrics = { ...safeSource.metrics };
    delete safeSource.metrics.outcomes;
  }
  const previousMeta = object(safeSource._meta) ? safeSource._meta : {};
  return {
    ...safeSource,
    generatedAt: now.toISOString(),
    _meta: {
      ...previousMeta,
      generatedAt: now.toISOString(),
      source: 'GA4 Data API landing-page session and useful-action export unavailable',
      purpose: 'Fail-closed L2 outcome placeholder; no metric is inferred',
      unavailableReason: reason,
      independent: false,
      piiExcluded: true,
      identityExcluded: true,
    },
  };
}

export async function exportL2({
  inputPath = DEFAULT_SOURCE_PATH,
  outputPath = DEFAULT_OUTCOME_PATH,
  now = new Date(),
  days = DEFAULT_WINDOW_DAYS,
  propertyId = null,
  client = null,
  ga4Runner = runGa4Report,
} = {}) {
  const source = readJson(inputPath, 'GSC snapshot');
  const paths = landingPathsFromGsc(source);
  const range = ga4DateRange(days, 2, now);
  const analytics = client || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
  const token = await analytics.accessToken();
  const runReport = (body) => ga4Runner({ token, body, propertyId });
  const [landingSessionReport, usefulActionReport] = await Promise.all([
    runReport(buildL2LandingSessionReportBody(range)),
    runReport(buildL2LandingSessionReportBody({ ...range, eventName: L2_USEFUL_ACTION_EVENT })),
  ]);
  const outcomes = buildL2OutcomeCounts({
    landingPaths: paths,
    landingSessionReport,
    usefulActionReport,
  });
  const exported = buildL2DemandExport(source, {
    ...outcomes,
    generatedAt: now.toISOString(),
    telemetryWindow: { ...range, lagDays: 2, source: 'GA4 settled calendar dates' },
  });
  writeJson(outputPath, exported);
  return exported;
}

export function writeUnavailableL2({ inputPath = DEFAULT_SOURCE_PATH, outputPath = DEFAULT_OUTCOME_PATH, now = new Date(), reason } = {}) {
  const source = fs.existsSync(path.resolve(inputPath)) ? readJson(inputPath, 'GSC snapshot') : null;
  return writeJson(outputPath, buildUnavailableL2DemandExport(source, { now, reason }));
}

function valueAfter(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1] || fallback;
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const inputPath = valueAfter(argv, '--input', DEFAULT_SOURCE_PATH);
  const outputPath = valueAfter(argv, '--out', process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l2', 'demand-outcomes.json')
    : DEFAULT_OUTCOME_PATH);
  const now = new Date();
  let output;
  if (argv.includes('--unavailable')) {
    output = writeUnavailableL2({ inputPath, outputPath, now, reason: valueAfter(argv, '--reason', 'live outcome export explicitly unavailable') });
  } else {
    output = await exportL2({ inputPath, outputPath, now, days: Number(valueAfter(argv, '--days', DEFAULT_WINDOW_DAYS)) });
  }
  if (argv.includes('--json')) logger.log(JSON.stringify({ loopId: LOOP_ID, output, outputPath }, null, 2));
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L2 outcome-export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
