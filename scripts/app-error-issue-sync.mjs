#!/usr/bin/env node
/**
 * app-error-issue-sync.mjs — turns the GA4 `errorHealth.appErrors` block
 * from reports/analytics-latest.json (produced by
 * `analytics-report.mjs --save`, which analytics.yml already runs weekly)
 * into deduplicated GitHub backlog issues.
 *
 * Threshold-gated: only errors with >= MIN_COUNT hits in the report window
 * open/recur an issue, so a single one-off exception doesn't spam the
 * backlog. Capped at MAX_ISSUES per run.
 *
 * Labeled `stability` + `app-error` — NOT `agent:fix`. AGENTS.md's
 * auto-route allowlist is `crawler`/`follow-up` only; a real user-facing
 * error needs human triage before an autonomous fixer touches it.
 *
 * Report-only source: any failure here (missing report, bad JSON) logs and
 * exits 0 so it never paints the parent workflow red over a reporting gap.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sanitizeTrackedDiagnosticValue } from './lib/sanitizeTrackedDiagnostics.mjs';
import { isIssueDenied, syncErrorIssues } from './lib/error-issue-sync.mjs';

const REPORT_PATH = process.env.ANALYTICS_REPORT_PATH || 'reports/analytics-latest.json';
const MIN_COUNT = Number(process.env.APP_ERROR_MIN_COUNT || 5);
const MAX_ISSUES = Number(process.env.APP_ERROR_MAX_ISSUES || 5);

export function truncate(value, n) {
  const str = String(value ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function main() {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  } catch (e) {
    console.log(`[app-error-issue-sync] no report at ${REPORT_PATH} (${e.message}) — skip`);
    return;
  }

  const eh = report?.ga4?.errorHealth;
  if (!eh || !eh.totalErrors) {
    console.log('[app-error-issue-sync] no errorHealth / zero errors in report — nothing to sync');
    return;
  }

  const entries = (eh.appErrors || [])
    .filter((e) => (e.count || 0) >= MIN_COUNT)
    // Shared issue-creation deny-list (self-healed version-skew transients,
    // #3758/#3759/#3761 class): the same error reaches GA4 app_error and
    // PostHog $exception through parallel pipelines, so the "tracked in
    // dashboards but never a backlog ticket" decision must apply to BOTH
    // feeders — see ISSUE_DENY_PATTERNS in ./lib/error-issue-sync.mjs.
    .filter((e) => !isIssueDenied(e.errorMessage))
    .sort((a, b) => b.count - a.count);

  if (!entries.length) {
    console.log(`[app-error-issue-sync] no app_error above MIN_COUNT=${MIN_COUNT} — nothing to sync`);
    return;
  }

  const stackByMessage = new Map((eh.topStacks || []).map((s) => [s.message, s.stack]));

  return syncErrorIssues({
    entries,
    maxIssues: MAX_ISSUES,
    labels: ['stability', 'app-error'],
    source: 'Weekly Analytics Report — GA4 app_error',
    priorityFor: (e) => ((eh.errorRate >= 1.0 || e.count >= MIN_COUNT * 10) ? 2 : 3),
    titleFor: (e) => {
      const type = truncate(sanitizeTrackedDiagnosticValue(e.errorType) || 'error', 20);
      const msg = truncate(sanitizeTrackedDiagnosticValue(e.errorMessage), 60);
      return `App Error: ${type} — ${msg}`;
    },
    bodyFor: (e) => {
      const stack = stackByMessage.get(e.errorMessage);
      const lines = [
        `**Type:** ${sanitizeTrackedDiagnosticValue(e.errorType)}`,
        `**Message:** ${sanitizeTrackedDiagnosticValue(e.errorMessage)}`,
        `**Page:** ${sanitizeTrackedDiagnosticValue(e.pagePath)}`,
        `**Hits (report window):** ${e.count} | **Affected users:** ${e.users}`,
        `**Site-wide error rate:** ${eh.errorRate}% (${eh.healthStatus})`,
      ];
      if (stack) {
        lines.push('', '**Stack:**', '```', truncate(sanitizeTrackedDiagnosticValue(stack), 1500), '```');
      }
      lines.push('', '_Source: GA4 `app_error` events — full errorHealth table in the Weekly Analytics Report run summary._');
      return lines.join('\n');
    },
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/truncate() never triggers a live gh call — same guard as
// scripts/dmarc-monitor.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[app-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
