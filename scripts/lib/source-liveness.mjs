/**
 * source-liveness.mjs — the vitality guard every monitor must pass before it
 * is allowed to emit a judgement.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * PostHog ingestion for project 157802 stopped on 2026-07-23 and did not
 * resume until 2026-08-10. Measured on 2026-08-14 (events/day, `count()`
 * grouped by `toDate(timestamp)`):
 *
 *     2026-07-22   90.027   <- alive
 *     2026-07-23    3.569   <- the day it died
 *     2026-07-24       26
 *     ...              5-64   (18 consecutive days)
 *     2026-08-09        7
 *     2026-08-10   65.975   <- alive again
 *     2026-08-13  116.003
 *
 * For those three weeks every monitor reading PostHog kept running against a
 * dead source and kept exiting 0. A HogQL query over an empty window is a
 * perfectly successful HTTP 200 returning `[[0, null, null]]`, so:
 *
 *   - the "all queries failed" guards never tripped (nothing failed);
 *   - the sample floors (`MIN_SAMPLES_PER_METRIC`, `MIN_COUNT`) turned the
 *     hole into silence instead of an alarm;
 *   - `data/cwv-monitor-history.json` recorded `n=0` for every page, week
 *     after week, and the workflow stayed green.
 *
 * Issues #5606, #5607 and #5608 were opened out of that hole — noise
 * indistinguishable from signal — and #5607/#5670 were then closed with the
 * reasoning "PostHog is blind", which had silently stopped being true.
 *
 * So the bug is NOT PostHog. The bug is that a monitor does not verify that
 * its own source is alive over the window it is about to judge, which makes a
 * dead source and a healthy site produce the same output. That makes every
 * such monitor a source of false issues.
 *
 * THE CONTRACT
 * ------------
 * Before emitting any judgement, a monitor calls the guard for the SAME
 * window it is about to measure. If the source is not alive, the monitor must
 *
 *   1. declare "non misurabile" LOUDLY (see `declareNotMeasurable`), and
 *   2. abstain — emit no number and open no issue.
 *
 * Both halves matter. Emitting a number off a dead source is how #5606-#5608
 * were born; staying quiet is how the hole survived three weeks unnoticed.
 * Abstention is therefore never silent: it prints a banner and a GitHub
 * Actions `::warning::` annotation, and `scripts/check-source-liveness.mjs`
 * raises exactly ONE deduped issue for the dead source itself — so the
 * outage is reported once, by the component whose job it is, instead of
 * being reported twelve times as twelve fake metric regressions.
 *
 * WHY A DAILY FLOOR, AND WHY 500
 * ------------------------------
 * The live floor and the dead ceiling are three orders of magnitude apart on
 * this project: the quietest genuinely-live day in the last 40 was 30.030
 * events, the busiest dead day was 64. Any threshold in between separates
 * them cleanly. 500/day sits ~8x above the observed dead ceiling and ~60x
 * below the observed live floor, so neither a weekend traffic dip nor a
 * partial outage can be mistaken for the other.
 *
 * WHY "EVERY COMPLETE DAY", NOT "SOME DAY"
 * ----------------------------------------
 * A monitor computing a p75 (or a count, or a rate) over a 7-day window mixes
 * every day in that window into one number. One dead day corrupts the result,
 * so the honest question is "was the source alive for the WHOLE window I am
 * about to judge", not "did it have a pulse at some point". A 7-day window
 * ending 2026-08-14 spans 08-07..08-13, which straddles the restart — four
 * live days and three dead ones. That window is genuinely not measurable, and
 * the guard says so rather than averaging across the discontinuity.
 *
 * The current UTC day is always excluded: it is partial by construction and
 * would report a false "dead" for every run before ~01:00Z.
 *
 * `maxDeadDays` loosens this for a caller that can defend the looser rule.
 * It defaults to 0.
 */

import { runHogQL } from './posthog-client.mjs';
import {
  GA4_READONLY_SCOPE,
  PRODUCTION_HOST_REGEXP,
  getServiceAccountToken,
  runGa4Report,
} from './ga4-service-account.mjs';

/**
 * THE SOURCE THE MONITORS READ (decisione H9 del proprietario, 2026-10-05)
 * ------------------------------------------------------------------------
 * «Rimpiazza PostHog con GA4». PostHog is under quota on purpose (owner
 * decision 2026-08-25: the paid quota is not bought), so it ingests 4-87
 * events/day against the 500/day floor — permanently, by choice, not as an
 * outage. Probing it as the fleet's expected source made Source Liveness
 * reopen issue 5921 forever while every monitor was already reading GA4
 * through its fallback branch.
 *
 * So the monitors read GA4 as their PRIMARY source, the vitality guard probes
 * GA4 (`checkGa4Liveness`), and `scripts/check-source-liveness.mjs` raises its
 * single outage issue for GA4. `checkPostHogLiveness` stays for the remaining
 * declared PostHog readers (`POSTHOG_MONITORS`) and for manual diagnosis; the
 * client-side PostHog code keeps sending historical telemetry (CLAUDE.md).
 */
export const MONITOR_SOURCE = 'ga4';

/**
 * GA4 days settle after ~48h: yesterday is still being processed and reads
 * low. The GA4 probe therefore judges the same settled window every GA4
 * monitor queries (`ga4DateRange(windowDays, 2)`), i.e. the days ending two
 * days ago.
 */
export const GA4_LIVENESS_LAG_DAYS = 2;

/**
 * Events/day below which the source counts as not ingesting. See the header
 * for the measurement this is derived from.
 */
export const DEFAULT_MIN_EVENTS_PER_DAY = 500;

/** Days of history the liveness probe asks for beyond the measured window. */
const PROBE_MARGIN_DAYS = 2;

const utcDayString = (date) => date.toISOString().slice(0, 10);

/**
 * The list of complete UTC days covered by a `windowDays` lookback ending
 * "now" — i.e. yesterday going back `windowDays` days. Today is excluded
 * (partial). Oldest first.
 */
export function completeDaysInWindow(windowDays, now = new Date(), lagDays = 1) {
  const days = [];
  // `lagDays` = how many trailing days are not yet judgeable: 1 drops only
  // today (PostHog, UTC), 2 also drops yesterday (GA4 processing lag).
  const lag = Math.max(1, Number(lagDays) || 1);
  for (let back = Number(windowDays) + lag - 1; back >= lag; back -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - back);
    days.push(utcDayString(d));
  }
  return days;
}

/**
 * Pure verdict function — no network, no clock of its own. This is the piece
 * the guard test mutates, precisely because everything else is plumbing.
 *
 * @param {object} opts
 * @param {Map<string,number>|Record<string,number>|Array<[string,number]>} opts.dailyCounts
 *        events per UTC day, keyed `YYYY-MM-DD`. Missing day === 0 events.
 * @param {number} opts.windowDays          window the caller is about to judge
 * @param {number} [opts.minEventsPerDay]   floor, default 500
 * @param {number} [opts.maxDeadDays]       tolerated days below floor, default 0
 * @param {number} [opts.lagDays]           trailing days not yet judgeable, default 1 (today)
 * @param {Date}   [opts.now]
 * @returns {{alive: boolean, reason: string, windowDays: number, floor: number,
 *            daysEvaluated: string[], deadDays: Array<{date: string, count: number}>,
 *            totalEvents: number, source: string}}
 */
export function evaluateLiveness({
  dailyCounts,
  windowDays,
  minEventsPerDay = DEFAULT_MIN_EVENTS_PER_DAY,
  maxDeadDays = 0,
  lagDays = 1,
  now = new Date(),
  source = 'posthog',
}) {
  const counts =
    dailyCounts instanceof Map
      ? dailyCounts
      : new Map(Array.isArray(dailyCounts) ? dailyCounts : Object.entries(dailyCounts ?? {}));

  const days = completeDaysInWindow(Number(windowDays), now, lagDays);
  const deadDays = [];
  let totalEvents = 0;

  for (const date of days) {
    const count = Number(counts.get(date) ?? 0);
    totalEvents += count;
    // `<` and not `<=`: a day exactly at the floor is alive. The floor is a
    // minimum, not an exclusive bound.
    if (count < minEventsPerDay) deadDays.push({ date, count });
  }

  const alive = deadDays.length <= maxDeadDays;
  const reason = alive
    ? `${source} ingested >= ${minEventsPerDay} events on each of the ${days.length} complete day(s) in the ${windowDays}d window (${totalEvents} total)`
    : `${source} ingested < ${minEventsPerDay} events/day on ${deadDays.length} of ${days.length} complete day(s) in the ${windowDays}d window: ` +
      `${deadDays.map((d) => `${d.date} (${d.count})`).join(', ')}`;

  return { alive, reason, windowDays: Number(windowDays), floor: minEventsPerDay, daysEvaluated: days, deadDays, totalEvents, source };
}

/**
 * Ask PostHog how many events it ingested per day over the window, then rule
 * on it. Any failure to answer the question is itself "not measurable" — a
 * probe that cannot run must never be read as a healthy source.
 *
 * @returns {Promise<object>} the `evaluateLiveness` verdict, plus
 *   `credentialsMissing` / `probeFailed` for the two non-verdict outcomes.
 */
export async function checkPostHogLiveness({
  windowDays = 7,
  minEventsPerDay = DEFAULT_MIN_EVENTS_PER_DAY,
  maxDeadDays = 0,
  apiKey = process.env.POSTHOG_PERSONAL_API_KEY,
  projectId = process.env.POSTHOG_PROJECT_ID,
  host = process.env.POSTHOG_HOST || 'https://eu.posthog.com',
  now = new Date(),
  runHogQLImpl = runHogQL,
  eventFilter = '',
} = {}) {
  const base = {
    alive: false,
    windowDays: Number(windowDays),
    floor: minEventsPerDay,
    daysEvaluated: [],
    deadDays: [],
    totalEvents: 0,
    source: 'posthog',
  };

  if (!apiKey || !projectId) {
    return { ...base, credentialsMissing: true, reason: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing — liveness cannot be established' };
  }

  const lookback = Number(windowDays) + PROBE_MARGIN_DAYS;
  const query = `
    SELECT toDate(timestamp) AS d, count() AS n
    FROM events
    WHERE timestamp > now() - INTERVAL ${lookback} DAY${eventFilter ? `\n      AND ${eventFilter}` : ''}
    GROUP BY d
    ORDER BY d DESC
  `.trim();

  let rows;
  try {
    const result = await runHogQLImpl(query, { apiKey, projectId, host });
    rows = result?.results ?? [];
  } catch (e) {
    return { ...base, probeFailed: true, reason: `liveness probe failed (${e.message}) — source cannot be confirmed alive` };
  }

  const dailyCounts = new Map(rows.map(([d, n]) => [String(d).slice(0, 10), Number(n) || 0]));
  // `dailyCounts` rides along so a caller judging several different windows
  // (campaign-goal-check has 14d and 30d goals) can re-rule on a sub-window
  // via `evaluateLiveness` without paying for another probe — and without
  // over-abstaining by applying the widest window's verdict to all of them.
  return { ...evaluateLiveness({ dailyCounts, windowDays, minEventsPerDay, maxDeadDays, now, source: 'posthog' }), dailyCounts };
}

const ga4DateToIso = (value) => {
  const v = String(value ?? '');
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v.slice(0, 10);
};

/**
 * Ask GA4 how many events the production host sent per day over the settled
 * window, then rule on it with the same `evaluateLiveness` floor. A GA4
 * runReport over an empty window is an HTTP 200 with no rows — the exact
 * failure mode of the 2026-07-23 PostHog outage — so missing days count as
 * zero, and a probe that cannot run (no service account, API error) is "not
 * measurable", never "alive".
 *
 * Production host only: the property also receives dev-server events, which
 * would keep a dead production stream looking alive.
 *
 * @returns {Promise<object>} the `evaluateLiveness` verdict plus `dailyCounts`,
 *   or `credentialsMissing` / `probeFailed` for the two non-verdict outcomes.
 */
export async function checkGa4Liveness({
  windowDays = 7,
  minEventsPerDay = DEFAULT_MIN_EVENTS_PER_DAY,
  maxDeadDays = 0,
  lagDays = GA4_LIVENESS_LAG_DAYS,
  now = new Date(),
  getTokenImpl = getServiceAccountToken,
  runReportImpl = runGa4Report,
  propertyId,
} = {}) {
  const days = completeDaysInWindow(Number(windowDays), now, lagDays);
  const base = {
    alive: false,
    windowDays: Number(windowDays),
    floor: minEventsPerDay,
    daysEvaluated: days,
    deadDays: [],
    totalEvents: 0,
    source: 'ga4',
  };

  let token;
  try {
    token = await getTokenImpl([GA4_READONLY_SCOPE]);
  } catch (e) {
    token = null;
  }
  if (!token) {
    return { ...base, credentialsMissing: true, reason: 'GA4 service account (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON) missing or not authorised — liveness cannot be established' };
  }

  // A small margin before the window, like the PostHog probe, so a caller can
  // re-rule a shorter sub-window from the same counts.
  const start = new Date(`${days[0]}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - PROBE_MARGIN_DAYS);
  const body = {
    dateRanges: [{ startDate: start.toISOString().slice(0, 10), endDate: days[days.length - 1] }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'hostName', stringFilter: { value: PRODUCTION_HOST_REGEXP, matchType: 'FULL_REGEXP' } } },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 400,
  };

  let rows;
  try {
    const data = await runReportImpl({ token, body, propertyId });
    rows = data?.rows ?? [];
  } catch (e) {
    return { ...base, probeFailed: true, reason: `GA4 liveness probe failed (${e.message}) — source cannot be confirmed alive` };
  }

  const dailyCounts = new Map(
    rows.map((row) => [ga4DateToIso(row?.dimensionValues?.[0]?.value), Number(row?.metricValues?.[0]?.value) || 0]),
  );
  return {
    ...evaluateLiveness({ dailyCounts, windowDays, minEventsPerDay, maxDeadDays, lagDays, now, source: 'ga4' }),
    dailyCounts,
  };
}

/**
 * The loud half of abstaining. Prints a banner that cannot be mistaken for a
 * normal "nothing to report" line, plus a GitHub Actions `::warning::`
 * annotation so the run summary shows it without anyone opening the log.
 *
 * Returns the payload so a caller can also persist/serialise it.
 */
const defaultDiagnosticLogger = {
  warn: (...args) => console.error(...args),
  log: (...args) => console.error(...args),
};

export function declareNotMeasurable(monitorName, verdict, { logger = defaultDiagnosticLogger } = {}) {
  const bar = '='.repeat(70);
  const lines = [
    bar,
    `[${monitorName}] NON MISURABILE — la sorgente non e' viva sulla finestra misurata`,
    `  sorgente : ${verdict.source ?? 'posthog'}`,
    `  finestra : ${verdict.windowDays} giorni (soglia ${verdict.floor} eventi/giorno)`,
    `  motivo   : ${verdict.reason}`,
  ];
  if (verdict.deadDays?.length) {
    lines.push(`  giorni sotto la soglia: ${verdict.deadDays.map((d) => `${d.date}=${d.count}`).join(' ')}`);
  }
  lines.push(
    '  -> nessun giudizio emesso, nessuna issue aperta: astensione deliberata.',
    '     Un numero calcolato qui sarebbe indistinguibile da una misura buona.',
    `     La sorgente morta e' segnalata una volta sola da scripts/check-source-liveness.mjs.`,
    bar,
  );
  // `console.warn` returns undefined, so `warn(...) ?? log(...)` would print
  // the banner on BOTH streams — pick one explicitly.
  const emit = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
  emit(lines.join('\n'));
  logger.log(`::warning title=${monitorName}: source not measurable::${verdict.reason}`);
  return { monitor: monitorName, notMeasurable: true, ...verdict };
}

/**
 * Convenience for the common call site: probe, and if dead, declare + return
 * the verdict. `null` means "alive, go ahead".
 */
export async function abstainIfSourceDead(monitorName, opts = {}) {
  const verdict = await checkGa4Liveness(opts);
  if (verdict.alive) return null;
  return declareNotMeasurable(monitorName, verdict, { logger: opts.logger ?? defaultDiagnosticLogger });
}

/**
 * The monitors that read GA4 as their source and emit a judgement (open an
 * issue, fail a run, or write an artefact other things judge from). They were
 * PostHog-primary with a GA4 fallback until decision H9 (2026-10-05); now GA4
 * is the only source they read, guarded by `checkGa4Liveness` before any
 * judgement. `scripts/check-source-liveness.mjs` lists them in its outage
 * issue, and the guard test walks this list: each entry must call the GA4
 * guard and must not reach PostHog any more.
 */
export const GA4_MONITORS = [
  { path: 'scripts/posthog-error-issue-sync.mjs', guarded: true, emits: 'opens GitHub issues (stability/app-error) from GA4 app_error/exception' },
  { path: 'scripts/cwv-monitor-check.mjs', guarded: true, emits: 'opens GitHub issues (performance/cwv-regression) from GA4 web_vitals' },
  { path: 'scripts/campaign-goal-check.mjs', guarded: true, emits: 'opens GitHub issues (campaign-goal) + exit 1, GA4 goals' },
  { path: 'scripts/profession-keyword-opportunities.mjs', guarded: true, emits: 'workflow opens a deduped SEO issue, signal A from GA4 search' },
  { path: 'scripts/revenue-monitor.mjs', guarded: true, emits: 'CLS verdict table + history jsonl from GA4 web_vitals' },
];

/**
 * The data scripts that used to union PostHog into GSC/GA4 artefacts. Since
 * H9 they read GA4 (+ GSC) only; listed so the move is explicit and the guard
 * test can hold them to "no PostHog read". They emit artefacts, not
 * judgements, and judge GA4 completeness with their own guards
 * (`guardCompleteGa4Report`, exit codes), so they carry no liveness guard.
 */
export const GA4_DATA_MIRRORS = [
  { path: 'scripts/build-evidence-index.mjs', emits: 'data/evidence-index.json (drives thin-page filtering); GSC + GA4' },
  { path: 'scripts/fetch-thin-page-promotions.mjs', emits: 'exit 2/3 + promotion URL set; GA4 + GSC thin_page_view' },
  { path: 'scripts/fetch-article-performance.mjs', emits: 'data/article-performance.json (winners/losers); GSC + GA4 + AdSense' },
  { path: 'scripts/refresh-noslash-keep.mjs', emits: 'data/noslash-keep.json URL keep-list; GSC + GA4' },
  { path: 'scripts/refresh-indexed-cluster-urls.mjs', emits: 'data/indexed-cluster-urls.json; GSC + GA4' },
];

/**
 * The scheduled scripts that still reach PostHog. PostHog is no longer a
 * source the fleet expects to be alive (H9), so none of these is a reason for
 * Source Liveness to raise an outage: each entry says why it may still read
 * PostHog. The guard test fails when a scheduled PostHog reader is missing
 * from here AND when an entry no longer reads PostHog, so the list can only
 * shrink.
 */
export const POSTHOG_MONITORS = [
  { path: 'scripts/build-employer-insights.mjs', guarded: false, emits: 'scheduled employer-insights snapshot; the workflow defaults to --source ga4, PostHog only on a manual --source posthog' },
  { path: 'scripts/ci/export-l7-experiment-outcomes.mjs', guarded: false, emits: 'L7 experiment outcome ledger; reads PostHog only when an experiment is declared, today none (tests/loop-fleet-source-liveness.test.ts)' },
  { path: 'scripts/ci/export-l8-affiliate-outcomes.mjs', guarded: false, emits: 'L8 affiliate outcome ledger; main reads GA4, PostHog helpers kept for historical exports' },
];
