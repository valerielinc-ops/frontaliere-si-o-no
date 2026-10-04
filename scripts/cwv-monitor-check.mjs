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
 * Zero-Claude, report-only: a missing source observation is persisted as an
 * explicit null row and fails the workflow. A partial run must never look
 * green, because a missing page is not evidence that the page had no
 * regression.
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
import { reconcileMonitorIssues } from './lib/monitor-issue-reconcile.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import { runHogQL } from './lib/posthog-client.mjs';
import { checkPostHogLiveness, declareNotMeasurable } from './lib/source-liveness.mjs';
import {
  fetchGa4WebVitals,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  hasSignificantOtherBucket,
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
  { key: 'cerca_lavoro_ticino', path: '/cerca-lavoro-ticino/', cls: 0.1, inp: 200 },
  { key: 'home', path: '/', cls: 0.1, inp: 200 },
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HISTORY_FILE = 'data/cwv-monitor-history.json';
export const MIN_SAMPLES_PER_METRIC = 30;
const DEVICES = ['mobile', 'desktop', 'tablet', 'unknown'];
const normalizeDevice = (value) => {
  const device = String(value || '').toLowerCase();
  return DEVICES.includes(device) ? device : 'unknown';
};

/**
 * Single query per page pulling both metrics at once (halves the API calls
 * vs. querying CLS and INP separately) — PostHog's web-vitals autocapture
 * fires one `$web_vitals` event per metric, so a row only ever populates one
 * of the two `properties.$web_vitals_*_value` columns; ClickHouse's
 * quantile()/count() aggregates ignore the NULL rows for the other column.
 */
export function buildQuery(path, window) {
  return `
    SELECT
      quantile(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls_p75,
      countIf(properties.$web_vitals_CLS_value IS NOT NULL) AS cls_n,
      quantile(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp_p75,
      countIf(properties.$web_vitals_INP_value IS NOT NULL) AS inp_n,
      lower(coalesce(properties.$device_type, 'unknown')) AS device
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp >= toDateTime('${window.startDate} 00:00:00', 'UTC')
      AND timestamp < toDateTime('${window.endDate} 00:00:00', 'UTC') + INTERVAL 1 DAY
      AND properties.$pathname = '${path.replace(/'/g, "\\'")}'
    GROUP BY device
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
 * Persist an explicit abstention for every target page when neither CWV
 * source can provide an observation. A null row is deliberately different
 * from a successful zero-sample measurement: downstream readers can see that
 * the week was attempted but the source was unavailable.
 */
export function recordSourceUnavailableSnapshots(history, date, reason) {
  const sourceUnavailable = String(reason || 'CWV source unavailable').trim();
  for (const page of TARGET_PAGES) {
    recordSnapshot(history, page.key, page.path, date, {
      cls_p75: null,
      cls_n: 0,
      inp_p75: null,
      inp_n: 0,
      sourceUnavailable,
    });
  }
  return history;
}

/**
 * Persist and return a loud source-unavailable result. The history row is
 * intentionally written before returning so the scheduled workflow can commit
 * the abstention even though its final status is non-zero.
 */
function sourceUnavailableResult({ history, file, date, reason, dryRun, liveness }) {
  recordSourceUnavailableSnapshots(history, date, reason);
  if (!dryRun) saveHistory(file, history);
  declareNotMeasurable('cwv-monitor-check', { ...(liveness || {}), reason });
  console.error(`[cwv-monitor-check] source unavailable: recorded ${TARGET_PAGES.length} null snapshot(s) for ${date}`);
  return {
    status: 'source-unavailable',
    date,
    source: 'none',
    reason: String(reason),
    pages: TARGET_PAGES.length,
  };
}

/**
 * Regression = the metric's field p75 was ABOVE `threshold` on the last two
 * recorded, comparable windows. Missing or under-sampled observations break
 * the chain; source changes, overlaps and different durations cannot be paired.
 * A single bad week is noise; two straight is a
 * signal worth a human look. Returns the two data points on regression, or
 * null otherwise.
 */
export function evaluateConsecutiveRegression(weeks, metricField, threshold, device = 'all') {
  if (threshold == null) return null;
  const pair = comparableWindows(weeks, metricField, device);
  if (!pair) return null;
  const { previous, current } = pair;
  if (current[metricField] > threshold && previous[metricField] > threshold) {
    return { previous, current, device };
  }
  return null;
}

/**
 * The last two recorded windows for `device` (`all` = the pooled fields),
 * when BOTH are valid observations of `metricField` and they can be paired:
 * otherwise `null`. Shared by the regression (opener) and the recovery
 * (closer), so the two verdicts can never disagree on what a usable pair is.
 */
function comparableWindows(weeks, metricField, device = 'all') {
  if (!Array.isArray(weeks) || weeks.length < 2) return null;
  // A missing/low-sample week breaks the chain. Never bridge an outage or
  // compare legacy pooled snapshots with a newly segmented source.
  const [previous, current] = weeks.slice(-2).map((week) => ({
    ...week, ...(device === 'all' ? {} : (week.devices?.[device] || { cls_p75: null, cls_n: 0, inp_p75: null, inp_n: 0 })),
  }));
  const countField = metricField.replace('_p75', '_n');
  const valid = (row) => Number.isFinite(row[metricField])
    && row[countField] >= MIN_SAMPLES_PER_METRIC && !row.sourceUnavailable;
  if (!valid(previous) || !valid(current)) return null;
  if (!previous.source || previous.source !== current.source
      || previous.window?.days !== current.window?.days
      || previous.window?.lagDays !== current.window?.lagDays
      || previous.window?.timezone !== current.window?.timezone
      || !previous.window?.endDate || !current.window?.startDate
      || previous.window.endDate >= current.window.startDate) return null;
  return { previous, current };
}

/**
 * Recovery = the metric's field p75 was AT OR BELOW `threshold` on the last
 * two recorded, comparable windows — the exact complement of
 * `evaluateConsecutiveRegression`, with the same validity rules: a missing,
 * under-sampled (`n < MIN_SAMPLES_PER_METRIC`) or `sourceUnavailable` window,
 * a source change, a different duration or an overlap → `null`. An
 * insufficient sample is not a recovery. Returns the two data points, or null.
 */
export function evaluateConsecutiveRecovery(weeks, metricField, threshold, device = 'all') {
  if (threshold == null) return null;
  const pair = comparableWindows(weeks, metricField, device);
  if (!pair) return null;
  const { previous, current } = pair;
  if (current[metricField] <= threshold && previous[metricField] <= threshold) {
    return { previous, current, device };
  }
  return null;
}

// ── Chiusura: la metà simmetrica del conio ──────────────────────────────────

export const CWV_FAMILY = 'cwv-regression';
export const CWV_TITLE_PREFIX = 'CWV Regression (';
const CWV_RECONCILE_COMMAND = 'node scripts/cwv-monitor-check.mjs --dry-run';
const METRIC_FIELDS = { CLS: 'cls_p75', INP: 'inp_p75' };
const TITLE_RE = /^CWV Regression \((CLS|INP)(?:, ([a-z]+))?\): (\/\S*)$/u;

/** Il titolo che il monitor conia oggi (stabile fra le settimane: niente valori né date). */
export const cwvIssueTitle = ({ metric, device, path }) => `CWV Regression (${metric}, ${device}): ${path}`;
/** La forma precedente, senza device: misura aggregata (`all`). */
const legacyCwvIssueTitle = ({ metric, path }) => `CWV Regression (${metric}): ${path}`;

/**
 * Metrica, device e path dal titolo di una issue della famiglia. Forma
 * attuale `CWV Regression (<METRIC>, <device>): <path>`; forma precedente
 * `CWV Regression (<METRIC>): <path>` → device `all` (i campi aggregati della
 * storia). Qualunque altra forma → `null`: nessun verdetto, nessuna scrittura.
 */
export function parseCwvIssueTitle(title) {
  const m = TITLE_RE.exec(String(title ?? ''));
  if (!m) return null;
  const device = m[2] ?? 'all';
  if (device !== 'all' && !DEVICES.includes(device)) return null;
  return { metric: m[1], device, path: m[3], legacy: m[2] === undefined };
}

const fmtRaw = (n) => (typeof n === 'number' ? String(n) : 'n/a');
function describeWindow(row, metricField) {
  const countField = metricField.replace('_p75', '_n');
  return `${row.window?.startDate || '?'}→${row.window?.endDate || '?'} = ${fmtRaw(row[metricField])} `
    + `(n=${row[countField] ?? '?'}, ${row.source || '?'})`;
}

/**
 * Il verdetto di chiusura per UNA issue aperta della famiglia, sui valori
 * registrati nella storia (per device, non un aggregato ricalcolato).
 * `complete` = le ultime due finestre sono valide e confrontabili; `clean` =
 * entrambe sotto o alla soglia. Titolo non interpretabile, path non più fra
 * i `TARGET_PAGES` o metrica senza soglia → `complete: false` (nessuna misura).
 */
export function cwvRecoveryVerdict(issue, history) {
  const incomplete = (evidence) => ({ clean: false, complete: false, evidence });
  const parsed = parseCwvIssueTitle(issue?.title);
  if (!parsed) return incomplete(`titolo non interpretabile: "${issue?.title ?? ''}"`);
  const page = TARGET_PAGES.find((p) => p.path === parsed.path);
  if (!page) return incomplete(`${parsed.path} non è più fra i TARGET_PAGES del monitor`);
  const threshold = page[parsed.metric.toLowerCase()];
  if (threshold == null) return incomplete(`${parsed.path} non ha una soglia ${parsed.metric}`);
  const field = METRIC_FIELDS[parsed.metric];
  const weeks = history?.pages?.[page.key]?.weeks || [];
  const pair = comparableWindows(weeks, field, parsed.device);
  if (!pair) {
    return incomplete(`${parsed.metric} ${parsed.device} su ${parsed.path}: le ultime due finestre registrate non sono valide e confrontabili`);
  }
  const recovery = evaluateConsecutiveRecovery(weeks, field, threshold, parsed.device);
  const unit = parsed.metric === 'INP' ? 'ms' : '';
  const evidence = `${parsed.metric} p75 field, device ${parsed.device}, ${parsed.path}, soglia ≤ ${threshold}${unit}: `
    + `${describeWindow(pair.previous, field)}; ${describeWindow(pair.current, field)}`
    // Il conio usa solo la forma con il device: una recidiva apre quel titolo,
    // non riapre questo nella forma precedente.
    + (parsed.legacy
      ? `. Titolo nella forma precedente senza device: se il difetto torna sopra soglia il monitor apre \`${cwvIssueTitle({ metric: parsed.metric, device: '<device>', path: parsed.path })}\``
      : '');
  return {
    clean: recovery !== null,
    complete: true,
    evidence,
    measure: pair.current.window.endDate,
    measuredAt: pair.current.date,
    command: CWV_RECONCILE_COMMAND,
  };
}

/**
 * I titoli misurati sopra soglia in questa run: quelli coniati
 * (`regressions`) più, per ogni pagina e metrica in regressione su un device
 * o sull'aggregato, il titolo nella forma precedente senza device. Così una
 * issue aperta con il vecchio titolo (8868) resta `keep` e perde
 * `maybe-resolved` quando la pagina è ancora sopra soglia.
 */
export function cwvMeasuredTitles(history, regressions = []) {
  const titles = new Set();
  for (const r of regressions) {
    titles.add(cwvIssueTitle(r));
    titles.add(legacyCwvIssueTitle(r));
  }
  for (const page of TARGET_PAGES) {
    const weeks = history?.pages?.[page.key]?.weeks || [];
    for (const [metric, field] of Object.entries(METRIC_FIELDS)) {
      if (evaluateConsecutiveRegression(weeks, field, page[metric.toLowerCase()], 'all')) {
        titles.add(legacyCwvIssueTitle({ metric, path: page.path }));
      }
    }
  }
  return titles;
}

/** Esiste almeno una coppia di finestre confrontabili su cui una issue potrebbe avere un verdetto? */
function hasComparableWindows(history) {
  return TARGET_PAGES.some((page) => {
    const weeks = history?.pages?.[page.key]?.weeks || [];
    return Object.entries(METRIC_FIELDS).some(([metric, field]) => page[metric.toLowerCase()] != null
      && ['all', ...DEVICES].some((device) => comparableWindows(weeks, field, device)));
  });
}

/**
 * La fase «riconcilia» del monitor CWV (scripts/lib/monitor-issue-reconcile.mjs),
 * chiamata dopo ogni snapshot valido, anche senza regressioni. `confirmations: 1`
 * perché `clean` è già un criterio di due finestre consecutive. Senza alcuna
 * coppia confrontabile nessun verdetto può essere completo e nessun titolo è
 * misurato: la riconciliazione non scriverebbe nulla, quindi non legge neppure.
 */
export async function reconcileCwvIssues({
  history, regressions = [], dryRun = false, workflow, io, now = new Date(), log,
}) {
  if (!hasComparableWindows(history)) {
    console.log('[cwv-monitor-check] riconciliazione saltata: nessuna coppia di finestre valide e confrontabili nella storia');
    return null;
  }
  const measured = cwvMeasuredTitles(history, regressions);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  return reconcileMonitorIssues({
    family: CWV_FAMILY,
    labels: [CWV_FAMILY],
    titlePrefix: CWV_TITLE_PREFIX,
    verdictFor: (issue) => cwvRecoveryVerdict(issue, history),
    confirmations: 1,
    measuredTitles: measured,
    // Una misura sopra soglia smentisce `maybe-resolved` anche sul titolo
    // nella forma precedente, che il conio non riconferma più per titolo.
    reconfirmedTitles: measured,
    dryRun,
    workflow,
    runUrl,
    now,
    io,
    log,
  });
}

const fmtCls = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');
const fmtMs = (n) => (typeof n === 'number' ? `${Math.round(n)}ms` : 'n/a');

/** Il corpo della issue, scheda inclusa. Esportato perche' il test lo chiami. */
export function buildIssueBody(e) {
  return [
      `**Page:** ${e.path}`,
      `**Device:** ${e.device || 'all'}`,
      `**Metric:** field p75 ${e.metric} (target: ${e.metric === 'CLS' ? `< ${e.threshold}` : `< ${e.threshold}ms`})`,
      `**Last 2 weekly snapshots (both over target):**`,
      `- ${e.previous.date}: ${e.fmt(e.previous[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])} (n=${e.previous[e.metric === 'CLS' ? 'cls_n' : 'inp_n'] ?? 'unknown'})`,
      `- ${e.current.date}: ${e.fmt(e.current[e.metric === 'CLS' ? 'cls_p75' : 'inp_p75'])} (n=${e.current[e.metric === 'CLS' ? 'cls_n' : 'inp_n'] ?? 'unknown'})`,
      `**Window:** ${e.current.window?.startDate || 'unknown'} — ${e.current.window?.endDate || 'unknown'}; ${e.current.window?.timezone || 'unknown'}`,
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
          'Il comando rigira la stessa query PostHog senza scrivere la storia e senza coniare,',
          'e stampa la decisione di chiusura per ogni issue aperta della famiglia. Vuole le',
          'credenziali PostHog — dalla root del workspace, `source bin/rc-env.sh`. La serie sta',
          'in `data/cwv-monitor-history.json`.',
        ],
        osservatore: [
          '`.github/workflows/cwv-monitor.yml`, che ogni settimana rimisura e ricommenta sulla',
          "issue canonica finche' il p75 resta sopra soglia, e la chiude da solo con l'evidenza",
          'quando le ultime due finestre registrate sono valide, confrontabili e sotto soglia',
          '(`evaluateConsecutiveRecovery`, stesso device del titolo).',
        ],
        fallimento: `\`${cwvIssueTitle({ ...e, device: e.device || 'all' })}\``,
      }),
  ].join('\n');
}

export function ga4CwvSnapshot(rows, pagePath, device) {
  const scoped = rows.filter((row) => row.path === pagePath && (!device || normalizeDevice(row.device) === device));
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
  const rows = await fetchGa4WebVitals({ token, startDate, endDate, paths: TARGET_PAGES.map((page) => page.path), fetchImpl });
  return hasSignificantOtherBucket(rows) || (rows.coverage?.truncated || rows.coverage?.distributionIncomplete) ? null : rows;
}

export async function main({
  ga4FallbackImpl = fetchGa4CwvFallback,
  checkLivenessImpl = checkPostHogLiveness,
  runHogQLImpl = runHogQL,
  now = new Date(),
  reconcileIo,
} = {}) {
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const rawWindowDays = process.env.CWV_MONITOR_WINDOW_DAYS || '7';
  const WINDOW_DAYS = Number(rawWindowDays);
  if (!Number.isInteger(WINDOW_DAYS) || WINDOW_DAYS < 1 || WINDOW_DAYS > 90) {
    throw new Error('CWV_MONITOR_WINDOW_DAYS must be an integer from 1 to 90');
  }
  const dateRange = ga4DateRange(WINDOW_DAYS, 2, now);
  // Stessa classe dell'override di cluster-orphan-queries.mjs: il default e'
  // un file TRACCIATO e la variabile esiste per i test, quindi il percorso
  // risolto va sempre a log e in CI l'override vuole un opt-in esplicito.
  const HISTORY_FILE = resolveOutputPath({
    label: 'cwv-monitor-check',
    envVar: 'CWV_MONITOR_HISTORY_FILE',
    canonicalPath: DEFAULT_HISTORY_FILE,
    root: ROOT,
  });
  const history = loadHistory(HISTORY_FILE);
  const today = now.toISOString().slice(0, 10);
  const dryRun = process.argv.includes('--dry-run');

  // Vitality guard (scripts/lib/source-liveness.mjs). MIN_SAMPLES_PER_METRIC
  // below suppresses a low-sample p75, which is right for a quiet page but is
  // exactly what turned the 2026-07-23 → 08-10 PostHog outage into three weeks
  // of green runs recording n=0. A dead source is not "no regression", it is
  // no measurement. GA4 receives the same `web_vitals` event through
  // Analytics.log(), so it is a faithful alternate source for this monitor.
  // The liveness helper evaluates complete UTC days ending yesterday.
  // Shift its reference by one day so it judges exactly our lag-2 range.
  const liveness = await checkLivenessImpl({ windowDays: WINDOW_DAYS, now: new Date(now.getTime() - 86400000) });
  let source = 'posthog';
  let ga4Rows = null;
  if (!liveness.alive) {
    try {
      ga4Rows = await ga4FallbackImpl({ windowDays: WINDOW_DAYS, now });
      const hasTargetObservation = ga4Rows?.some((row) =>
        TARGET_PAGES.some((page) => page.path === row.path && (row.metric === 'CLS' || row.metric === 'INP')),
      );
      if (!hasTargetObservation) {
        const reason = `${liveness.reason}; GA4 fallback returned no target CLS/INP observations`;
        return sourceUnavailableResult({
          history, file: HISTORY_FILE, date: today, reason, dryRun, liveness,
        });
      }
      source = 'ga4';
      console.warn('[cwv-monitor-check] PostHog non misurabile: uso GA4 `web_vitals` come fallback');
    } catch (error) {
      const reason = `${liveness.reason}; GA4 fallback failed: ${error.message}`;
      return sourceUnavailableResult({
        history, file: HISTORY_FILE, date: today, reason, dryRun, liveness,
      });
    }
  }

  const measurement = {
    source,
    window: { ...dateRange, days: WINDOW_DAYS, lagDays: 2, timezone: source === 'posthog' ? 'UTC' : ga4Rows.coverage?.timeZone || 'unknown' },
    monitorBuild: process.env.GITHUB_SHA || null,
    deployedBuild: process.env.CWV_DEPLOYED_BUILD || null,
    minimumSamples: MIN_SAMPLES_PER_METRIC,
  };
  const regressions = [];
  let queryFailures = 0;
  const unavailablePages = [];

  for (const page of TARGET_PAGES) {
    let snapshot;
    try {
      if (source === 'ga4') {
        snapshot = { ...ga4CwvSnapshot(ga4Rows, page.path), devices: Object.fromEntries(DEVICES.map((device) => [device, ga4CwvSnapshot(ga4Rows, page.path, device)])) };
      } else {
        const result = await runHogQLImpl(buildQuery(page.path, dateRange), { apiKey: KEY, projectId: PID, host: HOST });
        const devices = Object.fromEntries((result.results || []).map((row) => [normalizeDevice(row[4]), {
          cls_p75: row[0], cls_n: Number(row[1]), inp_p75: row[2], inp_n: Number(row[3]),
        }]));
        // Quantiles cannot be averaged across devices. Keep legacy pooled
        // fields null; counts remain useful and devices hold the real p75.
        snapshot = { cls_p75: null, inp_p75: null,
          cls_n: Object.values(devices).reduce((n, row) => n + row.cls_n, 0),
          inp_n: Object.values(devices).reduce((n, row) => n + row.inp_n, 0), devices };
      }
    } catch (e) {
      console.error(`[cwv-monitor-check] ${page.key} (${page.path}) query failed: ${e.message}`);
      queryFailures += 1;
      recordSnapshot(history, page.key, page.path, today, {
        ...measurement,
        cls_p75: null,
        cls_n: 0,
        inp_p75: null,
        inp_n: 0,
        // Do not put the raw error in tracked history: it can contain request
        // details. The workflow log already carries the full diagnostic.
        sourceUnavailable: `query failed (${e?.name || 'Error'})`,
      });
      unavailablePages.push(page.key);
      continue;
    }

    const hasMetricObservation = (value, count) =>
      value != null && Number.isFinite(Number(value)) && Number(count ?? 0) > 0;
    const hasTargetObservation =
      Object.values(snapshot.devices).some((row) =>
        (page.cls != null && hasMetricObservation(row.cls_p75, row.cls_n))
        || (page.inp != null && hasMetricObservation(row.inp_p75, row.inp_n)));
    if (!hasTargetObservation) {
      recordSnapshot(history, page.key, page.path, today, {
        ...measurement,
        cls_p75: null,
        cls_n: 0,
        inp_p75: null,
        inp_n: 0,
        sourceUnavailable: `no target observations in ${WINDOW_DAYS}d window`,
      });
      unavailablePages.push(page.key);
      console.error(`[cwv-monitor-check] ${page.key} (${page.path}) returned no target observations — no verdict for this page`);
      continue;
    }

    Object.assign(snapshot, measurement);
    for (const row of Object.values(snapshot.devices)) {
      row.cls_status = hasMetricObservation(row.cls_p75, row.cls_n) && row.cls_n >= MIN_SAMPLES_PER_METRIC ? 'measured' : 'insufficient-samples';
      row.inp_status = hasMetricObservation(row.inp_p75, row.inp_n) && row.inp_n >= MIN_SAMPLES_PER_METRIC ? 'measured' : 'insufficient-samples';
    }
    recordSnapshot(history, page.key, page.path, today, snapshot);
    const weeks = history.pages[page.key].weeks;

    for (const device of DEVICES) {
      for (const [metric, field, threshold, fmt, unit] of [
        ['CLS', 'cls_p75', page.cls, fmtCls, ''],
        ['INP', 'inp_p75', page.inp, fmtMs, 'ms'],
      ]) {
        const regression = evaluateConsecutiveRegression(weeks, field, threshold, device);
        if (regression) regressions.push({
          key: `${page.key}:${device}`, path: page.path, metric, unit, fmt, threshold, ...regression,
        });
      }
    }
  }

  if (queryFailures > 0 || unavailablePages.length > 0) {
    // A partial measurement is not a healthy run. Keep the successful rows,
    // mark every missing page explicitly, and fail closed so CI cannot report
    // a green watchdog while a target is blind.
    if (!dryRun) saveHistory(HISTORY_FILE, history);
    console.error(
      `[cwv-monitor-check] incomplete measurement — ${queryFailures} query failure(s), `
      + `${unavailablePages.length} unavailable page(s); failing closed`,
    );
    declareNotMeasurable('cwv-monitor-check', {
      ...liveness,
      reason: `${queryFailures} query failure(s), ${unavailablePages.length} target page(s) without a usable observation`,
    });
    return {
      status: 'source-unavailable',
      date: today,
      source,
      queryFailures,
      unavailablePages,
      regressions,
    };
  }

  // `--dry-run` verifica il criterio di chiusura di una issue gia' aperta: non
  // deve lasciare tracce sul file di storia.
  if (!dryRun) saveHistory(HISTORY_FILE, history);
  console.log(`[cwv-monitor-check] snapshot recorded for ${today} — ${regressions.length} regression(s) detected`);

  const workflow = `CWV Monitor — ${source === 'ga4' ? 'GA4 fallback' : 'PostHog'} weekly regression check (#4302), ${WINDOW_DAYS}d window`;
  // La riconciliazione gira dopo OGNI snapshot valido, anche senza
  // regressioni: una issue guarita si chiude proprio nelle run in cui il
  // monitor non trova nulla (prima qui c'era un `return` anticipato).
  const reconcile = () => reconcileCwvIssues({
    history, regressions, dryRun, workflow, io: reconcileIo, now,
  });

  if (!regressions.length) {
    const reconciled = await reconcile();
    return { status: 'ok', date: today, source, regressions, reconciled };
  }

  const synced = await syncErrorIssues({
    entries: regressions,
    dryRun,
    maxIssues: regressions.length,
    labels: ['performance', 'cwv-regression'],
    source: workflow,
    priorityFor: () => 2, // priority:high — these are money/revenue pages
    // Title is stable across weeks (no values/dates) so a still-unresolved
    // regression dedupes onto the SAME issue via createGithubIssue's
    // title-prefix match instead of opening a fresh one every week.
    titleFor: cwvIssueTitle,
    bodyFor: (entry) => buildIssueBody({ ...entry, sourceLabel: source === 'ga4' ? 'GA4 `web_vitals` real-user events (fallback — PostHog non misurabile)' : undefined }),
  });
  const reconciled = await reconcile();
  return { status: 'ok', date: today, source, regressions, synced, reconciled };
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/TARGET_PAGES/etc. here never fires a real PostHog/gh
// call — same guard as scripts/posthog-error-issue-sync.mjs / dmarc-monitor.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  if (result?.synced) {
    console.log(`[cwv-monitor-check] synced ${result.synced.filter(Boolean).length}/${result.synced.length} issue(s)`);
  }
  if (result?.status === 'source-unavailable') process.exitCode = 2;
  else if (result?.status === 'error') process.exitCode = 1;
}
