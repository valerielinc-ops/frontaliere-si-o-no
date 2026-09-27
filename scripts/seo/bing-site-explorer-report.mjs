#!/usr/bin/env node

/** Aggregate deterministic full-tree crawler reports into a backlog report. */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRAWLER_SCHEMA_VERSION } from './bing-site-explorer-crawl.mjs';

const ACTIONABLE_CODES = new Set([
  'fetch-error', 'http-error', 'redirect', 'noindex-in-sitemap',
  'canonical-missing', 'canonical-drift', 'soft-404',
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const equal = item.indexOf('=');
    if (equal >= 0) args[item.slice(2, equal)] = item.slice(equal + 1);
    else args[item.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function arg(args, name, fallback) {
  return args[name] === undefined || args[name] === true ? fallback : String(args[name]);
}

function increment(map, key, amount = 1) { map[key] = (map[key] || 0) + amount; }

function mergeCounters(target, source) {
  for (const [key, value] of Object.entries(source || {})) increment(target, key, Number(value) || 0);
}

function ensureParent(filePath) { mkdirSync(dirname(resolve(filePath)), { recursive: true }); }

function writeJson(filePath, value) {
  ensureParent(filePath);
  writeFileSync(resolve(filePath), `${JSON.stringify(value, null, 2)}\n`);
}

function readReports(reportsDir) {
  return readdirSync(resolve(reportsDir))
    .filter((name) => /^partition-\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(reportsDir, name), 'utf8')));
}

export function aggregateCrawlReports(reports, manifest = null) {
  const ordered = [...reports].sort((a, b) => Number(a.partition) - Number(b.partition));
  const first = ordered[0] || {};
  const expectedPartitions = Number(first.partitions || 0);
  const coverageErrors = [];
  for (const error of manifest?.errors || []) {
    coverageErrors.push(`sitemap non letto: ${error.url || 'sconosciuto'} — ${error.error || 'errore sconosciuto'}`);
  }
  if (manifest && Number(manifest.sitemapCount || 0) === 0) {
    coverageErrors.push('nessun sitemap è stato letto dal manifest');
  }
  const seen = new Set();
  for (const report of ordered) {
    const id = Number(report.partition);
    if (seen.has(id)) coverageErrors.push(`partizione duplicata: ${id}`);
    seen.add(id);
  }
  for (let id = 0; id < expectedPartitions; id += 1) {
    if (!seen.has(id)) coverageErrors.push(`partizione mancante: ${id}`);
  }
  if (ordered.some((report) => Number(report.partitions) !== expectedPartitions)) {
    coverageErrors.push('i report usano numeri diversi di partizioni');
  }
  const manifestCount = Number(manifest?.manifestCount ?? first.manifestCount ?? 0);
  const checkedCount = ordered.reduce((sum, report) => sum + Number(report.checkedCount || 0), 0);
  const partitionTotal = ordered.reduce((sum, report) => sum + Number(report.partitionTotal || 0), 0);
  if (partitionTotal !== manifestCount) coverageErrors.push(`somma partizioni ${partitionTotal} diversa dal manifest ${manifestCount}`);
  if (checkedCount !== manifestCount) coverageErrors.push(`URL verificati ${checkedCount} diversi dal manifest ${manifestCount}`);

  const codeCounts = {};
  const statusCounts = {};
  const folderStats = {};
  const findingMap = new Map();
  const discovered = new Set();
  for (const report of ordered) {
    mergeCounters(codeCounts, report.codeCounts);
    mergeCounters(statusCounts, report.statusCounts);
    for (const [root, stats] of Object.entries(report.folderStats || {})) {
      const target = folderStats[root] || (folderStats[root] = { checked: 0, statuses: {}, findings: {} });
      target.checked += Number(stats.checked || 0);
      mergeCounters(target.statuses, stats.statuses);
      mergeCounters(target.findings, stats.findings);
    }
    for (const item of report.findings || []) findingMap.set(`${item.code}\u0000${item.url}`, item);
    for (const url of report.discoveredOutOfSitemap || []) discovered.add(url);
  }
  const findings = [...findingMap.values()].sort((a, b) => `${a.code}${a.url}`.localeCompare(`${b.code}${b.url}`));
  const actionableFindings = findings.filter((item) => ACTIONABLE_CODES.has(item.code));
  return {
    schemaVersion: CRAWLER_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    baseUrl: first.baseUrl || manifest?.baseUrl || '',
    sitemapCount: Number(manifest?.sitemapCount || 0),
    manifestCount,
    checkedCount,
    partitionTotal,
    expectedPartitions,
    coverageOk: coverageErrors.length === 0,
    coverageErrors,
    statusCounts,
    codeCounts,
    folderStats,
    findings,
    actionableFindings,
    actionableCount: actionableFindings.length,
    discoveredOutOfSitemap: [...discovered].sort(),
    discoveredOutOfSitemapCount: discovered.size,
  };
}

function formatUrlList(items, maxSamples) {
  return items.slice(0, maxSamples).map((item) => {
    const detail = item.detail ? ` — ${item.detail}` : '';
    return `- \`${item.url}\`${detail}`;
  }).join('\n');
}

function buildIssueBody(summary, { maxSamples = 80, artifactUrl = '' } = {}) {
  const lines = [
    '## Bing-compatible full-tree crawl',
    '',
    'Il crawler enumera il grafo completo dei sitemap pubblicati e verifica ogni URL in partizioni deterministiche. Le categorie sono candidati HTTP/SEO riproducibili: Bing Site Explorer non espone questi contatori tramite una REST API pubblica stabile, quindi il workflow non finge di leggere i bucket privati `Indexed/Warning/Excluded`.',
    '',
    `- Manifest: **${summary.manifestCount} URL** in **${summary.sitemapCount} sitemap**`,
    `- Copertura: **${summary.checkedCount}/${summary.manifestCount}** URL, ${summary.coverageOk ? 'completa' : 'INCOMPLETA'}`,
    `- Finding azionabili: **${summary.actionableCount}**`,
    `- URL interne fuori sitemap (informative): **${summary.discoveredOutOfSitemapCount}**`,
    `- Verifica: ${summary.checkedAt}`,
  ];
  if (artifactUrl) lines.push(`- Report completi: [artifact del workflow](${artifactUrl})`);
  if (summary.coverageErrors.length > 0) {
    lines.push('', '### Copertura da riparare', '', ...summary.coverageErrors.map((error) => `- ${error}`));
  }
  lines.push('', '### Conteggio per codice', '');
  for (const [code, count] of Object.entries(summary.codeCounts).sort((a, b) => b[1] - a[1])) lines.push(`- \`${code}\`: **${count}**`);
  const byCode = new Map();
  for (const item of summary.findings) {
    const items = byCode.get(item.code) || [];
    items.push(item);
    byCode.set(item.code, items);
  }
  for (const [code, items] of byCode) {
    lines.push('', `### ${code} (${items.length})`, '', formatUrlList(items, maxSamples));
    if (items.length > maxSamples) lines.push(`\n_...altre ${items.length - maxSamples}; il JSON dell'artifact contiene l'elenco completo._`);
  }
  lines.push('', '### Root del sito', '', '| Root | URL | 4xx/5xx | Finding |', '|---|---:|---:|---:|');
  for (const [root, stats] of Object.entries(summary.folderStats).sort((a, b) => b[1].checked - a[1].checked)) {
    const errors = Object.entries(stats.statuses).filter(([status]) => Number(status) >= 400 || Number(status) === 0).reduce((total, [, count]) => total + count, 0);
    const findings = Object.values(stats.findings).reduce((total, count) => total + count, 0);
    lines.push(`| \`${root}\` | ${stats.checked} | ${errors} | ${findings} |`);
  }
  if (summary.discoveredOutOfSitemap.length > 0) {
    lines.push('', '### Link interni non presenti nel manifest (informativi)', '', ...summary.discoveredOutOfSitemap.slice(0, maxSamples).map((url) => `- \`${url}\``));
    if (summary.discoveredOutOfSitemap.length > maxSamples) lines.push(`\n_...altre ${summary.discoveredOutOfSitemap.length - maxSamples}; verificare se sono route private, dinamiche o da aggiungere al sitemap._`);
  }
  lines.push('', '### Regola di chiusura', '', 'Correggere gli URL azionabili oppure dichiararne il ritiro con 301/410 e rimuoverli dal sitemap. Il prossimo run deve riportare copertura completa e zero finding azionabili; i link interni fuori sitemap restano da valutare per root, privacy e route dinamiche.');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportsDir = arg(args, 'reports-dir', 'bing-site-tree-reports');
  const output = arg(args, 'out', 'bing-site-tree-summary.json');
  const issueBodyPath = arg(args, 'issue-body', '');
  const manifestPath = arg(args, 'manifest', '');
  const reports = readReports(reportsDir);
  const manifest = manifestPath ? JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) : null;
  const summary = aggregateCrawlReports(reports, manifest);
  writeJson(output, summary);
  if (issueBodyPath && (summary.actionableCount > 0 || !summary.coverageOk)) {
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const runId = process.env.GITHUB_RUN_ID || '';
    const artifactUrl = repo && runId ? `${server}/${repo}/actions/runs/${runId}` : '';
    ensureParent(issueBodyPath);
    writeFileSync(resolve(issueBodyPath), `${buildIssueBody(summary, { artifactUrl })}\n`);
  }
  console.log(JSON.stringify({
    manifestCount: summary.manifestCount,
    checkedCount: summary.checkedCount,
    coverageOk: summary.coverageOk,
    actionableCount: summary.actionableCount,
    discoveredOutOfSitemapCount: summary.discoveredOutOfSitemapCount,
    out: output,
  }, null, 2));
  if (!summary.coverageOk || summary.actionableCount > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { await main(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
