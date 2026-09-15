#!/usr/bin/env node

/**
 * Export the independent, categorical part of the L8 affiliate outcome.
 *
 * PostHog can prove exposures and clicks, but it cannot prove an approved
 * commission. An authorised network export is therefore joined when one is
 * explicitly present; otherwise the output stays attribution-only and the L8
 * validator keeps approved money unmeasurable. This script is read-only and
 * never changes a partner, price, placement, Auto Ads setting or recipient.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHogQL } from '../lib/posthog-client.mjs';

export const LOOP_ID = 'L8';
export const DEFAULT_DAYS = 8;
export const AFFILIATE_EVENTS = Object.freeze([
  'affiliate_experiment_exposure',
  'affiliate_click',
]);

const DAY_MS = 86_400_000;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, label) {
  if (value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || typeof value === 'boolean') {
    throw new Error(`PostHog returned invalid ${label}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`PostHog returned invalid ${label}`);
  return parsed;
}

function isoDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

export function completeUtcWindow(now = new Date(), days = DEFAULT_DAYS) {
  const count = Number(days);
  if (!Number.isInteger(count) || count < 1 || count > 31) {
    throw new Error('L8 attribution window must be an integer between 1 and 31 days');
  }
  const endMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return {
    start: new Date(endMs - count * DAY_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

function periodFromWindow(window) {
  return {
    from: window.start.slice(0, 10),
    to: new Date(Date.parse(window.end) - DAY_MS).toISOString().slice(0, 10),
  };
}

function aggregateRow(response) {
  const columns = Array.isArray(response?.columns) ? response.columns : [];
  const row = response?.results?.[0];
  if (Array.isArray(row)) {
    return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  }
  if (object(row)) return row;
  throw new Error('PostHog returned no L8 affiliate aggregate row');
}

export function buildL8AttributionQuery({ start, end } = {}) {
  const from = isoDate(start, 'L8 attribution start');
  const to = isoDate(end, 'L8 attribution end');
  if (Date.parse(to) <= Date.parse(from)) throw new Error('L8 attribution window end must follow start');
  return [
    'SELECT',
    "  countIf(event = 'affiliate_experiment_exposure' AND properties.surface = 'web') AS webExposures,",
    "  countIf(event = 'affiliate_experiment_exposure' AND properties.surface IN ('email', 'newsletter')) AS emailExposures,",
    "  countIf(event = 'affiliate_click' AND properties.surface = 'web') AS webClicks,",
    "  countIf(event = 'affiliate_click' AND properties.surface IN ('email', 'newsletter')) AS emailClicks,",
    '  count() AS sourceEvents',
    'FROM events',
    `WHERE event IN (${AFFILIATE_EVENTS.map((event) => `'${event}'`).join(', ')})`,
    `  AND timestamp >= '${from}' AND timestamp < '${to}'`,
  ].join('\n');
}

function attributionEvidence({ telemetryWindow, commercial, commercialRowsPresent }) {
  const commercialEvidence = object(commercial?.evidence) ? commercial.evidence : {};
  const configuredRefs = Array.isArray(commercialEvidence.sourceRefs)
    ? commercialEvidence.sourceRefs.filter(text).map((sourceRef) => sourceRef.trim())
    : [];
  const sourceRefs = [...new Set([
    ...configuredRefs,
    'posthog.affiliate_experiment_exposure',
    'posthog.affiliate_click',
  ])];
  return {
    ...commercialEvidence,
    source: text(commercialEvidence.source) || 'posthog-affiliate-attribution-export',
    sourceRefs,
    status: text(commercialEvidence.status) || (
      commercialRowsPresent
        ? 'commercial-export-present'
        : (commercial ? 'commercial-export-incomplete' : 'attribution-only')
    ),
    commercialLedger: commercialRowsPresent ? 'supplied-by-authorised-export' : 'missing',
    telemetryWindow,
    eventContract: {
      exposure: 'affiliate_experiment_exposure with categorical surface/campaign/variant',
      click: 'affiliate_click with categorical partner_id/surface/position/campaign/variant',
      identity: 'no person, email, URL or account fields selected',
    },
  };
}

export function buildL8AttributionExport({
  aggregate,
  generatedAt,
  telemetryWindow,
  commercial = null,
} = {}) {
  const webExposures = integer(aggregate?.webExposures, 'webExposures');
  const emailExposures = integer(aggregate?.emailExposures, 'emailExposures');
  const webClicks = integer(aggregate?.webClicks, 'webClicks');
  const emailClicks = integer(aggregate?.emailClicks, 'emailClicks');
  const sourceEvents = integer(aggregate?.sourceEvents, 'sourceEvents');
  const generated = isoDate(generatedAt, 'L8 attribution generatedAt');
  const window = {
    start: isoDate(telemetryWindow?.start, 'L8 attribution window start'),
    end: isoDate(telemetryWindow?.end, 'L8 attribution window end'),
  };
  const suppliedCommercial = object(commercial) ? commercial : null;
  const rows = suppliedCommercial
    ? (Array.isArray(suppliedCommercial.transactions)
      ? suppliedCommercial.transactions
      : (Array.isArray(suppliedCommercial.rows) ? suppliedCommercial.rows : null))
    : null;
  const commercialRowsPresent = Array.isArray(rows);
  return {
    ...(suppliedCommercial || {}),
    schemaVersion: 1,
    loopId: LOOP_ID,
    // Keep the network timestamp when a commercial export is present. The
    // current PostHog timestamp must not make an old commission ledger fresh.
    generatedAt: text(suppliedCommercial?.generatedAt) || generated,
    independent: suppliedCommercial?.independent === true && commercialRowsPresent,
    evidence: attributionEvidence({
      telemetryWindow: window,
      commercial: suppliedCommercial,
      commercialRowsPresent,
    }),
    period: suppliedCommercial?.period || periodFromWindow(window),
    clicks: {
      web: webClicks,
      email: emailClicks,
      relevant: webClicks + emailClicks,
      total: webClicks + emailClicks,
    },
    exposures: { web: webExposures, email: emailExposures },
    transactions: rows,
    attribution: {
      source: 'posthog',
      sourceEvents,
      telemetryWindow: window,
      identityFieldsSelected: [],
      externalCommercialStateUntouched: true,
      partnerStateUntouched: true,
      pricesUntouched: true,
      publishedDataUntouched: true,
    },
  };
}

export function buildUnavailableL8AttributionExport({
  generatedAt = new Date(),
  telemetryWindow = completeUtcWindow(generatedAt),
  reason = 'live PostHog attribution export unavailable',
} = {}) {
  const generated = isoDate(generatedAt, 'L8 unavailable generatedAt');
  const window = {
    start: isoDate(telemetryWindow.start, 'L8 unavailable window start'),
    end: isoDate(telemetryWindow.end, 'L8 unavailable window end'),
  };
  return {
    schemaVersion: 1,
    loopId: LOOP_ID,
    generatedAt: generated,
    independent: false,
    evidence: {
      source: 'posthog-affiliate-attribution-export',
      sourceRefs: ['posthog.affiliate_experiment_exposure', 'posthog.affiliate_click'],
      status: 'missing',
      commercialLedger: 'missing',
      reason: text(reason) || 'live PostHog attribution export unavailable',
      telemetryWindow: window,
    },
    period: periodFromWindow(window),
    clicks: { web: null, email: null, relevant: null, total: null },
    exposures: { web: null, email: null },
    transactions: null,
    attribution: {
      source: 'posthog',
      sourceEvents: null,
      telemetryWindow: window,
      identityFieldsSelected: [],
      externalCommercialStateUntouched: true,
      partnerStateUntouched: true,
      pricesUntouched: true,
      publishedDataUntouched: true,
    },
  };
}

function readOptionalCommercial(filePath) {
  if (!text(filePath) || !fs.existsSync(path.resolve(filePath))) return null;
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function writeJson(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exportL8Attribution({
  outputPath,
  now = new Date(),
  days = DEFAULT_DAYS,
  commercialPath = null,
  posthogRunner = runHogQL,
} = {}) {
  if (!text(outputPath)) throw new Error('L8 attribution outputPath is required');
  const window = completeUtcWindow(now, days);
  const response = await posthogRunner(buildL8AttributionQuery(window));
  const outcome = buildL8AttributionExport({
    aggregate: aggregateRow(response),
    generatedAt: now,
    telemetryWindow: window,
    commercial: readOptionalCommercial(commercialPath),
  });
  writeJson(outputPath, outcome);
  return outcome;
}

function valueAfter(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1] || fallback;
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outputPath = valueAfter(argv, '--out');
  if (!outputPath) throw new Error('--out is required');
  const now = new Date();
  const days = Number(valueAfter(argv, '--days', DEFAULT_DAYS));
  const window = completeUtcWindow(now, days);
  const outcome = argv.includes('--unavailable')
    ? buildUnavailableL8AttributionExport({
      generatedAt: now,
      telemetryWindow: window,
      reason: valueAfter(argv, '--reason'),
    })
    : await exportL8Attribution({
      outputPath,
      now,
      days,
      commercialPath: valueAfter(argv, '--commercial'),
    });
  if (argv.includes('--unavailable')) writeJson(outputPath, outcome);
  if (argv.includes('--json')) logger.log(JSON.stringify(outcome, null, 2));
  return outcome;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L8 attribution export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
