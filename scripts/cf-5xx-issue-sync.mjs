#!/usr/bin/env node
/**
 * cf-5xx-issue-sync.mjs — zone-wide Cloudflare 5xx watchdog.
 *
 * Shells out to the existing scripts/cf-status-report.mjs (--json --class=5)
 * instead of re-implementing the GraphQL query (AGENTS.md #6 — no duplicated
 * CF-analytics construct; the query already lives in scripts/lib/cf-analytics.mjs
 * and cf-status-report.mjs), then opens/dedupes GitHub issues for paths with
 * sustained 5xx volume.
 *
 * Complements production-canary.yml, which probes a FIXED list of known URLs
 * every 15min — this catches 5xx on ANY path across the whole zone (unknown
 * routes, CDN asset paths, locale-router shards) that the fixed probe list
 * doesn't cover.
 *
 * Report-only source: a CF API failure logs and exits 0 rather than failing
 * the workflow — this is a backlog feeder, not a gate.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sanitizeUrlLikeText } from './lib/sanitizeTrackedDiagnostics.mjs';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';

const HOURS = process.env.CF_5XX_HOURS || '23';
const MIN_COUNT = Number(process.env.CF_5XX_MIN_COUNT || 20);
const MAX_ISSUES = Number(process.env.CF_5XX_MAX_ISSUES || 5);

export async function main() {
  if (!process.env.CF_API_TOKEN) {
    console.log('[cf-5xx-issue-sync] CF_API_TOKEN missing — skip');
    return;
  }

  let data;
  try {
    const out = execFileSync(
      'node',
      ['scripts/cf-status-report.mjs', '--json', '--class=5', `--hours=${HOURS}`, '--limit=50'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
    data = JSON.parse(out);
  } catch (e) {
    console.error(`[cf-5xx-issue-sync] cf-status-report.mjs failed: ${e.message}`);
    return;
  }

  const entries = (data.detail || [])
    .filter((r) => r.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  if (!entries.length) {
    console.log(`[cf-5xx-issue-sync] no path with >= ${MIN_COUNT} 5xx in last ${HOURS}h — nothing to sync`);
    return;
  }

  return syncErrorIssues({
    entries,
    maxIssues: MAX_ISSUES,
    labels: ['stability', 'cloudflare-5xx'],
    source: `Cloudflare 5xx Monitor — last ${HOURS}h (zone-wide)`,
    priorityFor: (e) => (e.count >= MIN_COUNT * 5 ? 2 : 3),
    titleFor: (e) => `CF 5xx: ${sanitizeUrlLikeText(e.url).slice(0, 80)}`,
    bodyFor: (e) => [
      `**Status:** ${e.status}`,
      `**URL:** ${sanitizeUrlLikeText(e.url)}`,
      `**Requests (last ${HOURS}h):** ${e.count}`,
      '',
      '_Source: Cloudflare GraphQL Analytics (`httpRequestsAdaptiveGroups`), zone-wide eyeball 5xx — see scripts/cf-status-report.mjs._',
    ].join('\n'),
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main() never triggers a live CF/gh call — same guard as
// scripts/dmarc-monitor.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[cf-5xx-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
