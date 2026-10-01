#!/usr/bin/env node

/**
 * Export the independent, categorical part of the L8 affiliate outcome.
 *
 * Firebase/GA4 proves visible CTA exposures and clicks, but not an approved
 * commission. An authorised network export is therefore joined when one is
 * explicitly present; otherwise the output stays attribution-only and the L8
 * validator keeps approved money unmeasurable. This script is read-only and
 * never changes a partner, price, placement, Auto Ads setting or recipient.
 * Legacy PostHog helpers remain for historical exports; main uses GA4.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHogQL } from '../lib/posthog-client.mjs';
import { getServiceAccountToken, GA4_READONLY_SCOPE, ga4DateRange, runGa4Report } from '../lib/ga4-service-account.mjs';

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
  const evidence = attributionEvidence({
    telemetryWindow: window,
    commercial: suppliedCommercial,
    commercialRowsPresent,
  });
  return {
    ...(suppliedCommercial || {}),
    schemaVersion: 1,
    loopId: LOOP_ID,
    // Keep the network timestamp when a commercial export is present. The
    // current PostHog timestamp must not make an old commission ledger fresh.
    generatedAt: text(suppliedCommercial?.generatedAt) || generated,
    independent: suppliedCommercial?.independent === true && commercialRowsPresent,
    evidence,
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
  commercial = null,
} = {}) {
  const generated = isoDate(generatedAt, 'L8 unavailable generatedAt');
  const window = {
    start: isoDate(telemetryWindow.start, 'L8 unavailable window start'),
    end: isoDate(telemetryWindow.end, 'L8 unavailable window end'),
  };
  const suppliedCommercial = object(commercial) ? commercial : null;
  const rows = suppliedCommercial
    ? (Array.isArray(suppliedCommercial.transactions)
      ? suppliedCommercial.transactions
      : (Array.isArray(suppliedCommercial.rows) ? suppliedCommercial.rows : null))
    : null;
  const commercialRowsPresent = Array.isArray(rows);
  const evidence = suppliedCommercial
    ? attributionEvidence({
      telemetryWindow: window,
      commercial: suppliedCommercial,
      commercialRowsPresent,
    })
    : {
      source: 'posthog-affiliate-attribution-export',
      sourceRefs: ['posthog.affiliate_experiment_exposure', 'posthog.affiliate_click'],
      status: 'missing',
      commercialLedger: 'missing',
      reason: text(reason) || 'live PostHog attribution export unavailable',
      telemetryWindow: window,
    };
  return {
    ...(suppliedCommercial || {}),
    schemaVersion: 1,
    loopId: LOOP_ID,
    // Keep a valid network timestamp when PostHog is unavailable. The
    // telemetry timestamp must never make an old commercial ledger fresh.
    generatedAt: text(suppliedCommercial?.generatedAt) || generated,
    independent: suppliedCommercial?.independent === true && commercialRowsPresent,
    evidence,
    period: suppliedCommercial?.period || periodFromWindow(window),
    clicks: { web: null, email: null, relevant: null, total: null },
    exposures: suppliedCommercial?.exposures || { web: null, email: null },
    transactions: rows,
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
  if (!text(filePath)) return null;
  try {
    const absolute = path.resolve(filePath);
    if (!fs.existsSync(absolute)) return null;
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
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

/** The live pipeline uses Firebase/GA4; PostHog product events are quota-suppressed. */
export async function exportL8Ga4Attribution({
 outputPath = null, now = new Date(), days = DEFAULT_DAYS, commercialPath = null,
 ga4Runner = runGa4Report, tokenProvider = () => getServiceAccountToken([GA4_READONLY_SCOPE]),
} = {}) {
 if (!text(outputPath)) throw new Error('L8 attribution outputPath is required');
 const range = ga4DateRange(days, 2, now);
 const token = await tokenProvider();
 const report = await ga4Runner({ token, body: {
  dateRanges: [range], dimensions: [{ name: 'eventName' }, { name: 'customEvent:attribution_id' }], metrics: [{ name: 'eventCount' }],
  dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['affiliate_impression', 'affiliate_click'] } } },
  limit: '10000',
 } });
 if (!object(report) || report.metadata?.subjectToThresholding || report.metadata?.dataLossFromOtherRow || report.metadata?.samplingMetadatas?.length) throw new Error('GA4 affiliate report is missing, thresholded or sampled');
 const rows = report.rows ?? [];
 if (!Array.isArray(rows) || Number(report?.rowCount ?? rows.length) !== rows.length) throw new Error('GA4 affiliate report is truncated or invalid');
 const counts = { affiliate_impression: 0, affiliate_click: 0 };
 const byPlacement = new Map();
 for (const row of rows) {
  const event = row?.dimensionValues?.[0]?.value;
  if (!Object.hasOwn(counts, event)) throw new Error('GA4 affiliate report contains an unknown event');
  const count = integer(row?.metricValues?.[0]?.value, event);
  counts[event] += count;
  const id = row?.dimensionValues?.[1]?.value;
  if (typeof id === 'string' && /^[a-z0-9-]{1,48}$/.test(id)) {
   const placement = byPlacement.get(id) || { attributionId: id, impressions: 0, clicks: 0 };
   placement[event === 'affiliate_impression' ? 'impressions' : 'clicks'] += count;
   byPlacement.set(id, placement);
  }
 }
 const telemetryWindow = { start: `${range.startDate}T00:00:00.000Z`, end: new Date(Date.parse(range.endDate) + DAY_MS).toISOString() };
 const commercial = readOptionalCommercial(commercialPath);
 const outcome = buildL8AttributionExport({
  aggregate: { webExposures: counts.affiliate_impression, webClicks: counts.affiliate_click, emailExposures: 0, emailClicks: 0,
   sourceEvents: counts.affiliate_impression + counts.affiliate_click },
  generatedAt: now, telemetryWindow, commercial,
 });
 // Web CTA events cannot prove email delivery/clicks. Preserve only explicit network data.
 outcome.exposures.email = commercial?.exposures?.email ?? null;
 outcome.clicks.email = commercial?.clicks?.email ?? null;
 outcome.clicks.relevant = outcome.clicks.total = outcome.clicks.email === null ? null : outcome.clicks.web + outcome.clicks.email;
 outcome.attribution.source = 'ga4';
 outcome.attribution.byPlacement = [...byPlacement.values()];
 outcome.exposures.byAttribution = Object.fromEntries([...byPlacement.values()].map(row => [row.attributionId, row.impressions]));
 outcome.evidence.source = commercial?.evidence?.source || 'ga4-affiliate-attribution-export';
 if (!commercial) outcome.evidence.commercialLedger = 'not_configured';
 outcome.evidence.sourceRefs = [...new Set([...(commercial?.evidence?.sourceRefs || []), 'ga4.affiliate_impression', 'ga4.affiliate_click'])];
 outcome.evidence.eventContract = {
  exposure: 'affiliate_impression: paid CTA visible at least 10%, once per mounted placement',
  click: 'affiliate_click: primary, keyboard or middle click on a paid CTA',
  attribution: 'attribution_id equals the /go/ pos and network pubref; categorical placement, not person identity',
  identity: 'no person, email, URL or account fields selected',
 };
 // A differently dated ledger must not be divided by this window's CTA counts.
 if (commercial && (!commercial.period || commercial.period.from !== range.startDate || commercial.period.to !== range.endDate)) {
  outcome.exposures = commercial.exposures || { web: null, email: null };
  outcome.clicks = commercial.clicks || { web: null, email: null, relevant: null, total: null };
  outcome.evidence.telemetryJoin = 'unjoined: commercial and telemetry periods differ';
 }
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
  const commercialPath = valueAfter(argv, '--commercial');
  const outcome = argv.includes('--unavailable')
    ? buildUnavailableL8AttributionExport({
      generatedAt: now,
      telemetryWindow: window,
      reason: valueAfter(argv, '--reason'),
      commercial: readOptionalCommercial(commercialPath),
    })
    : await exportL8Ga4Attribution({
      outputPath,
      now,
      days,
      commercialPath,
    });
  if (argv.includes('--unavailable')) {
    outcome.attribution.source = 'ga4';
    if (!readOptionalCommercial(commercialPath)) {
      outcome.evidence.source = 'ga4-affiliate-attribution-export';
      outcome.evidence.sourceRefs = ['ga4.affiliate_impression', 'ga4.affiliate_click'];
      outcome.evidence.reason = valueAfter(argv, '--reason') || 'live GA4 attribution export unavailable';
    }
    writeJson(outputPath, outcome);
  }
  if (argv.includes('--json')) logger.log(JSON.stringify(outcome, null, 2));
  return outcome;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L8 attribution export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
