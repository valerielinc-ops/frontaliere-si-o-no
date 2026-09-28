#!/usr/bin/env node
/**
 * monitor-revenue-signals.mjs
 *
 * Hourly ad-revenue alarm (workflow: .github/workflows/revenue-signal-monitor.yml).
 * Reads GA4 hourly counts for Italy + Switzerland and asks
 * scripts/lib/revenue-signals.mjs whether consent decisions, filled ads,
 * revenue per page or human traffic fell below the same hours of the same
 * weekday in the previous three weeks.
 *
 * It fills the gap the daily canaries leave (rpm-canary.yml, user-value-canary.yml
 * read settled DAYS): on 2026-09-27 the CMP was suppressed from 12h and ad
 * revenue fell ~75% for six hours; nothing noticed until a person did. Consent
 * decisions arrive in GA4 within the hour, so this catches that class in ~2 h.
 *
 * The alarm travels in the output, never in the exit code: 0 whenever the run
 * measured (alarm or not), 1 only when it could not measure (credentials, API,
 * truncated report), so a broken monitor is a red run and never a revenue issue.
 *
 * Usage:
 *   node scripts/monitor-revenue-signals.mjs                       # evaluate the current hour
 *   node scripts/monitor-revenue-signals.mjs --current-hour=2026092714   # replay a past run
 *   node scripts/monitor-revenue-signals.mjs --out=result.json --body-out=issue.md
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON (GA4 read),
 *      RUN_URL (link in the issue body), GITHUB_OUTPUT (status=, alarms=).
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { GA4_READONLY_SCOPE, getServiceAccountToken, runGa4Report } from './lib/ga4-service-account.mjs';
import { DEFAULT_CONFIG, buildIssueBody, dateHourInZone, monitorDecision, shiftDateHour } from './lib/revenue-signals.mjs';

const HUMAN_COUNTRIES = ['Italy', 'Switzerland'];
const AD_EVENTS = ['ad_filled', 'ad_consent_granted', 'ad_consent_denied'];
const ROW_LIMIT = 10_000;

function parseArgs(argv) {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const currentHour = value('current-hour');
  if (currentHour && !/^\d{10}$/.test(currentHour)) throw new Error(`--current-hour must be YYYYMMDDHH, got ${currentHour}`);
  return { currentHour, out: value('out'), bodyOut: value('body-out') };
}

const isoDate = (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

/** Oldest hour any evaluation of this run reads: baseline weeks + recovery look-back + widest window. */
export function earliestHourNeeded(currentHour, config = DEFAULT_CONFIG) {
  const back = Math.max(...config.baselineWeeks) * 168 + config.recoveryRuns + config.revenueWindow.from;
  return shiftDateHour(currentHour, -back);
}

/**
 * GA4 hourly counts keyed by dateHour, in the shape revenue-signals.mjs reads.
 * @param {{ token: string, currentHour: string, config?: typeof DEFAULT_CONFIG, fetchImpl?: typeof fetch }} opts
 */
export async function fetchHourlyCounts({ token, currentHour, config = DEFAULT_CONFIG, fetchImpl = fetch }) {
  const dateRanges = [{ startDate: isoDate(earliestHourNeeded(currentHour, config)), endDate: isoDate(currentHour) }];
  const human = { filter: { fieldName: 'country', inListFilter: { values: HUMAN_COUNTRIES } } };
  const [metrics, events] = await Promise.all([
    runGa4Report({
      token,
      fetchImpl,
      body: {
        dateRanges,
        dimensions: [{ name: 'dateHour' }],
        metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'publisherAdImpressions' }, { name: 'totalAdRevenue' }],
        dimensionFilter: human,
        limit: ROW_LIMIT,
      },
    }),
    runGa4Report({
      token,
      fetchImpl,
      body: {
        dateRanges,
        dimensions: [{ name: 'dateHour' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { andGroup: { expressions: [human, { filter: { fieldName: 'eventName', inListFilter: { values: AD_EVENTS } } }] } },
        limit: ROW_LIMIT,
      },
    }),
  ]);
  for (const [name, report] of [['metrics', metrics], ['events', events]]) {
    const rows = report.rows?.length ?? 0;
    if ((report.rowCount ?? rows) > rows) throw new Error(`GA4 ${name} report truncated: ${rows} of ${report.rowCount} rows`);
  }
  const hours = {};
  for (const row of metrics.rows || []) {
    const [sessions, pageViews, impressions, revenue] = row.metricValues.map((v) => Number(v.value));
    hours[row.dimensionValues[0].value] = { ...hours[row.dimensionValues[0].value], sessions, pageViews, impressions, revenue };
  }
  for (const row of events.rows || []) {
    const [key, eventName] = row.dimensionValues.map((v) => v.value);
    hours[key] = { ...hours[key], [eventName]: Number(row.metricValues[0].value) };
  }
  return hours;
}

async function main() {
  const { currentHour: replayHour, out, bodyOut } = parseArgs(process.argv.slice(2));
  const currentHour = replayHour || dateHourInZone(new Date());
  const token = await getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {}, logError: console.error });
  if (!token) throw new Error('no GA4 credentials: set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON');
  const hours = await fetchHourlyCounts({ token, currentHour });
  const decision = monitorDecision({ hours, currentHour });
  const result = {
    currentHour,
    status: decision.status,
    alarms: decision.evaluation.alarms.map((a) => a.signal),
    lastAlarmHour: decision.lastAlarmHour ?? null,
    checks: decision.evaluation.checks,
  };
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, `${json}\n`);
  else console.log(json);
  if (bodyOut && decision.status === 'alarm') writeFileSync(bodyOut, `${buildIssueBody({ decision, runUrl: process.env.RUN_URL || '' })}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nalarms=${result.alarms.join(',')}\n`);
  console.error(`[revenue-signals] ${currentHour} status=${result.status} ${result.checks.map((c) => `${c.signal}:${c.status}${c.ratio != null ? `(${c.ratio.toFixed(2)})` : ''}`).join(' ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`::error::[revenue-signals] could not measure: ${error?.stack || error}`);
    process.exit(1);
  });
}
