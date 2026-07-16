#!/usr/bin/env node
/**
 * cwv-monitor-check.mjs — weekly real-user CLS/INP regression watchdog for
 * the #4302 money-page target list.
 *
 * Companion to scripts/monitor-cls-posthog.mjs (interactive polling tool for
 * watching a metric converge right after a deploy) but built for scheduled
 * CI: one-shot per page/metric HogQL query against PostHog `$web_vitals`,
 * persisted into data/cwv-monitor-history.json (kept unpruned — see project
 * convention on tracking files staying fat in the repo, not CI-only), and a
 * GitHub backlog issue opened via the shared scripts/lib/error-issue-sync.mjs
 * "top-N over threshold" sync when a page/metric has been over its target on
 * BOTH of the last two recorded weeks (a single bad week is noise; two in a
 * row is a real regression worth a human look).
 *
 * Zero-Claude, report-only: a PostHog/query failure for one page logs and
 * skips that page — it never fails the workflow or blocks the others.
 *
 * Env (loaded via load-rc-env.mjs, same as monitor-cls-posthog.mjs):
 *   POSTHOG_PERSONAL_API_KEY — required
 *   POSTHOG_PROJECT_ID       — required
 *   POSTHOG_HOST             — optional, default https://eu.posthog.com
 *   CWV_MONITOR_WINDOW_DAYS  — optional, default 7 (HogQL lookback per query)
 *   CWV_MONITOR_HISTORY_FILE — optional, default data/cwv-monitor-history.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';

/**
 * #4302 target pages with their CLS (unitless) / INP (ms) field p75
 * thresholds. A page only tracks the metric(s) it has a real target for —
 * e.g. the two job-board INP pages don't have a CLS target in the issue, so
 * `cls` is left undefined and no CLS regression is ever evaluated for them
 * (the value is still recorded in history for visibility).
 */
export const TARGET_PAGES = [
  { key: 'dogana_chiasso_brogeda', path: '/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/', cls: 0.25 },
  { key: 'traffico_chiasso_brogeda_oggi', path: '/traffico-dogane/chiasso-brogeda/oggi/', cls: 0.25 },
  { key: 'aziende_ticino_settimana', path: '/aziende-che-assumono/ticino/settimana-corrente/', cls: 0.25 },
  { key: 'mappa_confine', path: '/guida-frontaliere/mappa-confine/', cls: 0.25, inp: 500 },
  { key: 'simulazione_tasse_nuovi_frontalieri', path: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/', cls: 0.25 },
  { key: 'cerca_lavoro_svizzera', path: '/cerca-lavoro-svizzera/', inp: 500 },
  { key: 'comuni_di_frontiera', path: '/vivere-in-ticino/comuni-di-frontiera/', inp: 500 },
  { key: 'cerca_lavoro_ticino', path: '/cerca-lavoro-ticino/', cls: 0.1 },
  { key: 'home', path: '/', cls: 0.1 },
];

const DEFAULT_HISTORY_FILE = 'data/cwv-monitor-history.json';

async function hogql(host, pid, key, query) {
  const r = await fetch(`${host}/api/projects/${pid}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PH ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/**
 * Single query per page pulling both metrics at once (halves the API calls
 * vs. querying CLS and INP separately) — PostHog's web-vitals autocapture
 * fires one `$web_vitals` event per metric, so a row only ever populates one
 * of the two `properties.$web_vitals_*_value` columns; ClickHouse's
 * quantile()/count() aggregates ignore the NULL rows for the other column.
 */
function buildQuery(path, windowDays) {
  return `
    SELECT
      quantile(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls_p75,
      countIf(properties.$web_vitals_CLS_value IS NOT NULL) AS cls_n,
      quantile(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp_p75,
      countIf(properties.$web_vitals_INP_value IS NOT NULL) AS inp_n
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${windowDays} DAY
      AND properties.$pathname = '${path.replace(/'/g, "\\'")}'
  `.trim();
}

export function loadHistory(file) {
  if (!existsSync(file)) return { pages: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.pages ? parsed : { pages: {} };
  } catch {
    return { pages: {} };
  }
}

export function saveHistory(file, history) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`);
}

/**
 * Append (or, if a snapshot for `date` already exists — e.g. a re-run of the
 * same weekly workflow_dispatch — overwrite in place) this run's row for a
 * page. History is never pruned (kept unpruned in the repo per project
 * convention on accumulator/tracking files).
 */
export function recordSnapshot(history, key, path, date, snapshot) {
  const page = history.pages[key] || { path, weeks: [] };
  page.path = path;
  const existingIdx = page.weeks.findIndex((w) => w.date === date);
  const row = { date, ...snapshot };
  if (existingIdx >= 0) page.weeks[existingIdx] = row;
  else page.weeks.push(row);
  history.pages[key] = page;
  return history;
}

/**
 * Regression = the metric's field p75 was ABOVE `threshold` on the last two
 * recorded weeks (not necessarily consecutive calendar weeks — a run that
 * failed to query is simply never recorded, so "last two" is "last two
 * successful snapshots"). A single bad week is noise; two straight is a
 * signal worth a human look. Returns the two data points on regression, or
 * null otherwise.
 */
export function evaluateConsecutiveRegression(weeks, metricField, threshold) {
  if (threshold == null) return null;
  const withValue = weeks.filter((w) => typeof w[metricField] === 'number' && Number.isFinite(w[metricField]));
  if (withValue.length < 2) return null;
  const [previous, current] = withValue.slice(-2);
  if (current[metricField] > threshold && previous[metricField] > threshold) {
    return { previous, current };
  }
  return null;
}

const fmtCls = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');
const fmtMs = (n) => (typeof n === 'number' ? `${Math.round(n)}ms` : 'n/a');

export async function main() {
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const WINDOW_DAYS = process.env.CWV_MONITOR_WINDOW_DAYS || '7';
  const HISTORY_FILE = process.env.CWV_MONITOR_HISTORY_FILE || DEFAULT_HISTORY_FILE;

  if (!KEY || !PID) {
    console.log('[cwv-monitor-check] POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing — skip');
    return;
  }

  const history = loadHistory(HISTORY_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const regressions = [];

  for (const page of TARGET_PAGES) {
    let snapshot;
    try {
      const result = await hogql(HOST, PID, KEY, buildQuery(page.path, WINDOW_DAYS));
      const row = result.results?.[0] || [null, 0, null, 0];
      snapshot = { cls_p75: row[0], cls_n: row[1], inp_p75: row[2], inp_n: row[3] };
    } catch (e) {
      console.error(`[cwv-monitor-check] ${page.key} (${page.path}) query failed: ${e.message}`);
      continue;
    }

    recordSnapshot(history, page.key, page.path, today, snapshot);
    const weeks = history.pages[page.key].weeks;

    const clsReg = evaluateConsecutiveRegression(weeks, 'cls_p75', page.cls);
    if (clsReg) {
      regressions.push({
        key: page.key, path: page.path, metric: 'CLS', unit: '',
        fmt: fmtCls, threshold: page.cls, ...clsReg,
      });
    }
    const inpReg = evaluateConsecutiveRegression(weeks, 'inp_p75', page.inp);
    if (inpReg) {
      regressions.push({
        key: page.key, path: page.path, metric: 'INP', unit: 'ms',
        fmt: fmtMs, threshold: page.inp, ...inpReg,
      });
    }
  }

  saveHistory(HISTORY_FILE, history);
  console.log(`[cwv-monitor-check] snapshot recorded for ${today} — ${regressions.length} regression(s) detected`);

  if (!regressions.length) return;

  return syncErrorIssues({
    entries: regressions,
    maxIssues: TARGET_PAGES.length,
    labels: ['performance', 'cwv-regression'],
    source: `CWV Monitor — weekly regression check (#4302), ${WINDOW_DAYS}d window`,
    priorityFor: () => 2, // priority:high — these are money/revenue pages
    // Title is stable across weeks (no values/dates) so a still-unresolved
    // regression dedupes onto the SAME issue via createGithubIssue's
    // title-prefix match instead of opening a fresh one every week.
    titleFor: (e) => `CWV Regression (${e.metric}): ${e.path}`,
    bodyFor: (e) => [
      `**Page:** ${e.path}`,
      `**Metric:** field p75 ${e.metric} (target: ${e.metric === 'CLS' ? `< ${e.threshold}` : `< ${e.threshold}ms`})`,
      `**Last 2 weekly snapshots (both over target):**`,
      `- ${e.previous.date}: ${e.fmt(e.previous[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])}`,
      `- ${e.current.date}: ${e.fmt(e.current[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])}`,
      '',
      '_Source: PostHog `$web_vitals` real-user events, scripts/cwv-monitor-check.mjs weekly regression check. History: data/cwv-monitor-history.json._',
    ].join('\n'),
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/TARGET_PAGES/etc. here never fires a real PostHog/gh
// call — same guard as scripts/posthog-error-issue-sync.mjs / dmarc-monitor.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[cwv-monitor-check] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
