#!/usr/bin/env node
/**
 * Valore per sessione di ogni template di landing, dalla GA4 Data API.
 *
 * Serve a ordinare le priorità SEO per valore e non per traffico: a parità di
 * sessioni organiche una landing annuncio/professione/azienda vale 5-9 volte
 * un articolo (audit 2026-10-23), perché porta candidature e clic sugli
 * annunci. Questo script rende quel calcolo riproducibile.
 *
 * Modello (dichiarato nel JSON di output, campo `model`):
 *   valore/sessione = ricavo ads/sessione + candidature/sessione × valore candidatura
 * - ricavo ads   = `totalAdRevenue` GA4 (AdSense collegato), attribuito alla
 *                  landing della sessione; i clic ads (`publisherAdClicks`)
 *                  sono riportati come tasso;
 * - candidatura  = `job_apply_handoff` (redirect verso il datore, key event);
 * - valore candidatura = per default il ricavo medio di UN clic ads del sito
 *                  nella stessa finestra («una candidatura vale un clic»):
 *                  ipotesi prudente e sovrascrivibile con `--apply-value <n>`.
 * Popolazione: hostName frontaliereticino.ch, canale Organic Search (comprende
 * utm_source=google_jobs_apply, medium organic), flotta headless esclusa
 * (scripts/lib/ga4-automation-fleet.mjs). `--channel all` toglie il filtro canale.
 *
 * Usage:
 *   node scripts/landing-value-report.mjs                 # 28 gg settled, tabella
 *   node scripts/landing-value-report.mjs --days 56 --json
 *   node scripts/landing-value-report.mjs --out reports/landing-value-by-template.json
 *
 * Credenziali: GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_SERVICE_ACCOUNT_JSON.
 * Read-only. Documentato in docs/analytics/ga4-misura-affidabile.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyAnalyticsPath } from './lib/analytics-opportunity-utils.mjs';
import { withAutomationFleetExclusion, AUTOMATION_FLEET_EXCLUSION_NOTE } from './lib/ga4-automation-fleet.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  runGa4ReportPaged,
} from './lib/ga4-service-account.mjs';
import { TRAFFIC_HOSTNAME } from './lib/ga4-target-market.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

export const APPLY_EVENT = 'job_apply_handoff';
/** Template used as the 1× reference of `valueIndex`. */
export const REFERENCE_TEMPLATE = 'article_detail';
/** Below this many sessions a template's rates are printed but not ranked. */
export const MIN_RANKED_SESSIONS = 50;

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
}

export function parseArgs(args) {
  const days = Math.max(1, Math.min(90, Math.floor(Number(readOption(args, '--days', 28)) || 28)));
  const applyValueRaw = readOption(args, '--apply-value', null);
  const applyValue = applyValueRaw === null ? null : Number(applyValueRaw);
  if (applyValue !== null && !(applyValue >= 0)) throw new Error('--apply-value deve essere un numero >= 0');
  return {
    days,
    applyValue,
    channel: readOption(args, '--channel', 'organic') === 'all' ? 'all' : 'organic',
    json: args.includes('--json'),
    out: readOption(args, '--out', null),
    propertyId: readOption(args, '--property', process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID),
  };
}

export function buildPopulationFilter(channel = 'organic') {
  const expressions = [{ filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: TRAFFIC_HOSTNAME } } }];
  if (channel === 'organic') {
    expressions.push({ filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } });
  }
  return { andGroup: { expressions } };
}

export function buildReportBodies({ dateRange, channel = 'organic' }) {
  const population = buildPopulationFilter(channel);
  return {
    landings: withAutomationFleetExclusion({
      dateRanges: [dateRange],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'totalAdRevenue' }, { name: 'publisherAdClicks' }],
      dimensionFilter: population,
    }),
    applies: withAutomationFleetExclusion({
      dateRanges: [dateRange],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'eventCount' }, { name: 'sessions' }],
      dimensionFilter: { andGroup: { expressions: [population, { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: APPLY_EVENT } } }] } },
    }),
  };
}

const num = (row, index) => Number(row?.metricValues?.[index]?.value || 0);
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/**
 * Pure aggregation: landing rows + apply rows → per-template value table.
 * `applyValue` null → derived from the site's revenue per ad click.
 */
export function aggregateLandingValue({ landingRows = [], applyRows = [], applyValue = null }) {
  const templates = new Map();
  const bucket = (landingPage) => {
    const pageTemplate = classifyAnalyticsPath(landingPage || '/').pageTemplate || 'other';
    if (!templates.has(pageTemplate)) {
      templates.set(pageTemplate, { pageTemplate, landings: 0, sessions: 0, engagedSessions: 0, adRevenue: 0, adClicks: 0, applies: 0, applySessions: 0, top: [] });
    }
    return templates.get(pageTemplate);
  };
  for (const row of landingRows) {
    const landing = row.dimensionValues?.[0]?.value;
    if (!landing || landing === '(not set)') continue;
    const entry = bucket(landing);
    entry.landings += 1;
    entry.sessions += num(row, 0);
    entry.engagedSessions += num(row, 1);
    entry.adRevenue += num(row, 2);
    entry.adClicks += num(row, 3);
    entry.top.push([landing, num(row, 0)]);
  }
  for (const row of applyRows) {
    const landing = row.dimensionValues?.[0]?.value;
    if (!landing || landing === '(not set)') continue;
    const entry = bucket(landing);
    entry.applies += num(row, 0);
    entry.applySessions += num(row, 1);
  }
  const totals = [...templates.values()].reduce((acc, t) => ({
    sessions: acc.sessions + t.sessions,
    adRevenue: acc.adRevenue + t.adRevenue,
    adClicks: acc.adClicks + t.adClicks,
    applies: acc.applies + t.applies,
  }), { sessions: 0, adRevenue: 0, adClicks: 0, applies: 0 });
  const revenuePerAdClick = totals.adClicks > 0 ? totals.adRevenue / totals.adClicks : 0;
  const effectiveApplyValue = applyValue ?? revenuePerAdClick;

  const rows = [...templates.values()].map((t) => {
    const perSession = (value) => (t.sessions > 0 ? value / t.sessions : 0);
    const adRevenuePerSession = perSession(t.adRevenue);
    const applyValuePerSession = perSession(t.applies) * effectiveApplyValue;
    const valuePerSession = adRevenuePerSession + applyValuePerSession;
    return {
      pageTemplate: t.pageTemplate,
      landings: t.landings,
      sessions: t.sessions,
      engagementRate: round(perSession(t.engagedSessions), 3),
      appliesPer100: round(perSession(t.applies) * 100, 2),
      applySessionsPer100: round(perSession(t.applySessions) * 100, 2),
      adClicksPer100: round(perSession(t.adClicks) * 100, 2),
      adRevenuePerSession: round(adRevenuePerSession, 5),
      applyValuePerSession: round(applyValuePerSession, 5),
      valuePerSession: round(valuePerSession, 5),
      totalValue: round(valuePerSession * t.sessions, 2),
      ranked: t.sessions >= MIN_RANKED_SESSIONS,
      // Biggest landings of the template, so a surprising bucket (e.g. a large
      // generic_page) can be read without re-querying GA4.
      topLandings: t.top.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([landingPage, sessions]) => ({ landingPage, sessions })),
    };
  });
  const reference = rows.find((row) => row.pageTemplate === REFERENCE_TEMPLATE);
  const referenceValue = reference?.ranked && reference.valuePerSession > 0 ? reference.valuePerSession : null;
  const totalValue = rows.reduce((sum, row) => sum + (row.totalValue || 0), 0);
  for (const row of rows) {
    row.valueIndex = referenceValue ? round(row.valuePerSession / referenceValue, 2) : null;
    row.valueShare = totalValue > 0 ? round(row.totalValue / totalValue, 4) : null;
  }
  rows.sort((a, b) => Number(b.ranked) - Number(a.ranked) || b.valuePerSession - a.valuePerSession || b.sessions - a.sessions);
  return {
    model: {
      formula: 'valuePerSession = adRevenue/sessions + job_apply_handoff/sessions × applyValue',
      applyValue: round(effectiveApplyValue, 5),
      applyValueSource: applyValue === null ? 'site revenue per ad click (totalAdRevenue / publisherAdClicks)' : '--apply-value',
      revenuePerAdClick: round(revenuePerAdClick, 5),
      referenceTemplate: REFERENCE_TEMPLATE,
      minRankedSessions: MIN_RANKED_SESSIONS,
    },
    totals: { ...totals, adRevenue: round(totals.adRevenue, 2), totalValue: round(totalValue, 2) },
    templates: rows,
  };
}

function coverage(report, name) {
  const reasons = [];
  if (report.complete === false) reasons.push(`${name}: incomplete pagination`);
  const meta = report.metadata || {};
  if (meta.subjectToThresholding) reasons.push(`${name}: thresholding`);
  if (meta.dataLossFromOtherRow) reasons.push(`${name}: (other) row`);
  if (Array.isArray(meta.dataTruncationReasons) && meta.dataTruncationReasons.length) {
    reasons.push(`${name}: dataTruncationReasons`);
  }
  if (meta.schemaRestrictionResponse?.activeMetricRestrictions?.length) {
    reasons.push(`${name}: schemaRestrictionResponse`);
  }
  if (Array.isArray(meta.samplingMetadatas) && meta.samplingMetadatas.some((sampling) => {
    const read = Number(sampling?.samplesReadCount);
    const space = Number(sampling?.samplingSpaceSize);
    return Number.isFinite(read) && Number.isFinite(space) ? space > read : true;
  })) {
    reasons.push(`${name}: samplingMetadatas`);
  }
  return reasons;
}

export async function buildLandingValueReport({ token, propertyId, days = 28, channel = 'organic', applyValue = null, run = runGa4ReportPaged, now = new Date() }) {
  const dateRange = ga4DateRange(days, 2, now);
  const bodies = buildReportBodies({ dateRange, channel });
  const landings = await run({ token, propertyId, body: bodies.landings });
  const applies = await run({ token, propertyId, body: bodies.applies });
  const result = aggregateLandingValue({ landingRows: landings.rows, applyRows: applies.rows, applyValue });
  return {
    source: 'GA4 Data API',
    generatedAt: now.toISOString(),
    propertyId,
    window: dateRange,
    population: { hostname: TRAFFIC_HOSTNAME, channel: channel === 'organic' ? 'Organic Search' : 'all', excludedSegment: AUTOMATION_FLEET_EXCLUSION_NOTE },
    currency: landings.metadata?.currencyCode || null,
    dataQuality: [...coverage(landings, 'landings'), ...coverage(applies, 'applies')],
    ...result,
  };
}

export function renderMarkdown(report) {
  const cur = report.currency || '';
  const lines = [
    `## Valore per template di landing (${report.population.channel}, ${report.window.startDate} → ${report.window.endDate})`,
    '',
    `Modello: \`${report.model.formula}\` · valore candidatura ${report.model.applyValue} ${cur} (${report.model.applyValueSource}) · indice 1× = ${report.model.referenceTemplate}.`,
    report.dataQuality.length ? `⚠️ Qualità dati: ${report.dataQuality.join('; ')}` : 'Copertura GA4 completa (nessuna soglia, nessuna riga (other)).',
    '',
    '| Template | Sessioni | Candidature/100 | Clic ads/100 | Ricavo ads/sess | Valore/sess | Indice | Quota valore |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.templates) {
    if (!row.ranked) continue;
    lines.push(`| ${row.pageTemplate} | ${row.sessions} | ${row.appliesPer100} | ${row.adClicksPer100} | ${row.adRevenuePerSession} | ${row.valuePerSession} | ${row.valueIndex ?? 'n/d'}× | ${row.valueShare == null ? 'n/d' : `${(row.valueShare * 100).toFixed(1)}%`} |`);
  }
  const unranked = report.templates.filter((row) => !row.ranked);
  if (unranked.length) lines.push('', `Sotto ${report.model.minRankedSessions} sessioni (non in classifica): ${unranked.map((row) => `${row.pageTemplate} (${row.sessions})`).join(', ')}.`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = await getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {} });
  if (!token) throw new Error('GA4 service-account token unavailable (set GOOGLE_APPLICATION_CREDENTIALS)');
  const report = await buildLandingValueReport({ token, ...options });
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error?.message || error}`);
    process.exitCode = 1;
  });
}
