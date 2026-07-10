#!/usr/bin/env node
/**
 * posthog-error-issue-sync.mjs — queries PostHog `$exception` events (same
 * HogQL shape as scripts/triage-app-errors.mjs' top-messages query) for the
 * top recurring client errors and opens/dedupes GitHub backlog issues for
 * the ones above threshold.
 *
 * Companion to app-error-issue-sync.mjs (GA4 source): kept as a separate
 * script because PostHog's `$exception` payload and GA4's `app_error`
 * custom-dimension payload aren't a 1:1 join, and either source can capture
 * an error the other misses (ad blockers / consent state / SDK differences).
 *
 * Report-only source: a PostHog API failure logs and exits 0 rather than
 * failing the workflow — this is a backlog feeder, not a gate.
 */
import { pathToFileURL } from 'node:url';
import { sanitizeTrackedDiagnosticValue } from './lib/sanitizeTrackedDiagnostics.mjs';
import { isIssueDenied, syncErrorIssues } from './lib/error-issue-sync.mjs';

export function truncate(value, n) {
  const str = String(value ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// Issue-creation deny-list (self-healed transients / confirmed-benign noise
// kept in PostHog for dashboards but not worth a GitHub ticket) is shared
// with the GA4 feeder — see ISSUE_DENY_PATTERNS in ./lib/error-issue-sync.mjs
// (#3762, #3758/#3759/#3761).

async function hogql(host, pid, key, query) {
  const r = await fetch(`${host}/api/projects/${pid}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PH ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export async function main() {
  // Read env lazily (not at module load) so importing this module for tests
  // doesn't freeze stale/missing credentials — each run's env is fixed by
  // the time main() is invoked, whether that's the CLI entrypoint below or
  // a test calling main() directly.
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const WINDOW_DAYS = process.env.WINDOW_DAYS || '7';
  const MIN_COUNT = Number(process.env.POSTHOG_ERROR_MIN_COUNT || 5);
  const MAX_ISSUES = Number(process.env.POSTHOG_ERROR_MAX_ISSUES || 5);

  if (!KEY || !PID) {
    console.log('[posthog-error-issue-sync] POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing — skip');
    return;
  }

  const query = `
    SELECT
      properties.$exception_values.1 AS msg,
      properties.$exception_types.1 AS type,
      count() AS n,
      count(DISTINCT $session_id) AS sessions,
      any(properties.$current_url) AS sample_url
    FROM events
    WHERE event = '$exception'
      AND timestamp > now() - INTERVAL ${WINDOW_DAYS} DAY
    GROUP BY msg, type
    ORDER BY n DESC
    LIMIT 25
  `.trim();

  let rows;
  try {
    const result = await hogql(HOST, PID, KEY, query);
    rows = result.results || [];
  } catch (e) {
    console.error(`[posthog-error-issue-sync] HogQL query failed: ${e.message}`);
    return;
  }

  const entries = rows
    .map(([msg, type, n, sessions, sampleUrl]) => ({
      message: msg, type: type || 'exception', count: n, sessions, sampleUrl,
    }))
    .filter((e) => e.count >= MIN_COUNT)
    .filter((e) => !isIssueDenied(e.message));

  if (!entries.length) {
    console.log(`[posthog-error-issue-sync] no $exception above MIN_COUNT=${MIN_COUNT} in last ${WINDOW_DAYS}d — nothing to sync`);
    return;
  }

  return syncErrorIssues({
    entries,
    maxIssues: MAX_ISSUES,
    labels: ['stability', 'app-error'],
    source: `PostHog Error Monitor — last ${WINDOW_DAYS}d`,
    priorityFor: (e) => (e.count >= MIN_COUNT * 10 ? 2 : 3),
    titleFor: (e) => `PostHog Exception: ${truncate(sanitizeTrackedDiagnosticValue(e.type), 20)} — ${truncate(sanitizeTrackedDiagnosticValue(e.message), 60)}`,
    bodyFor: (e) => [
      `**Type:** ${sanitizeTrackedDiagnosticValue(e.type)}`,
      `**Message:** ${sanitizeTrackedDiagnosticValue(e.message)}`,
      `**Occurrences (last ${WINDOW_DAYS}d):** ${e.count} | **Distinct sessions:** ${e.sessions}`,
      `**Sample URL:** ${sanitizeTrackedDiagnosticValue(e.sampleUrl)}`,
      '',
      '_Source: PostHog `$exception` autocapture events._',
    ].join('\n'),
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/truncate() never triggers a live PostHog/gh call — same
// guard as scripts/dmarc-monitor.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[posthog-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
