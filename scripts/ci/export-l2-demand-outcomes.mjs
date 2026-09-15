#!/usr/bin/env node

/**
 * Read-only L2 demand-to-utility outcome export.
 *
 * GSC supplies the landing-path cohort. PostHog supplies the independent
 * session/action join. The exporter never writes GSC data, landing pages,
 * SEO metadata or any published surface; it only writes a runner-local JSON
 * file consumed by the L2 validator.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GoogleDataClient,
  completeUtcWindow,
  nonNegativeInteger,
  postHogRow,
  resolvePostHogConfig,
} from './export-loop-outcomes.mjs';
import { runHogQL } from '../lib/posthog-client.mjs';

export const LOOP_ID = 'L2';
export const DEFAULT_SOURCE_PATH = path.join('data', 'gsc-orphan-queries-clusters.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'l2-demand-outcomes.json');
export const DEFAULT_WINDOW_DAYS = 8;
export const L2_USEFUL_ACTION_EVENT_CONTRACT = Object.freeze({
  landingEvents: Object.freeze(['$pageview', 'page_view', 'pageview']),
  usefulEvent: 'funnel_step',
  usefulFunnel: 'main_conversion',
  usefulSteps: Object.freeze(['calculate', 'compare', 'cta_click']),
  additionalUsefulEvents: Object.freeze(['simulation_complete', 'generate_lead']),
  sessionJoin: '$session_id',
  landingPathProperty: 'properties.$pathname',
});

const MAX_LANDING_PATHS = 5_000;

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

function hogqlString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function normalizeLandingPath(value) {
  if (!text(value)) return null;
  const slug = value.trim().replace(/^\/+|\/+$/gu, '');
  return slug ? `/${slug}/` : null;
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

/** Build the bounded session-level join; no user identity or URL is exported. */
export function buildL2OutcomeQuery({ paths, window, eventContract = L2_USEFUL_ACTION_EVENT_CONTRACT } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('at least one landing path is required');
  if (!object(window) || !text(window.start) || !text(window.end)) throw new Error('a complete telemetry window is required');
  const landingEvents = eventContract.landingEvents.map(hogqlString).join(', ');
  const usefulSteps = eventContract.usefulSteps.map(hogqlString).join(', ');
  const additionalEvents = eventContract.additionalUsefulEvents.map(hogqlString).join(', ');
  const pathList = paths.map(hogqlString).join(', ');
  return `
SELECT count() AS eligibleLandingSessions,
       countIf(lastUsefulActionAt IS NOT NULL AND lastUsefulActionAt >= firstLandingAt) AS usefulActions
FROM (
  SELECT $session_id,
         minIf(timestamp, event IN (${landingEvents})
           AND properties.$pathname IN (${pathList})) AS firstLandingAt,
         maxIf(timestamp, (
           (event = ${hogqlString(eventContract.usefulEvent)}
             AND properties.funnel = ${hogqlString(eventContract.usefulFunnel)}
             AND properties.step IN (${usefulSteps}))
           OR event IN (${additionalEvents})
         )) AS lastUsefulActionAt
  FROM events
  WHERE timestamp >= ${hogqlString(window.start)}
    AND timestamp < ${hogqlString(window.end)}
    AND $session_id IS NOT NULL
    AND (event IN (${landingEvents}) OR event IN (${additionalEvents}) OR event = ${hogqlString(eventContract.usefulEvent)})
  GROUP BY $session_id
  HAVING firstLandingAt IS NOT NULL
)`.trim();
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
      source: 'PostHog HogQL joined to GSC landing paths, read-only live export',
      purpose: 'Fresh eligible landing session and useful action evidence for Loop L2',
      telemetryWindow,
      eventContract: {
        ...eventContract,
        landingEvents: [...eventContract.landingEvents],
        usefulSteps: [...eventContract.usefulSteps],
        additionalUsefulEvents: [...eventContract.additionalUsefulEvents],
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
      source: 'PostHog HogQL live export unavailable',
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
  client = null,
  posthogRunner = runHogQL,
} = {}) {
  const source = readJson(inputPath, 'GSC snapshot');
  const paths = landingPathsFromGsc(source);
  const window = completeUtcWindow(now, days);
  const firestore = client || new GoogleDataClient();
  const config = await resolvePostHogConfig(firestore);
  const response = await posthogRunner(buildL2OutcomeQuery({ paths, window }), config);
  const exported = buildL2DemandExport(source, {
    eligibleLandingSessions: nonNegativeInteger(postHogRow(response, 'eligibleLandingSessions'), 'eligibleLandingSessions'),
    usefulActions: nonNegativeInteger(postHogRow(response, 'usefulActions'), 'usefulActions'),
    generatedAt: now.toISOString(),
    telemetryWindow: window,
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
