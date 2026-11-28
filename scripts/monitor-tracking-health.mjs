#!/usr/bin/env node
/**
 * monitor-tracking-health.mjs
 *
 * Hourly analytics-tag watchdog (workflow: .github/workflows/tracking-health-monitor.yml).
 * Reads GA4 hourly sessions/events and Cloudflare hourly human HTML requests and
 * asks scripts/lib/tracking-health.mjs whether GA4 fell by more than 40% while
 * the edge traffic stayed stable.
 *
 * The verdict travels in the output, never in the exit code: 0 whenever the run
 * measured, 1 only when it could not (credentials, API, truncated report), so a
 * broken monitor is a red run and never a tracking alarm. Measurements are
 * withheld from stdout and the issue (public repository).
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON (GA4 read),
 *      CF_API_TOKEN (+ optional CF_ZONE_ID), RUN_URL, GITHUB_OUTPUT (status=, alarms=).
 */
import { realpathSync, appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fetchHourlyPageRequests, resolveZoneId } from './lib/cf-analytics.mjs';
import { GA4_READONLY_SCOPE, PRODUCTION_HOST_REGEXP, getServiceAccountToken, runGa4Report } from './lib/ga4-service-account.mjs';
import { dateHourInZone, formatDateHour, parseDateHour } from './lib/revenue-signals.mjs';
import { buildIssueBody, cfRowsToHours, DEFAULT_CONFIG, earliestHourNeeded, trackingDecision } from './lib/tracking-health.mjs';

const ROW_LIMIT = 10_000;
const isoDate = (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

function parseArgs(argv) {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const currentHour = value('current-hour');
  if (currentHour && !(/^\d{10}$/.test(currentHour) && formatDateHour(parseDateHour(currentHour)) === currentHour)) {
    throw new Error(`--current-hour must be a real hour as YYYYMMDDHH, got ${currentHour}`);
  }
  return { currentHour, out: value('out'), bodyOut: value('body-out') };
}

/** GA4 hourly sessions and event count on the production host, keyed by dateHour. */
export async function fetchGa4Hours({ token, currentHour, config = DEFAULT_CONFIG, fetchImpl = fetch }) {
  const report = await runGa4Report({
    token,
    fetchImpl,
    body: {
      dateRanges: [{ startDate: isoDate(earliestHourNeeded(currentHour, config)), endDate: isoDate(currentHour) }],
      dimensions: [{ name: 'dateHour' }],
      metrics: [{ name: 'sessions' }, { name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'FULL_REGEXP', value: PRODUCTION_HOST_REGEXP } } },
      limit: ROW_LIMIT,
    },
  });
  const rows = report.rows?.length ?? 0;
  if ((report.rowCount ?? rows) > rows) throw new Error(`GA4 report truncated: ${rows} of ${report.rowCount} rows`);
  // Days of production traffic never come back empty: empty = query/telemetry failure.
  if (rows === 0) throw new Error('GA4 report returned no rows');
  const hours = {};
  for (const row of report.rows) {
    const [sessions, events] = row.metricValues.map((v) => Number(v.value));
    hours[row.dimensionValues[0].value] = { sessions, events };
  }
  return hours;
}

/** Cloudflare hourly human HTML requests for the windows that cover every hour the evaluation reads. */
export async function fetchCfHours({ token, zoneId, now, fetchImpl = fetch }) {
  // Three consecutive sub-day windows: the free plan keeps ~3 days of hourly rows.
  const windows = [0, 1, 2].map((i) => new Date(now.getTime() - i * 23 * 3_600_000));
  const results = await Promise.all(windows.map((until) => fetchHourlyPageRequests(token, zoneId, { hours: 23, until, fetchImpl })));
  const rows = results.flat();
  if (rows.length === 0) throw new Error('Cloudflare returned no hourly rows');
  return cfRowsToHours(rows);
}

const defaultGetToken = () => getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {}, logError: () => {} });

export async function runMonitor({ argv = [], env = process.env, now = new Date(), fetchImpl = fetch, getToken = defaultGetToken, log = console } = {}) {
  try {
    const { currentHour: replayHour, out, bodyOut } = parseArgs(argv);
    const currentHour = replayHour || dateHourInZone(now);
    const token = await getToken();
    if (!token) throw new Error('no GA4 credentials');
    if (!env.CF_API_TOKEN) throw new Error('no Cloudflare token');
    const zoneId = await resolveZoneId(env.CF_API_TOKEN, undefined, env.CF_ZONE_ID, fetchImpl);
    const [ga4Hours, cfHours] = await Promise.all([
      fetchGa4Hours({ token, currentHour, fetchImpl }),
      fetchCfHours({ token: env.CF_API_TOKEN, zoneId, now, fetchImpl }),
    ]);
    const decision = trackingDecision({ ga4Hours, cfHours, currentHour });
    const result = {
      currentHour,
      status: decision.status,
      targetHour: decision.evaluation.targetHour,
      alarms: decision.evaluation.alarms.map((a) => a.signal),
      checks: decision.evaluation.checks,
    };
    const json = JSON.stringify(result, null, 2);
    if (out) writeFileSync(out, `${json}\n`);
    if (bodyOut && decision.status === 'alarm') writeFileSync(bodyOut, `${buildIssueBody({ decision, runUrl: env.RUN_URL || '' })}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `status=${result.status}\nalarms=${result.alarms.join(',')}\n`);
    log.error(`[tracking-health] status=${result.status}; measurements withheld`);
    return 0;
  } catch {
    log.error('::error::[tracking-health] could not measure; details withheld');
    return 1;
  }
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  runMonitor({ argv: process.argv.slice(2) }).then((code) => process.exit(code));
}
