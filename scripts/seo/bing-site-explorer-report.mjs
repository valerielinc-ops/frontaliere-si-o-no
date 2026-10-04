#!/usr/bin/env node

/** Aggregate deterministic full-tree crawler reports into a backlog report. */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CRAWLER_SCHEMA_VERSION,
  DEFAULT_MAX_BODY_BYTES,
  classifyDiscoveredUrl,
  folderFor,
  probeWithRetries,
  writeJsonStreaming,
} from './bing-site-explorer-crawl.mjs';
import { buildTemplateInventory } from './bing-template-inventory.mjs';

// Re-exported so callers of the report module keep a single import.
export { writeJsonStreaming };

const ACTIONABLE_CODES = new Set([
  'fetch-error', 'http-error', 'redirect', 'noindex-in-sitemap',
  'canonical-missing', 'canonical-drift', 'soft-404', 'title-missing',
  'title-too-long', 'meta-description-missing', 'meta-description-too-short',
  'internal-link-malformed',
]);

// The report job has a 15-minute Actions timeout. Leave room for artifact
// downloads, summary serialization and issue mutation after the rescue pass.
export const DEFAULT_RESCUE_DEADLINE_MS = 8 * 60 * 1_000;

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

function decrement(map, key, amount = 1) {
  const next = (Number(map[key]) || 0) - amount;
  if (next > 0) map[key] = next;
  else delete map[key];
}

function isTransientStatus(status) {
  const code = Number(status) || 0;
  return code === 0 || code === 429 || code >= 500;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function mergeCounters(target, source) {
  for (const [key, value] of Object.entries(source || {})) increment(target, key, Number(value) || 0);
}

function ensureParent(filePath) { mkdirSync(dirname(resolve(filePath)), { recursive: true }); }

export function readPartitionReports(reportsDir, prefix = 'partition-') {
  return readdirSync(resolve(reportsDir))
    .filter((name) => name.startsWith(prefix) && /^\d+\.json$/.test(name.slice(prefix.length)))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(reportsDir, name), 'utf8')));
}

function applyRescueResult(report, url, result, manifestSet) {
  const oldFindings = (report.findings || []).filter((item) => item.url === url);
  if (oldFindings.length === 0) return;
  const root = oldFindings[0].root || folderFor(url);
  const stats = report.folderStats[root] || (report.folderStats[root] = { checked: 0, statuses: {}, findings: {} });
  const oldStatus = String(oldFindings[0].status ?? 0);
  decrement(report.statusCounts, oldStatus);
  decrement(stats.statuses, oldStatus);
  for (const item of oldFindings) {
    decrement(report.codeCounts, item.code);
    decrement(stats.findings, item.code);
  }
  report.findings = (report.findings || []).filter((item) => item.url !== url);

  const nextStatus = String(result.status);
  increment(report.statusCounts, nextStatus);
  increment(stats.statuses, nextStatus);
  const nextFindings = (result.findings || []).map((item) => ({
    ...item,
    root,
    status: result.status,
  }));
  for (const item of nextFindings) {
    increment(report.codeCounts, item.code);
    increment(stats.findings, item.code);
  }
  report.findings.push(...nextFindings);

  const discovered = new Set(report.discoveredOutOfSitemap || []);
  for (const link of result.links || []) if (!manifestSet.has(link)) discovered.add(link);
  report.discoveredOutOfSitemap = [...discovered].sort();
}

/**
 * Recheck transient findings only after every partition has drained.
 *
 * The partition-local rescue avoids most edge bursts, but 24 matrix jobs can
 * still rescue at the same time. This final pass is globally serialized and
 * therefore measures the edge after the full crawl has gone quiet.
 */
export async function rescueTransientReports(reports, manifest, {
  fetchImpl = globalThis.fetch,
  concurrency = 1,
  retries = 4,
  delayMs = 3_000,
  timeoutMs = 30_000,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxUrls = 500,
  deadlineMs = DEFAULT_RESCUE_DEADLINE_MS,
} = {}) {
  const urls = [...new Set(reports.flatMap((report) => (report.findings || [])
    .filter((item) => isTransientStatus(item.status))
    .map((item) => item.url)).filter(Boolean))].sort();
  const limit = Math.max(0, Number(maxUrls) || 0);
  const queued = limit > 0 ? urls.slice(0, limit) : [];
  const skipped = Math.max(0, urls.length - queued.length);
  if (queued.length === 0) return { attempted: 0, rescued: 0, remaining: skipped, skipped, deadlineSkipped: 0 };
  const numericDeadlineMs = Number(deadlineMs);
  const deadlineAt = Number.isFinite(numericDeadlineMs)
    ? Date.now() + Math.max(0, numericDeadlineMs)
    : Number.POSITIVE_INFINITY;
  const initialDelayMs = Math.max(0, Number(delayMs) || 0);
  if (initialDelayMs > 0) {
    const waitMs = Math.min(initialDelayMs, Math.max(0, deadlineAt - Date.now()));
    if (waitMs > 0) await sleep(waitMs);
  }

  const manifestSet = new Set(manifest?.urls || []);
  const outcomes = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= queued.length || Date.now() >= deadlineAt) return;
      const url = queued[index];
      const result = await probeWithRetries(url, {
        fetchImpl,
        retries,
        timeoutMs,
        maxBodyBytes,
        deadlineAt,
      });
      outcomes.push({ url, result });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), queued.length) }, worker));

  for (const { url, result } of outcomes) {
    const report = reports.find((item) => (item.findings || []).some((finding) => finding.url === url));
    if (report) applyRescueResult(report, url, result, manifestSet);
  }
  const deadlineSkipped = Math.max(0, queued.length - outcomes.length);
  const transientRemaining = outcomes.filter(({ result }) => isTransientStatus(result.status)).length;
  const remaining = transientRemaining + skipped + deadlineSkipped;
  return {
    attempted: outcomes.length,
    rescued: outcomes.length - transientRemaining,
    remaining,
    skipped,
    deadlineSkipped,
  };
}

function validateScope(name, reports, manifest, coverageErrors) {
  const ordered = [...(reports || [])].sort((a, b) => Number(a.partition) - Number(b.partition));
  const first = ordered[0] || {};
  const expectedPartitions = Number(first.partitions || 0);
  const manifestCount = Number(manifest?.manifestCount ?? first.manifestCount ?? 0);
  for (const error of manifest?.errors || []) {
    const source = name === 'sitemap' ? 'sitemap' : 'frontiera interna';
    coverageErrors.push(`${name}: ${source} non letto: ${error.url || 'sconosciuto'} — ${error.error || 'errore sconosciuto'}`);
  }
  if (name === 'sitemap' && manifest && Number(manifest.sitemapCount || 0) === 0) {
    coverageErrors.push('sitemap: nessun sitemap è stato letto dal manifest');
  }
  if (ordered.length === 0 && manifestCount > 0) {
    coverageErrors.push(`${name}: nessun report di partizione ricevuto`);
  }
  const seen = new Set();
  for (const report of ordered) {
    const id = Number(report.partition);
    if (seen.has(id)) coverageErrors.push(`${name}: partizione duplicata: ${id}`);
    seen.add(id);
  }
  for (let id = 0; id < expectedPartitions; id += 1) {
    if (!seen.has(id)) coverageErrors.push(`${name}: partizione mancante: ${id}`);
  }
  if (ordered.some((report) => Number(report.partitions) !== expectedPartitions)) {
    coverageErrors.push(`${name}: i report usano numeri diversi di partizioni`);
  }
  const checkedCount = ordered.reduce((sum, report) => sum + Number(report.checkedCount || 0), 0);
  const partitionTotal = ordered.reduce((sum, report) => sum + Number(report.partitionTotal || 0), 0);
  if (partitionTotal !== manifestCount) coverageErrors.push(`${name}: somma partizioni ${partitionTotal} diversa dal manifest ${manifestCount}`);
  if (checkedCount !== manifestCount) coverageErrors.push(`${name}: URL verificati ${checkedCount} diversi dal manifest ${manifestCount}`);
  return { name, reports: ordered, manifest, first, expectedPartitions, manifestCount, checkedCount, partitionTotal };
}

export function aggregateCrawlReports(reports, manifest = null, options = {}) {
  const coverageErrors = [];
  for (const error of options.supplementalCoverageErrors || []) {
    if (String(error || '').trim()) coverageErrors.push(String(error).trim());
  }
  // Keep validation scoped so a missing closure artifact cannot hide complete
  // sitemap coverage, and vice versa.
  const scopes = [validateScope('sitemap', reports, manifest, coverageErrors)];
  if (options.supplementalManifest || (options.supplementalReports || []).length > 0) {
    scopes.push(validateScope(
      'frontiera interna',
      options.supplementalReports || [],
      options.supplementalManifest || null,
      coverageErrors,
    ));
  }

  const primary = scopes[0];
  const manifestCount = scopes.reduce((sum, scope) => sum + scope.manifestCount, 0);
  const checkedCount = scopes.reduce((sum, scope) => sum + scope.checkedCount, 0);
  const partitionTotal = scopes.reduce((sum, scope) => sum + scope.partitionTotal, 0);
  const codeCounts = {};
  const statusCounts = {};
  const folderStats = {};
  const findingMap = new Map();
  const discovered = new Set();
  const verified = new Set();
  const excludedDiscoveryCounts = {};
  const excludedDiscoverySamples = {};
  for (const scope of scopes) {
    for (const url of scope.manifest?.urls || []) verified.add(url);
    for (const [reason, count] of Object.entries(scope.manifest?.excludedByReason || {})) {
      increment(excludedDiscoveryCounts, reason, Number(count) || 0);
    }
    for (const [reason, urls] of Object.entries(scope.manifest?.excludedSamplesByReason || {})) {
      const samples = excludedDiscoverySamples[reason] || (excludedDiscoverySamples[reason] = []);
      for (const url of urls || []) {
        if (samples.length >= 10) break;
        if (!samples.includes(url)) samples.push(url);
      }
    }
    for (const item of scope.manifest?.findings || []) {
      findingMap.set(`${item.code}\u0000${item.url}`, item);
      increment(codeCounts, item.code);
      const root = item.root || folderFor(item.url);
      const target = folderStats[root] || (folderStats[root] = { checked: 0, statuses: {}, findings: {} });
      increment(target.findings, item.code);
    }
    for (const report of scope.reports) {
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
  }
  const baseUrl = primary.first.baseUrl || manifest?.baseUrl || '';
  const unverified = [];
  const unverifiedByReason = {};
  for (const url of discovered) {
    if (verified.has(url)) continue;
    const reason = classifyDiscoveredUrl(url, baseUrl).reason;
    increment(unverifiedByReason, reason);
    if (reason === 'crawl') unverified.push(url);
  }
  const findings = [...findingMap.values()].sort((a, b) => `${a.code}${a.url}`.localeCompare(`${b.code}${b.url}`));
  const actionableFindings = findings.filter((item) => ACTIONABLE_CODES.has(item.code));
  const templateInventory = buildTemplateInventory(actionableFindings);
  return {
    schemaVersion: CRAWLER_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    baseUrl,
    sitemapCount: Number(manifest?.sitemapCount || 0),
    manifestCount,
    sitemapManifestCount: primary.manifestCount,
    supplementalManifestCount: manifestCount - primary.manifestCount,
    checkedCount,
    partitionTotal,
    expectedPartitions: primary.expectedPartitions,
    scopes: scopes.map(({ name, manifest: scopeManifest, manifestCount: count, checkedCount: checked, partitionTotal: total, expectedPartitions: expected }) => ({
      name,
      kind: scopeManifest?.kind || (name === 'sitemap' ? 'sitemap' : 'discovered-frontier'),
      manifestCount: count,
      checkedCount: checked,
      partitionTotal: total,
      expectedPartitions: expected,
    })),
    coverageOk: coverageErrors.length === 0,
    coverageErrors,
    statusCounts,
    codeCounts,
    folderStats,
    findings,
    actionableFindings,
    actionableCount: actionableFindings.length,
    templateInventory,
    discoveredOutOfSitemap: [...discovered].sort(),
    discoveredOutOfSitemapCount: discovered.size,
    unverifiedOutOfSitemap: unverified.sort(),
    unverifiedOutOfSitemapCount: unverified.length,
    unverifiedOutOfSitemapByReason: unverifiedByReason,
    excludedDiscoveryCounts,
    excludedDiscoverySamples,
  };
}

function formatUrlList(items, maxSamples) {
  return items.slice(0, maxSamples).map((item) => {
    const detail = item.detail ? ` — ${item.detail}` : '';
    return `- \`${item.url}\`${detail}`;
  }).join('\n');
}

export function buildIssueBody(summary, { maxSamples = 80, artifactUrl = '' } = {}) {
  const lines = [
    '## Bing-compatible full-tree crawl',
    '',
    'Il crawler enumera il grafo completo dei sitemap pubblicati e una seconda frontiera di route HTML raggiunte dai link interni, verificando ogni URL in partizioni deterministiche. Query di calcolatori/filtri, asset e token di editor non vengono espansi: restano nel registro delle esclusioni per evitare un crawl infinito di URL dinamiche. Le categorie sono candidati HTTP/SEO riproducibili: Bing Site Explorer non espone questi contatori tramite una REST API pubblica stabile, quindi il workflow non finge di leggere i bucket privati `Indexed/Warning/Excluded`.',
    '',
    `- Manifest sitemap: **${summary.sitemapManifestCount ?? summary.manifestCount} URL** in **${summary.sitemapCount} sitemap**`,
    `- Frontiera interna crawlable: **${summary.supplementalManifestCount || 0} URL**`,
    `- Copertura totale: **${summary.checkedCount}/${summary.manifestCount}** URL, ${summary.coverageOk ? 'completa' : 'INCOMPLETA'}`,
    `- Finding azionabili: **${summary.actionableCount}**`,
    `- URL interne fuori sitemap osservate: **${summary.discoveredOutOfSitemapCount}**`,
    `- Route HTML ancora non verificate: **${summary.unverifiedOutOfSitemapCount || 0}**`,
    `- Verifica: ${summary.checkedAt}`,
  ];
  if (artifactUrl) lines.push(`- Report completi: [artifact del workflow](${artifactUrl})`);
  if (summary.coverageErrors.length > 0) {
    lines.push('', '### Copertura da riparare', '', ...summary.coverageErrors.map((error) => `- ${error}`));
  }
  lines.push('', '### Conteggio per codice', '');
  for (const [code, count] of Object.entries(summary.codeCounts)
    .filter(([code]) => ACTIONABLE_CODES.has(code))
    .sort((a, b) => b[1] - a[1])) lines.push(`- \`${code}\`: **${count}**`);
  const templateInventory = summary.templateInventory;
  if (templateInventory?.findingCount > 0) {
    lines.push(
      '',
      '### Inventario template per title/meta',
      '',
      `- Finding title/meta censiti: **${templateInventory.findingCount}**`,
      `- Attribuiti a un emitter: **${templateInventory.classifiedFindings}**`,
      `- Non classificati o ambigui: **${templateInventory.unclassifiedFindings}**`,
      '',
      '| Template | Emitter | URL | `title-too-long` | `meta-description-too-short` |',
      '|---|---|---:|---:|---:|',
    );
    for (const family of templateInventory.families) {
      const source = family.sourcePaths.length > 0 ? family.sourcePaths.map((path) => `\`${path}\``).join('<br>') : '—';
      lines.push(`| **${family.label}** (\`${family.id}\`) | ${source} | ${family.urlCount} | ${family.codeCounts['title-too-long'] || 0} | ${family.codeCounts['meta-description-too-short'] || 0} |`);
      for (const code of ['title-too-long', 'meta-description-too-short']) {
        const samples = family.samples?.[code] || [];
        if (samples.length > 0) lines.push(`  - \`${code}\` campioni: ${samples.map((url) => `\`${url}\``).join(', ')}`);
      }
    }
  }
  const byCode = new Map();
  for (const item of summary.actionableFindings) {
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
    const findings = Object.entries(stats.findings)
      .filter(([code]) => ACTIONABLE_CODES.has(code))
      .reduce((total, [, count]) => total + count, 0);
    lines.push(`| \`${root}\` | ${stats.checked} | ${errors} | ${findings} |`);
  }
  if (Object.keys(summary.excludedDiscoveryCounts || {}).length > 0) {
    lines.push('', '### Link interni esclusi dalla frontiera HTML', '');
    for (const [reason, count] of Object.entries(summary.excludedDiscoveryCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${reason}\`: **${count}**`);
      for (const url of summary.excludedDiscoverySamples?.[reason] || []) lines.push(`  - \`${url}\``);
    }
  }
  if (Object.keys(summary.unverifiedOutOfSitemapByReason || {}).length > 0) {
    lines.push('', '### Link interni non ancora verificati', '');
    for (const [reason, count] of Object.entries(summary.unverifiedOutOfSitemapByReason).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${reason}\`: **${count}**`);
    }
  }
  if (summary.discoveredOutOfSitemap.length > 0) {
    lines.push('', '### Link interni non presenti nel manifest (campione)', '', ...summary.discoveredOutOfSitemap.slice(0, maxSamples).map((url) => `- \`${url}\``));
    if (summary.discoveredOutOfSitemap.length > maxSamples) lines.push(`\n_...altri ${summary.discoveredOutOfSitemap.length - maxSamples}; il JSON dell\'artifact contiene l\'elenco completo e la classificazione della frontiera._`);
  }
  lines.push('', '### Regola di chiusura', '', 'Le pagine storiche non si cancellano: ogni URL storico deve restare raggiungibile con HTTP 200 e contenuto utile, self-canonical se è l\'archivio della pagina oppure full-content bridge verso il successore esatto quando esiste. Si corregge il sitemap rimuovendo solo URL non self-canonical, noindex o non serviti; questa riconciliazione modifica esclusivamente gli XML e non elimina file HTML. 301/410 sono ammessi soltanto per URL tecnici realmente non-pagina, con decisione esplicita. Il prossimo run deve riportare copertura completa e zero finding azionabili; le sole URL escluse dalla frontiera devono essere dinamiche/non-HTML o token malformati esplicitamente classificati.');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportsDir = arg(args, 'reports-dir', 'bing-site-tree-reports');
  const output = arg(args, 'out', 'bing-site-tree-summary.json');
  const issueBodyPath = arg(args, 'issue-body', '');
  const manifestPath = arg(args, 'manifest', '');
  const supplementalReportsDir = arg(args, 'supplemental-reports-dir', '');
  const supplementalManifestPath = arg(args, 'supplemental-manifest', '');
  const reports = readPartitionReports(reportsDir);
  const manifest = manifestPath ? JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) : null;
  const supplementalReports = supplementalReportsDir
    ? readPartitionReports(supplementalReportsDir, 'frontier-partition-')
    : [];
  const supplementalManifest = supplementalManifestPath
    ? JSON.parse(readFileSync(resolve(supplementalManifestPath), 'utf8'))
    : null;
  const supplementalCoverageError = arg(args, 'supplemental-coverage-error', '');
  let transientRescue = null;
  if (args['rescue-transients'] === true || args['rescue-transients'] === 'true') {
    const rescueOptions = {
      concurrency: Number(arg(args, 'rescue-concurrency', '1')),
      retries: Number(arg(args, 'rescue-retries', '4')),
      delayMs: Number(arg(args, 'rescue-delay-ms', '3000')),
      deadlineMs: Number(arg(args, 'rescue-deadline-ms', String(DEFAULT_RESCUE_DEADLINE_MS))),
      timeoutMs: Number(arg(args, 'timeout-ms', '30000')),
      maxUrls: Number(arg(args, 'rescue-max-urls', '500')),
    };
    const sitemapRescue = await rescueTransientReports(reports, manifest, rescueOptions);
    const frontierRescue = supplementalReports.length > 0
      ? await rescueTransientReports(supplementalReports, supplementalManifest, rescueOptions)
      : null;
    transientRescue = frontierRescue ? { sitemap: sitemapRescue, frontier: frontierRescue } : sitemapRescue;
  }
  const summary = aggregateCrawlReports(reports, manifest, {
    supplementalReports,
    supplementalManifest,
    supplementalCoverageErrors: supplementalCoverageError ? [supplementalCoverageError] : [],
  });
  if (transientRescue) summary.transientRescue = transientRescue;
  // The issue body is the small, human-facing output: write it before the
  // large summary so a failure while serializing the artifact JSON can never
  // leave the backlog issue without a description.
  if (issueBodyPath && (summary.actionableCount > 0 || !summary.coverageOk)) {
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const runId = process.env.GITHUB_RUN_ID || '';
    const artifactUrl = repo && runId ? `${server}/${repo}/actions/runs/${runId}` : '';
    ensureParent(issueBodyPath);
    writeFileSync(resolve(issueBodyPath), `${buildIssueBody(summary, { artifactUrl })}\n`);
  }
  writeJsonStreaming(output, summary);
  console.log(JSON.stringify({
    manifestCount: summary.manifestCount,
    checkedCount: summary.checkedCount,
    coverageOk: summary.coverageOk,
    actionableCount: summary.actionableCount,
    templateFamilyCount: summary.templateInventory?.families?.length || 0,
    unclassifiedTemplateFindingCount: summary.templateInventory?.unclassifiedFindings || 0,
    discoveredOutOfSitemapCount: summary.discoveredOutOfSitemapCount,
    supplementalManifestCount: summary.supplementalManifestCount,
    unverifiedOutOfSitemapCount: summary.unverifiedOutOfSitemapCount,
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
