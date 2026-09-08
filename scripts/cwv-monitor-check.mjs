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
 *   POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID — primary source (optional
 *                              when the GA4 fallback is configured)
 *   POSTHOG_HOST             — optional, default https://eu.posthog.com
 *   CWV_MONITOR_WINDOW_DAYS  — optional, default 7 (HogQL lookback per query)
 *   CWV_MONITOR_HISTORY_FILE — optional, default data/cwv-monitor-history.json
 *                              (in CI richiede CWV_MONITOR_HISTORY_FILE_ALLOW_CI=1,
 *                               vedi scripts/lib/resolve-output-path.mjs)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOutputPath } from './lib/resolve-output-path.mjs';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import { runHogQL } from './lib/posthog-client.mjs';
import { checkPostHogLiveness, declareNotMeasurable } from './lib/source-liveness.mjs';
import {
  fetchGa4WebVitals,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  weightedQuantile,
} from './lib/ga4-service-account.mjs';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HISTORY_FILE = 'data/cwv-monitor-history.json';

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

/** Il corpo della issue, scheda inclusa. Esportato perche' il test lo chiami. */
export function buildIssueBody(e) {
  return [
      `**Page:** ${e.path}`,
      `**Metric:** field p75 ${e.metric} (target: ${e.metric === 'CLS' ? `< ${e.threshold}` : `< ${e.threshold}ms`})`,
      `**Last 2 weekly snapshots (both over target):**`,
      `- ${e.previous.date}: ${e.fmt(e.previous[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])}`,
      `- ${e.current.date}: ${e.fmt(e.current[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])}`,
      '',
      `_Source: ${e.sourceLabel || 'PostHog `$web_vitals` real-user events'}, scripts/cwv-monitor-check.mjs weekly regression check. History: data/cwv-monitor-history.json._`,
      '',
      buildScheda({
        causa: [
          `(ipotesi, da confermare.) Il p75 sul campo di ${e.metric} su \`${e.path}\` sta sopra`,
          'la soglia da due snapshot settimanali di fila, quindi non e\' rumore di una settimana.',
          'Quale sia la causa — un\'immagine senza dimensioni dichiarate, uno slot pubblicitario',
          'senza spazio riservato, un handler lungo — non si assume: e\' una misura di campo, non',
          'un profilo.',
        ],
        fix: [
          'Dipende da cosa mostra il profilo della pagina; non preassegnata qui. **Mai',
          "sopprimendo la pubblicita' automatica** (AGENTS.md Non-Negotiable #7): lo spazio si",
          'riserva dichiarandone le dimensioni, non si toglie. | **REPO**: sito.',
        ],
        metrica: `prima=${e.fmt(e.current[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])} atteso=<${e.threshold}${e.metric === 'CLS' ? '' : 'ms'}`,
        comando: 'node scripts/cwv-monitor-check.mjs --dry-run',
        note: [
          'Il comando rigira la stessa query PostHog senza scrivere la storia e senza coniare:',
          'la issue si chiude quando questa pagina non compare piu\' fra le regressioni. Vuole le',
          'credenziali PostHog — dalla root del workspace, `source bin/rc-env.sh`. La serie sta',
          'in `data/cwv-monitor-history.json`.',
        ],
        osservatore: [
          '`.github/workflows/cwv-monitor.yml`, che ogni settimana rimisura e ricommenta sulla',
          "issue canonica finche' il p75 resta sopra soglia. Non esiste un closer automatico: il",
          "comando qui sopra e' il criterio con cui chiuderla.",
        ],
        fallimento: `\`CWV Regression (${e.metric}): ${e.path}\``,
      }),
  ].join('\n');
}

export function ga4CwvSnapshot(rows, pagePath) {
  const scoped = rows.filter((row) => row.path === pagePath);
  const metric = (name) => {
    const observations = scoped
      .filter((row) => row.metric === name)
      .map((row) => ({ value: row.value, count: row.count }));
    return {
      p75: weightedQuantile(observations, 0.75),
      n: observations.reduce((sum, row) => sum + row.count, 0),
    };
  };
  const cls = metric('CLS');
  const inp = metric('INP');
  return { cls_p75: cls.p75, cls_n: cls.n, inp_p75: inp.p75, inp_n: inp.n };
}

export async function fetchGa4CwvFallback({
  windowDays,
  now = new Date(),
  fetchImpl = fetch,
  getTokenImpl = getServiceAccountToken,
} = {}) {
  const token = getTokenImpl === getServiceAccountToken
    ? await getServiceAccountToken([GA4_READONLY_SCOPE])
    : await getTokenImpl([GA4_READONLY_SCOPE]);
  if (!token) return null;
  const { startDate, endDate } = ga4DateRange(Number(windowDays), 2, now);
  return fetchGa4WebVitals({ token, startDate, endDate, fetchImpl });
}

export async function main({ ga4FallbackImpl = fetchGa4CwvFallback } = {}) {
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const WINDOW_DAYS = process.env.CWV_MONITOR_WINDOW_DAYS || '7';
const MIN_SAMPLES_PER_METRIC = 30;
  // Stessa classe dell'override di cluster-orphan-queries.mjs: il default e'
  // un file TRACCIATO e la variabile esiste per i test, quindi il percorso
  // risolto va sempre a log e in CI l'override vuole un opt-in esplicito.
  const HISTORY_FILE = resolveOutputPath({
    label: 'cwv-monitor-check',
    envVar: 'CWV_MONITOR_HISTORY_FILE',
    canonicalPath: DEFAULT_HISTORY_FILE,
    root: ROOT,
  });

  // Vitality guard (scripts/lib/source-liveness.mjs). MIN_SAMPLES_PER_METRIC
  // below suppresses a low-sample p75, which is right for a quiet page but is
  // exactly what turned the 2026-07-23 → 08-10 PostHog outage into three weeks
  // of green runs recording n=0. A dead source is not "no regression", it is
  // no measurement. GA4 receives the same `web_vitals` event through
  // Analytics.log(), so it is a faithful alternate source for this monitor.
  const liveness = await checkPostHogLiveness({ windowDays: Number(WINDOW_DAYS) });
  let source = 'posthog';
  let ga4Rows = null;
  if (!liveness.alive) {
    try {
      ga4Rows = await ga4FallbackImpl({ windowDays: Number(WINDOW_DAYS) });
      const hasTargetObservation = ga4Rows?.some((row) =>
        TARGET_PAGES.some((page) => page.path === row.path && (row.metric === 'CLS' || row.metric === 'INP')),
      );
      if (!hasTargetObservation) {
        declareNotMeasurable('cwv-monitor-check', liveness);
        return;
      }
      source = 'ga4';
      console.warn('[cwv-monitor-check] PostHog non misurabile: uso GA4 `web_vitals` come fallback');
    } catch (error) {
      declareNotMeasurable('cwv-monitor-check', { ...liveness, reason: `${liveness.reason}; GA4 fallback failed: ${error.message}` });
      return;
    }
  }

  const history = loadHistory(HISTORY_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const regressions = [];
  let queryFailures = 0;

  for (const page of TARGET_PAGES) {
    let snapshot;
    try {
      if (source === 'ga4') {
        snapshot = ga4CwvSnapshot(ga4Rows, page.path);
      } else {
        const result = await runHogQL(buildQuery(page.path, WINDOW_DAYS), { apiKey: KEY, projectId: PID, host: HOST });
        const row = result.results?.[0] || [null, 0, null, 0];
        snapshot = { cls_p75: row[0], cls_n: row[1], inp_p75: row[2], inp_n: row[3] };
      }
    } catch (e) {
      console.error(`[cwv-monitor-check] ${page.key} (${page.path}) query failed: ${e.message}`);
      queryFailures += 1;
      continue;
    }

    recordSnapshot(history, page.key, page.path, today, snapshot);
    const weeks = history.pages[page.key].weeks;

    // Sample floor (review PR #4324): a p75 computed on a handful of events
    // is noise — do not call a regression (nor open an issue) on it.
    const clsSampled = (snapshot.cls_n ?? 0) >= MIN_SAMPLES_PER_METRIC;
    const inpSampled = (snapshot.inp_n ?? 0) >= MIN_SAMPLES_PER_METRIC;

    const clsReg = clsSampled ? evaluateConsecutiveRegression(weeks, 'cls_p75', page.cls) : null;
    if (clsReg) {
      regressions.push({
        key: page.key, path: page.path, metric: 'CLS', unit: '',
        fmt: fmtCls, threshold: page.cls, ...clsReg,
      });
    }
    const inpReg = inpSampled ? evaluateConsecutiveRegression(weeks, 'inp_p75', page.inp) : null;
    if (inpReg) {
      regressions.push({
        key: page.key, path: page.path, metric: 'INP', unit: 'ms',
        fmt: fmtMs, threshold: page.inp, ...inpReg,
      });
    }
  }

  if (queryFailures === TARGET_PAGES.length) {
    // Systemic failure (rotated key, wrong project, host outage): exiting 0
    // here would leave the watchdog silently dead forever (review PR #4324).
    console.error('[cwv-monitor-check] ALL page queries failed — PostHog auth/host is broken, failing the run');
    process.exit(1);
  }

  // `--dry-run` verifica il criterio di chiusura di una issue gia' aperta: non
  // deve lasciare tracce sul file di storia.
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun) saveHistory(HISTORY_FILE, history);
  console.log(`[cwv-monitor-check] snapshot recorded for ${today} — ${regressions.length} regression(s) detected`);

  if (!regressions.length) return;

  return syncErrorIssues({
    entries: regressions,
    dryRun,
    maxIssues: regressions.length,
    labels: ['performance', 'cwv-regression'],
    source: `CWV Monitor — ${source === 'ga4' ? 'GA4 fallback' : 'PostHog'} weekly regression check (#4302), ${WINDOW_DAYS}d window`,
    priorityFor: () => 2, // priority:high — these are money/revenue pages
    // Title is stable across weeks (no values/dates) so a still-unresolved
    // regression dedupes onto the SAME issue via createGithubIssue's
    // title-prefix match instead of opening a fresh one every week.
    titleFor: (e) => `CWV Regression (${e.metric}): ${e.path}`,
    bodyFor: (entry) => buildIssueBody({ ...entry, sourceLabel: source === 'ga4' ? 'GA4 `web_vitals` real-user events (fallback — PostHog non misurabile)' : undefined }),
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
