#!/usr/bin/env node
/**
 * Guard on the Google Cloud usage that becomes the bill. Runs every 6 hours
 * (Cloud Scheduler, see functions/src/gcpCostMonitorDispatch.js) over a
 * rolling 24-hour window.
 *
 * Why: in September 2026 Firestore reads went from 0.3-1 M a day to 75-90 M
 * (getPlateAuctions rebuilt a 17'613-row snapshot per request for a crawler),
 * 225 M reads and 75.61 CHF on the "Cloud Firestore Read Ops Zurich" SKU, and
 * nobody noticed: the only alarm was the 10 CHF billing budget, whose email
 * goes to the billing-account admins. The project's alarm channel is a GitHub
 * issue, so this monitor reads Cloud Monitoring for the last 24 hours and
 * opens (or comments) one stable-title issue when a driver is over its daily
 * threshold, and resolves it once every driver is back under.
 *
 * Auth: FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS
 * pointing at the same JSON), scope monitoring.read. Missing credentials fail
 * the run: a cost monitor that skips silently is the failure it exists for.
 *
 * Usage: node scripts/monitor-gcp-costs.mjs [--dry-run]
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';

export const GCP_COST_ISSUE_TITLE = 'Costi GCP sopra la soglia giornaliera (monitor-gcp-costs)';
export const GCP_PROJECT_ID = 'frontaliere-ticino';
const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const MONITORING_API = 'https://monitoring.googleapis.com/v3';
const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const MONITORING_TIMEOUT_MS = 30_000;

/**
 * Thresholds sit well above the normal day (September 1-12, before the
 * incident) and well below the incident day, so one bad night opens the issue.
 * Every threshold applies to the PROJECT TOTAL, because that is what the bill
 * counts: two services at 3 GiB of egress cost as much as one at 6 GiB.
 * `breakdownBy` only names the main contributors in the report.
 * Prices are list prices in CHF (Billing Catalog, europe-west6) and only size
 * the estimate in the report: the invoice stays the authority.
 */
export const COST_DRIVERS = [
  {
    key: 'firestore-reads',
    label: 'Letture Firestore',
    metric: 'firestore.googleapis.com/document/read_ops_count',
    threshold: 5_000_000,
    unit: 'count',
    chfPerUnit: 0.349 / 1e6,
    normal: '0,3-1 M/giorno (1-12/09/2026)',
  },
  {
    key: 'firestore-writes',
    label: 'Scritture Firestore',
    metric: 'firestore.googleapis.com/document/write_ops_count',
    threshold: 1_000_000,
    unit: 'count',
    chfPerUnit: 1.048 / 1e6,
    normal: '~250 k/giorno (09/2026)',
  },
  {
    key: 'cloud-run-egress',
    label: 'Egress internet di Cloud Run',
    metric: 'run.googleapis.com/container/network/sent_bytes_count',
    filter: 'metric.label.kind="internet"',
    breakdownBy: 'resource.label.service_name',
    threshold: 5 * GIB,
    unit: 'bytes',
    chfPerUnit: 0.087 / GIB,
    normal: '~0,15 GiB/giorno senza getPlateAuctions (09/2026)',
  },
  {
    key: 'cloud-run-instance-time',
    label: 'Tempo istanza fatturabile Cloud Run',
    metric: 'run.googleapis.com/container/billable_instance_time',
    breakdownBy: 'resource.label.service_name',
    threshold: 40_000,
    unit: 'seconds',
    chfPerUnit: 2.94e-5,
    normal: '~11.500 s/giorno (09/2026)',
  },
];

/**
 * Storage is a level, not a daily flow: the guard is on its growth. It grew
 * ~1.3 GiB/day in September 2026, a known slow creep reported on every run;
 * the threshold catches a new runaway on top of it.
 */
export const STORAGE_DRIVER = {
  key: 'firestore-storage-growth',
  label: 'Crescita storage Firestore',
  metric: 'firestore.googleapis.com/storage/data_and_index_storage_bytes',
  threshold: 2 * GIB,
  unit: 'bytes/day',
  chfPerUnit: 0.175 / GIB,
  normal: '~1,3 GiB/giorno (09/2026), da 9,1 a 27,5 GiB',
};

// Unreadable telemetry is NaN, never zero: a zero would read as a healthy day
// and close the issue. evaluateCostDrivers reports NaN as missing.
function pointValue(point) {
  const value = point?.value || {};
  const raw = value.int64Value ?? value.doubleValue;
  const number = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** Sum every point of every series; NaN when there is no point at all. */
export function sumSeries(series) {
  let total = 0;
  let points = 0;
  for (const item of series || []) {
    for (const point of item.points || []) {
      total += pointValue(point);
      points += 1;
    }
  }
  return points > 0 ? total : Number.NaN;
}

/** Totals per value of `labelPath` (e.g. `resource.label.service_name`), largest first. */
export function breakdownSeries(series, labelPath, limit = 5) {
  const [scope, , name] = labelPath.split('.');
  const totals = new Map();
  for (const item of series || []) {
    const key = (scope === 'resource' ? item.resource?.labels?.[name] : item.metric?.labels?.[name]) || '(sconosciuto)';
    totals.set(key, (totals.get(key) || 0) + sumSeries([item]));
  }
  return [...totals.entries()].filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, value]) => ({ name, value }));
}

/**
 * Average daily growth between the oldest and newest point of a gauge. Fewer
 * than two readable points, or no time between them, cannot measure growth:
 * `perDay` is NaN, reported as missing.
 */
export function dailyGrowth(series) {
  const points = (series || []).flatMap((item) => item.points || [])
    .map((point) => ({ at: Date.parse(point.interval?.endTime), value: pointValue(point) }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.value))
    .sort((a, b) => a.at - b.at);
  if (points.length < 2) return { level: points[0]?.value, perDay: Number.NaN };
  const first = points[0];
  const last = points[points.length - 1];
  const days = (last.at - first.at) / DAY_MS;
  return { level: last.value, perDay: days > 0 ? (last.value - first.value) / days : Number.NaN };
}

/**
 * Compare measurements with the thresholds. `measurements` maps a driver key
 * to `{ value, breakdown? }`; a driver without a measurement is reported as
 * missing, never as healthy.
 */
export function evaluateCostDrivers(measurements, drivers = [...COST_DRIVERS, STORAGE_DRIVER]) {
  const rows = drivers.map((driver) => {
    const measured = measurements[driver.key];
    if (!measured || !Number.isFinite(measured.value)) {
      return { driver, status: 'missing', value: null, chf: null, breakdown: [] };
    }
    return {
      driver,
      status: measured.value > driver.threshold ? 'over' : 'ok',
      value: measured.value,
      chf: Math.max(0, measured.value) * driver.chfPerUnit,
      breakdown: measured.breakdown || [],
      level: measured.level,
    };
  });
  return {
    rows,
    breaches: rows.filter((row) => row.status === 'over'),
    missing: rows.filter((row) => row.status === 'missing'),
  };
}

export function formatAmount(value, unit) {
  if (value === null || value === undefined) return 'n/d';
  if (unit === 'bytes' || unit === 'bytes/day') return `${(value / GIB).toFixed(2)} GiB${unit === 'bytes/day' ? '/giorno' : ''}`;
  if (unit === 'seconds') return `${Math.round(value).toLocaleString('it-CH')} s`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  return Math.round(value).toLocaleString('it-CH');
}

/** Markdown report used for the step summary and as the issue body. */
export function renderCostReport(evaluation, { windowEnd, runUrl } = {}) {
  const lines = [
    `Finestra: 24 h fino a ${windowEnd || 'adesso'} (Cloud Monitoring, progetto \`${GCP_PROJECT_ID}\`).`,
    '',
    '| Voce | Ultime 24 h | Soglia | Stima CHF | Normale | Stato |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of evaluation.rows) {
    const { driver } = row;
    lines.push(`| ${driver.label} | ${formatAmount(row.value, driver.unit)} | ${formatAmount(driver.threshold, driver.unit)} | ${row.chf === null ? 'n/d' : row.chf.toFixed(2)} | ${driver.normal} | ${row.status === 'over' ? 'SOPRA' : row.status === 'missing' ? 'MANCANTE' : 'ok'} |`);
  }
  const storage = evaluation.rows.find((row) => row.driver.key === STORAGE_DRIVER.key);
  if (storage?.level !== undefined) lines.push('', `Storage Firestore attuale: ${formatAmount(storage.level, 'bytes')}.`);
  for (const row of evaluation.breaches) {
    if (!row.breakdown.length) continue;
    lines.push('', `**${row.driver.label}, primi contributori:** ${row.breakdown.map((item) => `\`${item.name}\` ${formatAmount(item.value, row.driver.unit)}`).join(', ')}`);
  }
  // Firestore cannot name its callers (no Data Access audit logs). Rank by
  // work, not by calls: on 2026-10-01 getplateauctions made ~6'000 calls, out
  // of the top five by count, yet led instance time 24'174 s to 3'085 s.
  const instanceTime = evaluation.rows.find((row) => row.driver.key === 'cloud-run-instance-time');
  if (instanceTime?.breakdown.length && evaluation.breaches.some((row) => row.driver.key.startsWith('firestore-'))) {
    lines.push('', `**Servizi Cloud Run con più tempo istanza nelle 24 h:** ${instanceTime.breakdown.map((item) => `\`${item.name}\` ${formatAmount(item.value, 'seconds')}`).join(', ')}`);
  }
  if (evaluation.breaches.length) {
    lines.push(
      '',
      '**1-CAUSA (ipotesi):** un servizio chiamato molto più del normale, o un lavoro che rilegge/riscrive una collection intera. Le letture Firestore non sono attribuibili per chiamante (i Data Access audit log sono spenti): confronta l\'andamento orario con `run.googleapis.com/request_count` per `service_name`; il servizio che segue la curva è il candidato.',
      `**3-METRICA:** soglie e valori nella tabella. Comando: \`node scripts/monitor-gcp-costs.mjs --dry-run\` con \`FIREBASE_SERVICE_ACCOUNT_JSON\`.`,
      '**4-OSSERVATORE:** questo monitor gira ogni 6 ore e chiude la issue da solo quando tutte le voci rientrano.',
      '**Precedente:** settembre 2026, `getPlateAuctions` da 75-90 M letture/giorno (PR #10800).',
    );
  }
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n');
}

async function readCredentials(env = process.env) {
  const inline = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const text = inline || (env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8') : '');
  try {
    const parsed = JSON.parse(text);
    return parsed?.client_email && parsed?.private_key ? parsed : null;
  } catch {
    return null;
  }
}

async function listTimeSeries(fetchImpl, token, { metric, filter, start, end, alignmentSeconds, aligner, reducer, groupBy = [] }) {
  const series = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      filter: `metric.type="${metric}"${filter ? ` AND ${filter}` : ''}`,
      'interval.startTime': start.toISOString(),
      'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': `${alignmentSeconds}s`,
      'aggregation.perSeriesAligner': aligner,
      'aggregation.crossSeriesReducer': reducer,
    });
    for (const field of groupBy) params.append('aggregation.groupByFields', field);
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetchImpl(`${MONITORING_API}/projects/${GCP_PROJECT_ID}/timeSeries?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      // A hung call must fail the step well inside the 10-minute job, so the
      // failure-report step still runs.
      signal: AbortSignal.timeout(MONITORING_TIMEOUT_MS),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Cloud Monitoring ${metric}: HTTP ${response.status} with an unreadable JSON body`);
    }
    if (!response.ok) throw new Error(`Cloud Monitoring ${metric}: HTTP ${response.status} ${body?.error?.message || ''}`.trim());
    if (body?.timeSeries !== undefined && !Array.isArray(body.timeSeries)) {
      throw new Error(`Cloud Monitoring ${metric}: timeSeries is not a list`);
    }
    series.push(...(body?.timeSeries || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return series;
}

/** Measure every driver over the 24 hours ending at `now`. */
export async function measureCostDrivers({ fetchImpl = fetch, token, now = new Date() }) {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - DAY_MS);
  const measurements = {};
  for (const driver of COST_DRIVERS) {
    const series = await listTimeSeries(fetchImpl, token, {
      metric: driver.metric,
      filter: driver.filter,
      start,
      end,
      alignmentSeconds: DAY_MS / 1000,
      aligner: 'ALIGN_SUM',
      reducer: 'REDUCE_SUM',
      groupBy: driver.breakdownBy ? [driver.breakdownBy] : [],
    });
    measurements[driver.key] = {
      value: sumSeries(series),
      breakdown: driver.breakdownBy ? breakdownSeries(series, driver.breakdownBy) : [],
    };
  }
  const storage = await listTimeSeries(fetchImpl, token, {
    metric: STORAGE_DRIVER.metric,
    start: new Date(end.getTime() - 7 * DAY_MS),
    end,
    alignmentSeconds: DAY_MS / 1000,
    aligner: 'ALIGN_MAX',
    reducer: 'REDUCE_SUM',
  });
  const growth = dailyGrowth(storage);
  measurements[STORAGE_DRIVER.key] = { value: growth.perDay, level: growth.level };
  return { measurements, windowEnd: end.toISOString() };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const credentials = await readCredentials();
  if (!credentials) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing or is not a service account JSON');
  const token = await getServiceAccountAccessToken(credentials, MONITORING_SCOPE);
  const { measurements, windowEnd } = await measureCostDrivers({ token });
  const evaluation = evaluateCostDrivers(measurements);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const report = renderCostReport(evaluation, { windowEnd, runUrl });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Costi GCP\n\n${report}\n`);
  if (evaluation.missing.length) {
    throw new Error(`Cost drivers without a measurement: ${evaluation.missing.map((row) => row.driver.key).join(', ')}`);
  }
  if (dryRun) {
    console.log(`[monitor-gcp-costs] dry run: ${evaluation.breaches.length} driver(s) over threshold, no issue written`);
    return;
  }
  const { createGithubIssue, resolveGithubIssue } = await import('./lib/github-issue-creator.mjs');
  if (evaluation.breaches.length) {
    await createGithubIssue({ title: GCP_COST_ISSUE_TITLE, description: report, priority: 2, workflow: 'GCP Cost Monitor' });
  } else {
    resolveGithubIssue(GCP_COST_ISSUE_TITLE, { workflow: 'GCP Cost Monitor', runUrl });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[monitor-gcp-costs] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
