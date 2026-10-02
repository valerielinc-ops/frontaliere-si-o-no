#!/usr/bin/env node
/**
 * Export the query-level Search Console performance for ONE page —
 * "Fase 2: export query corretto per singola pagina" della GSC content-gap
 * playbook (issue #6221, docs/gsc-content-refresh-playbook.md).
 *
 * Writes a CSV (page,query,country,device,clicks,impressions,ctrPercent,position,nearWin) meant to be
 * pasted into the playbook's LLM prompt alongside the page content, plus a
 * JSON sidecar with export metadata (page, period, row count) for the audit
 * trail the playbook asks to keep. Read-only — never edits page content.
 *
 * Usage:
 *   node scripts/gsc-page-query-export.mjs --page=/guida-frontaliere/permesso-g
 *     [--days=90] [--row-limit=1000] [--out=data/gsc-content-refresh]
 *
 *   node scripts/gsc-page-query-export.mjs --top50-monitor --out=reports/gsc-top50-monitor
 *   GSC_TOP50_DEPLOYED_AT supplies the actual deployment timestamp for the
 *   fixed September baseline / first 30 complete post-deployment days.
 *
 * Auth strategy (tries in order):
 *   1. OAuth2 refresh-token (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN)
 *   2. Service Account (GOOGLE_APPLICATION_CREDENTIALS)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchRetry, getServiceAccountToken } from './lib/ga4-service-account.mjs';
import { buildNearWinQueries } from './lib/analytics-opportunity-utils.mjs';
import { utcDaysBefore } from './lib/analytics-settled-window.mjs';

const SITE = 'sc-domain:frontaliereticino.ch';
const SITE_URL = 'https://frontaliereticino.ch';
const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
// Keep requests small and paginate explicitly; the client cap and API
// omissions are reported separately from the page totals.
const DEFAULT_ROW_LIMIT = 1000;

function argFlag(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function getOAuthToken() {
  const id = process.env.GSC_CLIENT_ID;
  const secret = process.env.GSC_CLIENT_SECRET;
  const refresh = process.env.GSC_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    console.error(`OAuth token refresh failed (${r.status}): ${await r.text()}`);
    return null;
  }
  return (await r.json()).access_token;
}

async function getToken() {
  const oauth = await getOAuthToken();
  if (oauth) return oauth;
  const sa = await getServiceAccountToken([GSC_READONLY_SCOPE]);
  if (sa) return sa;
  throw new Error(
    'No GSC credentials available. Set GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN ' +
    'or GOOGLE_APPLICATION_CREDENTIALS pointing at a SA with GSC access.',
  );
}

const fmt = (d) => d.toISOString().slice(0, 10);

function toCsvValue(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugForPage(pagePath) {
  const stripped = pagePath.replace(/^\//, '').replace(/\/$/, '');
  return (stripped || 'home').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export const TOP50_SNIPPET_PAGES = [
  '/prezzi-benzina/oggi/', '/prezzi-diesel/oggi/', '/concorsi-pubblici-lugano/',
];
export const TOP50_BASELINE = { start: '2026-09-01', end: '2026-09-30' };
const DAY_MS = 86400000;
const gscDay = (now) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const shiftDay = (day, delta) => fmt(utcDaysBefore(new Date(`${day}T12:00:00Z`), -delta));
const daysInWindow = (window) => Math.round((Date.parse(window.end) - Date.parse(window.start)) / DAY_MS) + 1;

export function monitoringWindows(deployedAt, now = new Date()) {
  const settledThrough = shiftDay(gscDay(now), -2);
  if (!deployedAt) return { baseline: TOP50_BASELINE, after: null, settledThrough, status: 'awaiting-deployment' };
  const deployed = new Date(deployedAt);
  if (!Number.isFinite(deployed.getTime())) throw new Error('Invalid GSC_TOP50_DEPLOYED_AT');
  // Exclude the deployment day: the next Pacific calendar day is the first
  // complete day in Search Console, independently of the runner timezone.
  const start = shiftDay(gscDay(deployed), 1);
  const after = { start, end: shiftDay(start, daysInWindow(TOP50_BASELINE) - 1) };
  if (start <= TOP50_BASELINE.end) throw new Error('Deployment must follow the baseline window');
  return { baseline: TOP50_BASELINE, after, settledThrough,
    status: after.end <= settledThrough ? 'ready' : 'awaiting-complete-window' };
}

export function aggregatePerformance(rows) {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null,
    position: impressions ? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions : null };
}

function normalizePage(page) {
  const url = new URL(page, SITE_URL);
  if (url.origin !== SITE_URL || url.search || url.hash) throw new Error('Page must be a canonical frontaliereticino.ch URL without query/hash');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export async function exportPage({ page, window, token, rowLimit = DEFAULT_ROW_LIMIT, maxRows = 100000, fetchImpl = fetchRetry }) {
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25000) throw new Error('row-limit must be 1..25000');
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('maxRows must be positive');
  const pageUrl = normalizePage(page);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
  // A fixed reporting lag is only the earliest attempt, never proof that
  // Google has finalized every day. Probe unfiltered site dates as Google
  // recommends: no impressions on one page must not look like missing data.
  const dateProbe = await fetchImpl(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: window.start, endDate: window.end, type: 'web', dataState: 'all',
      dimensions: ['date'], rowLimit: 25000 }),
  }, 2, 30000);
  if (!dateProbe.ok) throw new Error(`GSC date availability probe failed (${dateProbe.status})`);
  const dateData = await dateProbe.json();
  const availableDates = new Set((dateData.rows || []).map((row) => row.keys[0]));
  const expectedDates = Array.from({ length: daysInWindow(window) }, (_, i) => shiftDay(window.start, i));
  const firstIncompleteDate = dateData.metadata?.first_incomplete_date || null;
  const missingDates = expectedDates.filter((date) => !availableDates.has(date));
  const settlement = { firstIncompleteDate, missingDates,
    complete: missingDates.length === 0 && (!firstIncompleteDate || firstIncompleteDate > window.end),
    probe: 'site dates, dataState=all; missing dates are unknown, not zero' };
  const request = async (dimensions) => {
    const rows = [];
    let exhausted = false;
    while (rows.length < maxRows) {
      const limit = Math.min(rowLimit, maxRows - rows.length);
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: window.start, endDate: window.end, type: 'web', dataState: 'final',
          aggregationType: 'byPage', dimensions, startRow: rows.length, rowLimit: limit,
          dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl.href }] }] }),
      }, 2, 30000);
      if (!response.ok) throw new Error(`GSC API request failed (${response.status})`);
      const batch = (await response.json()).rows || [];
      rows.push(...batch);
      if (batch.length < limit) { exhausted = true; break; }
    }
    return { rows: rows.map((row) => ({
      ...Object.fromEntries(dimensions.map((name, i) => [name, row.keys[i]])),
      clicks: Number(row.clicks), impressions: Number(row.impressions), position: Number(row.position),
      ctr: row.impressions ? Number(row.clicks) / Number(row.impressions) : null,
    })), truncated: !exhausted };
  };
  const queries = await request(['page', 'query', 'country', 'device']);
  const totals = await request(['page', 'country', 'device']);
  const queryTotals = aggregatePerformance(queries.rows);
  const pageTotals = aggregatePerformance(totals.rows);
  return { page: pageUrl.pathname, pageUrl: pageUrl.href, window, source: 'Google Search Console Search Analytics',
    timezone: 'America/Los_Angeles', searchType: 'web', dataState: 'final', settlement,
    rows: queries.rows, totals: totals.rows, queryTotals, pageTotals,
    coverage: { returnedQueryRows: queries.rows.length, queryRowsTruncated: queries.truncated,
      totalsTruncated: totals.truncated, clientRowCap: maxRows,
      queryImpressionFraction: pageTotals.impressions ? queryTotals.impressions / pageTotals.impressions : null,
      queryClickFraction: pageTotals.clicks ? queryTotals.clicks / pageTotals.clicks : null,
      completeQueryCoverage: false,
      note: 'Query rows omit anonymized queries and may omit rows due to Search Console internal limits. Pagination exhaustion is not proof of complete coverage; totals exclude the query dimension.' },
  };
}

export function comparePageWindows(before, after) {
  if (!before.settlement?.complete || !after.settlement?.complete) {
    return { status: 'awaiting-final-data', beforeSettlement: before.settlement, afterSettlement: after.settlement };
  }
  if (before.pageUrl !== after.pageUrl || daysInWindow(before.window) !== daysInWindow(after.window)
      || before.window.end >= after.window.start || before.searchType !== after.searchType
      || before.timezone !== after.timezone || before.dataState !== after.dataState
      || before.coverage.queryRowsTruncated || after.coverage.queryRowsTruncated
      || before.coverage.totalsTruncated || after.coverage.totalsTruncated) {
    return { status: 'not-comparable', reason: 'Different scope, unequal/overlapping windows or client-truncated export' };
  }
  const joinRows = (left, right, dimensions) => {
    const key = (row) => JSON.stringify(dimensions.map((name) => row[name]));
    const beforeMap = new Map(left.map((row) => [key(row), row]));
    const afterMap = new Map(right.map((row) => [key(row), row]));
    return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].map((id) => {
      const a = beforeMap.get(id), b = afterMap.get(id);
      return { ...Object.fromEntries(dimensions.map((name) => [name, (a || b)[name]])),
        membership: a && b ? 'matched' : a ? 'baseline-only' : 'after-only', before: a || null, after: b || null,
        delta: a && b ? { clicks: b.clicks - a.clicks, impressions: b.impressions - a.impressions,
          ctrPercentagePoints: a.ctr != null && b.ctr != null ? (b.ctr - a.ctr) * 100 : null,
          position: a.impressions && b.impressions ? b.position - a.position : null } : null };
    });
  };
  return { status: 'observational-comparison',
    note: 'Changes are observational, not a causal estimate of the snippet. Missing query rows are unknown, never zero; compare the same country/device and consider impression mix and coverage.',
    strata: joinRows(before.totals, after.totals, ['page', 'country', 'device']),
    queries: joinRows(before.rows, after.rows, ['page', 'query', 'country', 'device']),
    beforeCoverage: before.coverage, afterCoverage: after.coverage };
}

function writeExport(outDir, name, report) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.rows) return;
  const byQuery = new Map();
  for (const row of report.rows) byQuery.set(row.query, [...(byQuery.get(row.query) || []), row]);
  const nearWin = new Set(buildNearWinQueries([...byQuery].map(([query, rows]) => ({ query, ...aggregatePerformance(rows) }))).map((row) => row.query));
  writeFileSync(join(outDir, `${name}.csv`), [
    'page,query,country,device,clicks,impressions,ctrPercent,position,nearWin',
    ...report.rows.map((row) => [row.page, row.query, row.country, row.device, row.clicks, row.impressions,
      row.ctr == null ? '' : row.ctr * 100, row.position, nearWin.has(row.query)].map(toCsvValue).join(',')),
  ].join('\n') + '\n');
}

export async function main() {
  const monitor = process.argv.includes('--top50-monitor');
  const pageArg = argFlag('page', null);
  if (!pageArg && !monitor) throw new Error('Missing --page=<canonical path> or --top50-monitor');
  const now = new Date();
  const outDir = argFlag('out', 'data/gsc-content-refresh');
  const rowLimit = Number(argFlag('row-limit', String(DEFAULT_ROW_LIMIT)));
  const token = await getToken();
  if (monitor) {
    const windows = monitoringWindows(process.env.GSC_TOP50_DEPLOYED_AT, now);
    const report = { ...windows, exportedAt: now.toISOString(), deployedAt: process.env.GSC_TOP50_DEPLOYED_AT || null,
      monitorBuild: process.env.GITHUB_SHA || null, pages: [] };
    for (const page of TOP50_SNIPPET_PAGES) {
      if (windows.baseline.end > windows.settledThrough) {
        report.pages.push({ page, status: 'awaiting-settled-baseline' });
        continue;
      }
      const before = await exportPage({ page, window: windows.baseline, token, rowLimit });
      writeExport(outDir, `${slugForPage(page)}-baseline`, before);
      const after = windows.status === 'ready' ? await exportPage({ page, window: windows.after, token, rowLimit }) : null;
      if (after) writeExport(outDir, `${slugForPage(page)}-after`, after);
      if (!before.settlement.complete || (after && !after.settlement.complete)) report.status = 'awaiting-final-data';
      report.pages.push({ page, baseline: before.pageTotals, baselineCoverage: before.coverage, baselineSettlement: before.settlement,
        comparison: after ? comparePageWindows(before, after) : null });
    }
    writeExport(outDir, 'top50-snippet-monitor', report);
    console.log(`GSC top50 monitor: ${report.status}; ${outDir}/top50-snippet-monitor.json`);
    return report;
  }
  const days = Number(argFlag('days', '90'));
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  const end = shiftDay(gscDay(now), -2);
  const report = await exportPage({ page: pageArg, window: { start: shiftDay(end, -(days - 1)), end }, token, rowLimit });
  report.exportedAt = now.toISOString();
  writeExport(outDir, slugForPage(report.page), report);
  console.log(`GSC query × country × device export: ${report.rows.length} rows for ${report.page}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`gsc-page-query-export failed: ${error.message}`); process.exitCode = 1; });
}
