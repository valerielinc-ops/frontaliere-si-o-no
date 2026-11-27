#!/usr/bin/env node
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
/**
 * Guard on the Google Cloud usage that becomes the bill. Runs every 6 hours
 * (Cloud Scheduler, see functions/src/gcpCostMonitorDispatch.js) over a
 * rolling 24-hour window.
 *
 * The project's alert channel is a stable-title GitHub issue. Public output
 * contains alert status only; usage, thresholds and cost estimates stay private.
 *
 * Auth: FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS
 * pointing at the same JSON), scope monitoring.read. Missing credentials fail
 * the run: a cost monitor that skips silently is the failure it exists for.
 *
 * Usage: node scripts/monitor-gcp-costs.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';
import { fetchWithRetry } from './lib/transient-fetch.mjs';

export const GCP_COST_ISSUE_TITLE = 'Costi GCP sopra la soglia giornaliera (monitor-gcp-costs)';
export const GCP_PROJECT_ID = 'frontaliere-ticino';
const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const MONITORING_API = 'https://monitoring.googleapis.com/v3';
const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const MONITORING_TIMEOUT_MS = 30_000;
const MONITORING_RETRIES = 1;
const MONITORING_RETRY_BASE_MS = 1_000;

/**
 * Thresholds apply to project totals so the alert tracks aggregate usage.
 * `breakdownBy` groups usage internally by its provider resource.
 */
export const COST_DRIVERS = [
  {
    key: 'firestore-reads',
    label: 'Letture Firestore',
    metric: 'firestore.googleapis.com/document/read_ops_count',
    threshold: 5_000_000,
    unit: 'count',
  },
  {
    key: 'firestore-writes',
    label: 'Scritture Firestore',
    metric: 'firestore.googleapis.com/document/write_ops_count',
    threshold: 1_000_000,
    unit: 'count',
  },
  {
    key: 'cloud-run-egress',
    label: 'Egress internet di Cloud Run',
    metric: 'run.googleapis.com/container/network/sent_bytes_count',
    filter: 'metric.label.kind="internet"',
    breakdownBy: 'resource.label.service_name',
    threshold: 5 * GIB,
    unit: 'bytes',
  },
  {
    key: 'cloud-run-requests',
    label: 'Richieste Cloud Run',
    metric: 'run.googleapis.com/request_count',
    filter: 'resource.type="cloud_run_revision" AND resource.labels.location="europe-west6"',
    breakdownBy: 'resource.label.service_name',
    threshold: 200_000,
    unit: 'count',
    // Diagnostic volume only; billed Cloud Run use is counted by instance time/egress.
  },
  {
    key: 'cloud-run-instance-time',
    label: 'Tempo istanza fatturabile Cloud Run',
    metric: 'run.googleapis.com/container/billable_instance_time',
    breakdownBy: 'resource.label.service_name',
    threshold: 20_000,
    unit: 'seconds',
  },
  {
    key: 'firebase-storage-egress',
    label: 'Traffico in uscita bucket Firebase Storage',
    metric: 'storage.googleapis.com/network/sent_bytes_count',
    filter: 'resource.type="gcs_bucket" AND resource.labels.bucket_name="frontaliere-ticino.firebasestorage.app"',
    breakdownBy: 'resource.label.bucket_name',
    threshold: 2 * GIB,
    unit: 'bytes',
    // Directional only: this metric includes same-location traffic as well as internet egress.
  },
];

/**
 * Storage is a level, not a daily flow: the guard measures growth rather than
 * total size to avoid repeating alerts for an existing large collection.
 */
export const STORAGE_DRIVER = {
  key: 'firestore-storage-growth',
  label: 'Crescita storage Firestore',
  metric: 'firestore.googleapis.com/storage/data_and_index_storage_bytes',
  threshold: 2 * GIB,
  unit: 'bytes/day',
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
      return { driver, status: 'missing', value: null, breakdown: [] };
    }
    return {
      driver,
      status: measured.value > driver.threshold ? 'over' : 'ok',
      value: measured.value,
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

/** Markdown report used for the step summary and as the issue body. */
export function renderCostReport(evaluation, { runUrl } = {}) {
  const alert = evaluation.breaches.length > 0;
  const lines = [
    alert ? '## GCP cost monitor alert' : '## GCP cost monitor status',
    '',
    alert
      ? 'One or more cost thresholds were exceeded. Billing measurements and diagnostics are withheld from this public issue.'
      : 'The monitor completed. Billing measurements and diagnostics are withheld from public output.',
    'Review underlying measurements only in an authorized private Google Cloud session.',
  ];
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

async function listTimeSeries(fetchImpl, token, { metric, filter, start, end, alignmentSeconds, aligner, reducer, groupBy = [] }, retryOptions = {}) {
  const series = [];
  const retries = Number.isFinite(retryOptions.retries) ? Math.max(0, retryOptions.retries) : MONITORING_RETRIES;
  const retryBaseMs = Number.isFinite(retryOptions.retryBaseMs)
    ? Math.max(0, retryOptions.retryBaseMs)
    : MONITORING_RETRY_BASE_MS;
  const fetchMonitoring = async (url, init) => {
    try {
      return await fetchWithRetry(async () => {
        const response = await fetchImpl(url, init);
        if (response.status === 429 || response.status >= 500) {
          const error = new Error(`Cloud Monitoring ${metric}: HTTP ${response.status}`);
          error.status = response.status;
          error.retryable = true;
          throw error;
        }
        return response;
      }, {
        retries,
        retryBaseMs,
        label: `Cloud Monitoring ${metric}`,
      });
    } catch (error) {
      const exhausted = error?.retryExhausted === true;
      const attempts = exhausted ? retries + 1 : 1;
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new Error(
          `Cloud Monitoring ${metric}: request timed out after ${MONITORING_TIMEOUT_MS}ms (attempts ${attempts}/${retries + 1})`,
          { cause: error },
        );
      }
      if (exhausted) {
        const detail = error instanceof Error ? error.message : String(error);
        const prefix = detail.startsWith('Cloud Monitoring ') ? '' : `Cloud Monitoring ${metric}: `;
        throw new Error(`${prefix}${detail} (attempts ${attempts}/${retries + 1})`, { cause: error });
      }
      throw error;
    }
  };
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
    const response = await fetchMonitoring(`${MONITORING_API}/projects/${GCP_PROJECT_ID}/timeSeries?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      // A hung call must fail the step well inside the 10-minute job, so the
      // failure-report step still runs. The wrapper above adds one bounded
      // retry without widening this per-attempt clock cap.
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
export async function measureCostDrivers({ fetchImpl = fetch, token, now = new Date(), retryOptions }) {
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
    }, retryOptions);
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
  }, retryOptions);
  const growth = dailyGrowth(storage);
  measurements[STORAGE_DRIVER.key] = { value: growth.perDay, level: growth.level };
  return { measurements, windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const credentials = await readCredentials();
  if (!credentials) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing or is not a service account JSON');
  const token = await getServiceAccountAccessToken(credentials, MONITORING_SCOPE);
  const { measurements } = await measureCostDrivers({ token });
  const evaluation = evaluateCostDrivers(measurements);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const report = renderCostReport(evaluation, { runUrl });
  console.log(report);
  if (evaluation.missing.length) {
    throw new Error('Cost monitor could not measure one or more drivers');
  }
  if (dryRun) {
    console.log('[monitor-gcp-costs] dry run completed; no issue written');
    return;
  }
  const { createGithubIssue, resolveGithubIssue } = await import('./lib/github-issue-creator.mjs');
  if (evaluation.breaches.length) {
    await createGithubIssue({ title: GCP_COST_ISSUE_TITLE, description: report, priority: 2, workflow: 'GCP Cost Monitor' });
  } else {
    resolveGithubIssue(GCP_COST_ISSUE_TITLE, { workflow: 'GCP Cost Monitor', runUrl });
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch(() => {
    console.error('[monitor-gcp-costs] measurement failed; details withheld');
    process.exit(1);
  });
}
