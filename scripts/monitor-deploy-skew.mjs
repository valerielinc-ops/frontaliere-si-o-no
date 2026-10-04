#!/usr/bin/env node
/**
 * monitor-deploy-skew.mjs
 *
 * Hourly deploy-skew alarm from the users' side (workflow: deploy-skew-monitor.yml).
 * Reads GA4 `app_error` per hour for Italy + Switzerland with either skew
 * signature and asks scripts/lib/deploy-skew-signal.mjs whether a closed hour
 * crossed 20 events AND 5 users. Why GA4 and why IT+CH: see that module.
 *
 * The alarm travels in the output, never in the exit code: 0 whenever the run
 * measured (alarm or not), 1 only when it could not measure (credentials, API,
 * truncated report, a sessions probe with no rows), so a broken monitor is a
 * red run and never a skew issue. An EMPTY errors report is the normal case.
 *
 * Usage:
 *   node scripts/monitor-deploy-skew.mjs                              # evaluate the current hour
 *   node scripts/monitor-deploy-skew.mjs --current-hour=2026092509    # replay a past run
 *   node scripts/monitor-deploy-skew.mjs --out=result.json --body-out=issue.md
 *   node scripts/monitor-deploy-skew.mjs --all-countries              # DIAGNOSIS only: no country filter
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON (GA4 read),
 *      RUN_URL (link in the issue body), GITHUB_OUTPUT (status=, alarm_hours=).
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { GA4_READONLY_SCOPE, getServiceAccountToken, runGa4Report } from './lib/ga4-service-account.mjs';
import {
  DEFAULT_CONFIG,
  SCOPE_ALL_COUNTRIES,
  SCOPE_TARGET_MARKET,
  buildIssueBody,
  buildSkewRequests,
  evaluateSkew,
} from './lib/deploy-skew-signal.mjs';
import { dateHourInZone, formatDateHour, parseDateHour, shiftDateHour } from './lib/revenue-signals.mjs';

function parseArgs(argv) {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const currentHour = value('current-hour');
  // Round-trip through a Date: 2026093214 (no such day) must not reach GA4.
  if (currentHour && !(/^\d{10}$/.test(currentHour) && formatDateHour(parseDateHour(currentHour)) === currentHour)) {
    throw new Error(`--current-hour must be a real hour as YYYYMMDDHH, got ${currentHour}`);
  }
  return { currentHour, out: value('out'), bodyOut: value('body-out'), allCountries: argv.includes('--all-countries') };
}

function assertComplete(name, report) {
  const rows = report.rows?.length ?? 0;
  if ((report.rowCount ?? rows) > rows) throw new Error(`GA4 ${name} report truncated: ${rows} of ${report.rowCount} rows`);
  return report.rows || [];
}

/**
 * Both GA4 reports of one run, validated.
 * @returns {Promise<{ hours: Array<{ dateHour: string, events: number, users: number }>, liveHours: string[], probe: { hours: number, sessions: number } }>}
 */
export async function fetchSkewCounts({ token, currentHour, config = DEFAULT_CONFIG, allCountries = false, fetchImpl = fetch }) {
  const requests = buildSkewRequests({ currentHour, config, allCountries });
  const [errors, probe] = await Promise.all([
    runGa4Report({ token, fetchImpl, body: requests.errors }),
    runGa4Report({ token, fetchImpl, body: requests.probe }),
  ]);
  const errorRows = assertComplete('errors', errors);
  const probeRows = assertComplete('probe', probe);
  // The judged window: the `historyHours` closed hours before the run.
  const from = shiftDateHour(currentHour, -config.historyHours);
  const inWindow = (key) => key >= from && key < currentHour;
  const sessionHours = probeRows.filter((r) => inWindow(r.dimensionValues[0].value));
  // A day and a half of Italy+Switzerland traffic is never empty: no sessions
  // means the telemetry or the query is broken, and an empty errors report
  // read on top of it would be a silent "ok". This proves life over the whole
  // window only; a gap inside the recovery window is caught by `liveHours` in
  // evaluateSkew, which then refuses to report `recovered`.
  if (sessionHours.length === 0) throw new Error(`GA4 probe returned no sessions for ${allCountries ? SCOPE_ALL_COUNTRIES : SCOPE_TARGET_MARKET} between ${from} and ${currentHour}`);
  return {
    hours: errorRows.map((r) => ({ dateHour: r.dimensionValues[0].value, events: Number(r.metricValues[0].value), users: Number(r.metricValues[1].value) })),
    liveHours: sessionHours.filter((r) => Number(r.metricValues[0].value) > 0).map((r) => r.dimensionValues[0].value),
    probe: { hours: sessionHours.length, sessions: sessionHours.reduce((sum, r) => sum + Number(r.metricValues[0].value), 0) },
  };
}

const defaultGetToken = () => getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {}, logError: console.error });

/**
 * One monitor run; resolves to the process exit code. `status=` reaches
 * GITHUB_OUTPUT only after a real measurement, so the workflow's issue steps
 * never act on a run that failed.
 */
export async function runMonitor({ argv = [], env = process.env, now = new Date(), fetchImpl = fetch, getToken = defaultGetToken, log = console } = {}) {
  try {
    const { currentHour: replayHour, out, bodyOut, allCountries } = parseArgs(argv);
    const currentHour = replayHour || dateHourInZone(now);
    const token = await getToken();
    if (!token) throw new Error('no GA4 credentials: set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON');
    const { hours, liveHours, probe } = await fetchSkewCounts({ token, currentHour, allCountries, fetchImpl });
    const evaluation = evaluateSkew({ hours, currentHour, liveHours });
    const result = {
      currentHour,
      status: evaluation.status,
      alarmHours: evaluation.alarmHours,
      lastAlarmHour: evaluation.lastAlarmHour,
      scope: allCountries ? SCOPE_ALL_COUNTRIES : SCOPE_TARGET_MARKET,
      config: evaluation.config,
      checks: evaluation.checks,
      probe,
    };
    const json = JSON.stringify(result, null, 2);
    if (out) writeFileSync(out, `${json}\n`);
    else log.log(json);
    if (bodyOut && result.status === 'alarm') writeFileSync(bodyOut, `${buildIssueBody({ result: evaluation, runUrl: env.RUN_URL || '' })}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `status=${result.status}\nalarm_hours=${result.alarmHours.join(',')}\n`);
    log.error(`[deploy-skew] ${currentHour} scope=${result.scope} status=${result.status} ${result.checks.map((c) => `${c.dateHour}:${c.events}/${c.users}`).join(' ')} probe=${probe.sessions} sessions/${probe.hours}h`);
    return 0;
  } catch (error) {
    log.error(`::error::[deploy-skew] could not measure: ${error?.stack || error}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runMonitor({ argv: process.argv.slice(2) }).then((code) => process.exit(code));
}
