#!/usr/bin/env node
/**
 * Report errors from the Cloudflare Workers Metrics "Errors" chart to GitHub.
 *
 * This is intentionally separate from cf-5xx-issue-sync.mjs: zone HTTP 5xx
 * and Worker invocation statuses answer different operational questions.
 * Metrics are queried once per error status so a saturated account response
 * cannot hide the status that is actually failing.
 */
import { pathToFileURL } from 'node:url';

import { syncErrorIssues } from './lib/error-issue-sync.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import { intFromEnv, positiveIntFromEnv } from './lib/int-from-env.mjs';
import {
  WORKER_ERROR_STATUSES,
  WORKER_NAME,
  fetchWorkerInvocationErrors,
  measurementAt,
  measurementIsClean,
  statusMeasurement,
} from './lib/cf-worker-analytics.mjs';

export const DASHBOARD_URL =
  'https://dash.cloudflare.com/a426452d1d2987ac744c6feff20dd8b3/workers/services/view/frontaliere-locale-router/production/metrics/charts/errors';
export const ISSUE_TITLE_PREFIX = 'Cloudflare Worker error: ';
export const ISSUE_FAMILY = 'cloudflare-worker-errors';
export const ISSUE_FAMILY_LABEL = 'cloudflare-worker-error';
export const DEFAULT_HOURS = 23;
export const DEFAULT_MIN_ERRORS = 1;
export const DEFAULT_MAX_ISSUES = 3;
export const DRY_RUN_COMMAND =
  'source bin/rc-env.sh && node frontaliere-si-o-no/scripts/cloudflare-worker-error-issue-sync.mjs --dry-run';

function configuredHours(value = process.env.CF_WORKER_ERRORS_HOURS ?? DEFAULT_HOURS) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_HOURS;
  return Math.min(hours, 23.9);
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function percent(value) {
  return `${(number(value) * 100).toFixed(3)}%`;
}

function statusTitle(status) {
  return `${ISSUE_TITLE_PREFIX}${WORKER_NAME} / ${status}`;
}

export function titleFor(entry) {
  return statusTitle(String(entry?.status ?? 'unknown'));
}

export function statusFromIssue(issue) {
  const title = String(issue?.title ?? '');
  return WORKER_ERROR_STATUSES.find((status) => title === statusTitle(status)) || null;
}

function statusDescription(status) {
  return {
    scriptThrewException: 'Script Threw Exception',
    exceededResources: 'Exceeded Resources',
    internalError: 'Internal Error',
  }[status] || status;
}

/**
 * Render the actionable issue body. Observability logs are deliberately not
 * required here: they are sampled/retained separately from Metrics, while the
 * status count is the same signal shown by the supplied Cloudflare chart.
 */
export function buildIssueBody(entry, hours = DEFAULT_HOURS) {
  const status = String(entry?.status ?? 'unknown');
  const errors = number(entry?.errors);
  const requests = number(entry?.requests);
  const window = entry?.window || {};
  const complete = entry?.complete === true;
  return [
    `**Worker:** \`${WORKER_NAME}\``,
    `**Cloudflare invocation status:** \`${status}\` (${statusDescription(status)})`,
    `**Errors (last ${hours}h):** ${errors}`,
    `**Requests in this status:** ${requests}`,
    `**Error rate for this status:** ${percent(entry?.errorRate)}`,
    `**Window:** ${window.from || 'unknown'} → ${window.to || 'unknown'}`,
    `**Metric rows:** ${number(entry?.rows)}; complete=${complete ? 'yes' : 'no'}`,
    entry?.latestAt ? `**Latest measured row:** ${entry.latestAt}` : '**Latest measured row:** none',
    '',
    `[Open the Cloudflare Errors chart](${DASHBOARD_URL})`,
    '',
    '_Source: Cloudflare Workers GraphQL Analytics `workersInvocationsAdaptive`, filtered by account, Worker name, time window, and invocation status._',
    '',
    buildScheda({
      causa: [
        `Cloudflare measured ${errors} invocation(s) with status \`${status}\` for \`${WORKER_NAME}\` in the trailing window.`,
        'The status identifies a Worker execution outcome, not a specific public URL or root cause; inspect the Worker trace/Observability logs before changing routing.',
      ],
      fix: [
        'Triaging target: `infra/cloudflare-worker/locale-router.js` and the upstream response/body path reached by the failing request.',
        'A fix is complete only when the status is zero in two consecutive complete monitor windows; a missing or capped Metrics response is not considered clean.',
      ],
      metrica: `prima=${errors} ${status} errors in ${hours}h atteso=0 in due finestre complete consecutive`,
      comando: DRY_RUN_COMMAND,
      osservatore: [
        '`.github/workflows/cloudflare-worker-errors.yml` runs hourly and uses the same account-level Metrics series as the supplied dashboard.',
        'The workflow queries `scriptThrewException`, `exceededResources`, and `internalError` separately, then deduplicates by this stable title.',
        'It closes only after two complete clean measurements for this status; API failures, missing rows, and row-cap saturation keep the issue open without writing a false green.',
      ],
      fallimento: `\`${titleFor(entry)}\``,
      note: [
        `Window measured: ${window.from || 'unknown'} → ${window.to || 'unknown'}.`,
        'The issue reporter does not copy secrets or raw request headers into the backlog.',
      ],
    }),
  ].join('\n');
}

export function workerReconcile(measurement) {
  return {
    family: ISSUE_FAMILY,
    // `stability` is an existing label and remains the family-list fallback if
    // GitHub refuses to create the more specific label during an outage.
    labels: ['stability', ISSUE_FAMILY_LABEL],
    titlePrefix: ISSUE_TITLE_PREFIX,
    confirmations: 2,
    verdictFor: (issue) => {
      const status = statusFromIssue(issue);
      const item = status ? statusMeasurement(measurement, status) : null;
      if (!status || measurement?.complete !== true || item?.complete !== true) {
        return {
          clean: false,
          complete: false,
          evidence: 'Cloudflare Worker Metrics response incomplete or issue status unknown',
          measuredAt: measurementAt(measurement),
          measure: `${measurementAt(measurement)}:${status || 'unknown'}`,
          command: DRY_RUN_COMMAND,
        };
      }
      return {
        clean: measurementIsClean(measurement, status),
        complete: true,
        evidence: `${status}=${item.errors} error(s) in ${measurement.window.hours}h; complete=yes`,
        measuredAt: measurementAt(measurement),
        measure: `${measurementAt(measurement)}:${status}`,
        command: DRY_RUN_COMMAND,
      };
    },
  };
}

function emptyMeasurement(reason, hours) {
  const now = new Date().toISOString();
  return {
    worker: WORKER_NAME,
    accountTag: '',
    window: { hours, from: now, to: now },
    statuses: WORKER_ERROR_STATUSES.map((status) => ({ status, errors: 0, requests: 0, complete: false, rows: 0 })),
    complete: false,
    reason,
  };
}

export async function main({ fetchImpl = fetch, dryRun = process.argv.includes('--dry-run') } = {}) {
  const hours = configuredHours();
  const minErrors = positiveIntFromEnv('CF_WORKER_ERRORS_MIN_COUNT', DEFAULT_MIN_ERRORS);
  const maxIssues = intFromEnv('CF_WORKER_ERRORS_MAX_ISSUES', DEFAULT_MAX_ISSUES);
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
    console.log('[cloudflare-worker-error-issue-sync] CF_API_TOKEN or CF_ACCOUNT_ID missing — skip');
    return { measurement: null, results: [] };
  }

  let measurement;
  try {
    measurement = await fetchWorkerInvocationErrors(process.env.CF_API_TOKEN, process.env.CF_ACCOUNT_ID, {
      hours,
      fetchImpl,
    });
  } catch (error) {
    const reason = error?.message || String(error);
    console.error(`[cloudflare-worker-error-issue-sync] Cloudflare Metrics failed — ${reason}`);
    // A monitor outage is not evidence that the Worker is healthy. Do not
    // reconcile/close existing issues after an unreadable measurement.
    return { measurement: emptyMeasurement(reason, hours), results: [] };
  }

  for (const item of measurement.statuses) {
    console.log(
      `[cloudflare-worker-error-issue-sync] ${item.status}: ${item.errors} error(s), ` +
        `${item.requests} request(s), complete=${item.complete ? 'yes' : 'no'}`,
    );
  }

  const entries = measurement.statuses
    .filter((item) => item.complete && item.errors >= minErrors)
    .sort((a, b) => b.errors - a.errors)
    .map((item) => ({ ...item, worker: measurement.worker }));
  const results = await syncErrorIssues({
    entries,
    maxIssues,
    labels: ['stability', 'monitoring', ISSUE_FAMILY_LABEL],
    source: `Cloudflare Worker Errors Monitor — ${WORKER_NAME} — last ${hours}h`,
    priorityFor: (entry) => (entry.errors >= 100 ? 2 : 3),
    titleFor,
    bodyFor: (entry) => buildIssueBody(entry, hours),
    dryRun,
    reconcile: workerReconcile(measurement),
  });
  console.log(`[cloudflare-worker-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  return { measurement, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
