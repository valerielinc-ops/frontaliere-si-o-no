#!/usr/bin/env node
/**
 * Aggregate the per-crawler JSON reports written by
 * `scripts/backfill-expired-from-history.mjs` under DRY_RUN=1
 * (BACKFILL_REPORT_PATH) into one `report.json`, print a readable summary and
 * fail when any served route was lost or changed owner.
 *
 * Usage: node scripts/ci/summarize-backfill-dry-run.mjs <report-dir> [log-file]
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const REFUSAL_LINE = /refusing to write the archive/u;
const HEAP_LINE = /^\[heap\]/u;
const TIMING_LINE = /^\[timing\]/u;
const GHOST_LINE = /Expired slice ghost reconciliation: kept/u;

export function summarizeDryRun(reports, logText = '', expectedKeys = null) {
  const crawlers = reports.map((report) => ({
    crawlerKey: report.crawlerKey,
    refused: Boolean(report.refused),
    refusedRoutes: report.refusedRoutes || 0,
    collisions: report.collisions || 0,
    unrestoredLegitimateRoutes: report.unrestoredLegitimateRoutes || 0,
    unrestoredLegitimateRouteKeys: report.unrestoredLegitimateRouteKeys || [],
    refusalReason: report.refusalReason || '',
    refusedRouteKeys: report.refusedRouteKeys || [],
    refusedRouteKeysDigest: report.refusedRouteKeysDigest || '',
    timings: report.timings || {},
    distinctOids: report.distinctOids || {},
    parses: report.parses || {},
    restoredByLocale: report.restoredByLocale || {},
    lost: report.lost || [],
    ownerChanged: report.ownerChanged || [],
  }));
  const restoredByLocale = {};
  for (const crawler of crawlers) {
    for (const [locale, count] of Object.entries(crawler.restoredByLocale)) {
      restoredByLocale[locale] = (restoredByLocale[locale] || 0) + count;
    }
  }
  const logLines = String(logText).split(/\r?\n/u);
  const reported = new Set(crawlers.map((crawler) => crawler.crawlerKey));
  const missingCrawlers = (expectedKeys || []).filter((key) => !reported.has(key));
  return {
    // false when any requested crawler left no report (budget, timeout, error)
    complete: missingCrawlers.length === 0,
    missingCrawlers,
    crawlers,
    totals: {
      crawlers: crawlers.length,
      refusedCrawlers: crawlers.filter((crawler) => crawler.refused).map((crawler) => crawler.crawlerKey),
      refusedRoutes: crawlers.reduce((sum, crawler) => sum + crawler.refusedRoutes, 0),
      collisions: crawlers.reduce((sum, crawler) => sum + crawler.collisions, 0),
      unrestoredLegitimateRoutes: crawlers.reduce((sum, crawler) => sum + crawler.unrestoredLegitimateRoutes, 0),
      restoredByLocale,
      lost: crawlers.reduce((sum, crawler) => sum + crawler.lost.length, 0),
      ownerChanged: crawlers.reduce((sum, crawler) => sum + crawler.ownerChanged.length, 0),
      maxRssMb: Math.max(0, ...reports.map((report) => report.maxRssMb || 0)),
    },
    refusalLogLines: logLines.filter((line) => REFUSAL_LINE.test(line)),
    heapLines: logLines.filter((line) => HEAP_LINE.test(line)),
    timingLines: logLines.filter((line) => TIMING_LINE.test(line)),
    ghostReconciliationLines: logLines.filter((line) => GHOST_LINE.test(line)),
  };
}

export function dryRunExitCode(summary) {
  return summary.totals.lost > 0 || summary.totals.ownerChanged > 0 || !summary.complete ? 1 : 0;
}

function main() {
  const [reportDir, logFile, expectedKeysFile] = process.argv.slice(2);
  if (!reportDir) {
    console.error('usage: summarize-backfill-dry-run.mjs <report-dir> [log-file]');
    process.exit(2);
  }
  const reports = fs.readdirSync(reportDir)
    .filter((name) => name.endsWith('.json') && name !== 'report.json')
    .sort()
    .flatMap((name) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(reportDir, name), 'utf-8'));
      return (parsed.crawlers || []).map((crawler) => ({ ...crawler, maxRssMb: parsed.maxRssMb }));
    });
  const logText = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
  const expectedKeys = expectedKeysFile && fs.existsSync(expectedKeysFile)
    ? fs.readFileSync(expectedKeysFile, 'utf-8').split(/\r?\n/u).filter(Boolean)
    : null;
  const summary = summarizeDryRun(reports, logText, expectedKeys);
  fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const { totals } = summary;
  const lines = [
    '## Backfill dry-run report',
    `crawlers=${totals.crawlers} refusedCrawlers=${totals.refusedCrawlers.length} refusedRoutes=${totals.refusedRoutes} unrestoredLegitimateRoutes=${totals.unrestoredLegitimateRoutes}`,
    `restoredByLocale=${JSON.stringify(totals.restoredByLocale)}`,
    `lost=${totals.lost} ownerChanged=${totals.ownerChanged} maxRssMb=${totals.maxRssMb}`,
    `complete=${summary.complete}${summary.complete ? '' : ` missing=${summary.missingCrawlers.join(',')}`}`,
    ...summary.crawlers.map((crawler) => `crawler ${crawler.crawlerKey}: lost=${crawler.lost.length} ownerChanged=${crawler.ownerChanged.length} refused=${crawler.refused} restored=${JSON.stringify(crawler.restoredByLocale)}`),
    ...summary.refusalLogLines.map((line) => `log: ${line}`),
    ...summary.heapLines.map((line) => `log: ${line}`),
    ...summary.timingLines.map((line) => `log: ${line}`),
    ...summary.crawlers.map((crawler) => `crawler ${crawler.crawlerKey}: timingsMs=${JSON.stringify(crawler.timings)} distinctOids=${JSON.stringify(crawler.distinctOids)} parses=${JSON.stringify(crawler.parses)}`),
    ...summary.ghostReconciliationLines.map((line) => `log: ${line}`),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  const exitCode = dryRunExitCode(summary);
  if (exitCode !== 0) {
    console.error(`::error::Dry-run not accepted: lost=${totals.lost} ownerChanged=${totals.ownerChanged} complete=${summary.complete}${summary.complete ? '' : ` missing=${summary.missingCrawlers.join(',')}`}`);
  }
  process.exit(exitCode);
}

if (isInvokedDirectly(import.meta.url)) main();
