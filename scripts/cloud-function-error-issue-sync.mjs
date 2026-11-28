#!/usr/bin/env node
/**
 * Report Cloud Functions errors from Cloud Logging to the backlog
 * (workflow: .github/workflows/cloud-function-errors.yml).
 *
 * One stable issue per function (`Cloud Function error: <name>`), minted with
 * the shared create/dedupe loop and closed by the shared reconcile phase after
 * one complete clean measurement, like the Cloudflare Worker and zone 5xx
 * monitors. Log payloads are never copied: only counts and function names.
 *
 * A monitor outage is not evidence that the functions are healthy: a failed or
 * page-capped read reconciles nothing (no close, no comment) and exits 1 so the
 * run is red and reported as a workflow failure.
 */
import { fetchFunctionErrors, getLoggingToken } from './lib/cloud-function-logs.mjs';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';
import { intFromEnv, positiveIntFromEnv } from './lib/int-from-env.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

export const ISSUE_TITLE_PREFIX = 'Cloud Function error: ';
export const ISSUE_FAMILY = 'cloud-function-errors';
export const ISSUE_FAMILY_LABEL = 'cloud-function-error';
export const DEFAULT_HOURS = 24;
export const DEFAULT_MIN_ERRORS = 5;
export const DEFAULT_MAX_ISSUES = 5;
export const DRY_RUN_COMMAND = 'source bin/rc-env.sh && node frontaliere-si-o-no/scripts/cloud-function-error-issue-sync.mjs --dry-run';

export const titleFor = (entry) => `${ISSUE_TITLE_PREFIX}${entry.name}`;

export function functionFromIssue(issue) {
  const title = String(issue?.title ?? '');
  return title.startsWith(ISSUE_TITLE_PREFIX) ? title.slice(ISSUE_TITLE_PREFIX.length) : null;
}

export function buildIssueBody(entry, measurement) {
  const { window } = measurement;
  return [
    `**Function:** \`${entry.name}\``,
    `**Project:** \`${measurement.projectId}\``,
    `**Errors (severity ERROR or higher, last ${window.hours}h):** ${entry.errors}`,
    `**Window:** ${window.from} → ${window.to}`,
    `**Latest error:** ${entry.latestAt || 'unknown'}`,
    '',
    'Log payloads are withheld from this public issue: read them in Logs Explorer with the filter `severity>=ERROR` and the function name.',
    '',
    buildScheda({
      causa: [
        `Cloud Logging recorded ${entry.errors} entries of severity ERROR or higher for \`${entry.name}\` in the trailing window.`,
        'The count identifies the failing function, not the root cause: open the entries in Logs Explorer before changing code.',
      ],
      fix: [`Triaging target: \`functions/src\` handler of \`${entry.name}\` and the dependency named by its latest stack trace.`],
      metrica: `prima=${entry.errors} errori in ${window.hours}h atteso=0 in una finestra completa`,
      comando: DRY_RUN_COMMAND,
      osservatore: [
        '`.github/workflows/cloud-function-errors.yml` runs hourly and reads the Cloud Logging API read-only.',
        'It closes this issue after one complete clean measurement; API failures, missing permission and page-capped reads keep it open without writing a false green.',
      ],
      fallimento: `\`${ISSUE_TITLE_PREFIX}${entry.name}\``,
      note: ['The issue reporter copies no log payloads, headers or user data into the backlog.'],
    }),
  ].join('\n');
}

export function alertEntries(measurement, minErrors = DEFAULT_MIN_ERRORS) {
  return (measurement?.functions || []).filter((f) => f.errors >= minErrors);
}

export function functionReconcile(measurement) {
  return {
    family: ISSUE_FAMILY,
    labels: ['stability', ISSUE_FAMILY_LABEL],
    titlePrefix: ISSUE_TITLE_PREFIX,
    confirmations: 1,
    verdictFor: (issue) => {
      const name = functionFromIssue(issue);
      const measuredAt = measurement?.window?.to || '';
      const base = { measuredAt, measure: `${measuredAt}:${name || 'unknown'}`, command: DRY_RUN_COMMAND };
      // A page-capped read is a lower bound: it can prove a defect, never its absence.
      if (!name || measurement?.complete !== true) {
        return { ...base, clean: false, complete: false, evidence: 'Cloud Logging read incomplete or function name unknown' };
      }
      const errors = measurement.functions.find((f) => f.name === name)?.errors ?? 0;
      return {
        ...base,
        // Below the mint threshold counts as clean: it is the same bar that opened the issue.
        clean: errors < (measurement.minErrors ?? DEFAULT_MIN_ERRORS),
        complete: true,
        evidence: `${name}=${errors} error(s) in ${measurement.window.hours}h; complete=yes`,
      };
    },
  };
}

export async function main({
  fetchImpl = fetch,
  getToken = getLoggingToken,
  dryRun = process.argv.includes('--dry-run'),
  env = process.env,
} = {}) {
  const hours = Math.min(positiveIntFromEnv('CF_FUNCTION_ERRORS_HOURS', DEFAULT_HOURS), 72);
  const minErrors = positiveIntFromEnv('CF_FUNCTION_ERRORS_MIN_COUNT', DEFAULT_MIN_ERRORS);
  const maxIssues = intFromEnv('CF_FUNCTION_ERRORS_MAX_ISSUES', DEFAULT_MAX_ISSUES);
  let measurement;
  try {
    const token = await getToken();
    if (!token) throw new Error('no service-account credentials');
    measurement = await fetchFunctionErrors({ token, projectId: env.GCP_PROJECT_ID || undefined, hours, fetchImpl });
  } catch (error) {
    // No reconcile: an unreadable measurement must never close or annotate issues.
    console.error(`[cloud-function-error-issue-sync] Cloud Logging read failed: ${error?.message || error}`);
    return { measurement: null, results: [], exitCode: 1 };
  }
  measurement.minErrors = minErrors;
  for (const f of measurement.functions) console.log(`[cloud-function-error-issue-sync] ${f.name}: ${f.errors} error(s)`);
  const results = await syncErrorIssues({
    entries: alertEntries(measurement, minErrors),
    maxIssues,
    labels: ['stability', 'monitoring', ISSUE_FAMILY_LABEL],
    source: `Cloud Function Errors Monitor — last ${hours}h`,
    priorityFor: (entry) => (entry.errors >= 100 ? 2 : 3),
    titleFor,
    bodyFor: (entry) => buildIssueBody(entry, measurement),
    dryRun,
    reconcile: functionReconcile(measurement),
  });
  console.log(`[cloud-function-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s); complete=${measurement.complete ? 'yes' : 'no'}`);
  return { measurement, results, exitCode: 0 };
}

if (isInvokedDirectly(import.meta.url)) {
  const { exitCode } = await main();
  process.exit(exitCode);
}
