#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  PAGE_KINDS,
  verifyRuntimeInputExclusion,
} from '../../build-plugins/shared/incrementalManifest.mjs';

// Added after the first manifest format was deployed. Treat the missing field
// as zero so the first report after this change can compare an old snapshot
// with a new one; newly written manifests still always serialize the key.
const LEGACY_OPTIONAL_KINDS = new Set(['related-search-sitemap']);

function parseArgs(argv) {
  const positional = [];
  const args = { limit: 50 };
  for (const arg of argv) {
    if (arg.startsWith('--previous=')) args.previous = arg.slice('--previous='.length);
    else if (arg.startsWith('--current=')) args.current = arg.slice('--current='.length);
    else if (arg.startsWith('--limit=')) args.limit = Math.max(1, Number(arg.slice('--limit='.length)) || 50);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else positional.push(arg);
  }
  args.previous ??= positional[0];
  args.current ??= positional[1];
  return args;
}

function usage() {
  return [
    'Uso: node scripts/ci/incremental-manifest-report.mjs <precedente.jsonl> <corrente.jsonl>',
    '     node scripts/ci/incremental-manifest-report.mjs --previous=... --current=... [--limit=50]',
  ].join('\n');
}

function parseJsonLine(file, lineNumber, line) {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('record deve essere un oggetto');
    }
    return record;
  } catch (error) {
    throw new Error(`${file}:${lineNumber}: JSONL non valido (${error?.message || error})`);
  }
}

function assertManifestCounts(file, counts, entries) {
  if (!counts || !Number.isInteger(counts.total) || !counts.byKind || typeof counts.byKind !== 'object') {
    throw new Error(`${file}: footer counts non valido`);
  }
  if (counts.total !== entries.size) {
    throw new Error(`${file}: footer total=${counts.total}, osservate ${entries.size} entry`);
  }
  const byKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, 0]));
  for (const entry of entries.values()) byKind[entry.kind] += 1;
  for (const kind of PAGE_KINDS) {
    const declared = counts.byKind[kind];
    if (declared === undefined && LEGACY_OPTIONAL_KINDS.has(kind)) continue;
    if (declared !== byKind[kind]) {
      throw new Error(`${file}: footer byKind.${kind}=${counts.byKind[kind]}, osservate ${byKind[kind]}`);
    }
  }
}

export async function loadManifest(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let footer = null;
  let currentKind = null;
  let sawFooter = false;
  let lineNumber = 0;
  const kinds = new Map();
  const entries = new Map();

  try {
    for await (const rawLine of reader) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      const record = parseJsonLine(file, lineNumber, line);
      if (sawFooter) throw new Error(`${file}:${lineNumber}: record dopo il footer`);

      if (record.type === 'header') {
        if (header) throw new Error(`${file}:${lineNumber}: header duplicato`);
        if (
          record.manifestVersion !== MANIFEST_VERSION
          || record.format !== MANIFEST_FORMAT
          || typeof record.locale !== 'string'
        ) {
          throw new Error(`${file}:${lineNumber}: header manifest non valido`);
        }
        header = record;
        continue;
      }
      if (!header) throw new Error(`${file}:${lineNumber}: header mancante`);

      if (record.type === 'kind') {
        if (!PAGE_KINDS.includes(record.kind)) {
          throw new Error(`${file}:${lineNumber}: kind non valido`);
        }
        if (kinds.has(record.kind)) {
          throw new Error(`${file}:${lineNumber}: kind duplicato ${record.kind}`);
        }
        for (const field of ['templateVersion', 'sourceVersion', 'state']) {
          if (typeof record[field] !== 'string' || record[field].length === 0) {
            throw new Error(`${file}:${lineNumber}: metadata ${field} non valida`);
          }
        }
        kinds.set(record.kind, {
          templateVersion: record.templateVersion,
          sourceVersion: record.sourceVersion,
          state: record.state,
        });
        currentKind = record.kind;
        continue;
      }

      if (record.type === 'footer') {
        assertManifestCounts(file, record.counts, entries);
        footer = record;
        sawFooter = true;
        continue;
      }

      if (record.type !== undefined) {
        throw new Error(`${file}:${lineNumber}: record type non valido`);
      }
      if (!currentKind) throw new Error(`${file}:${lineNumber}: entry senza kind`);
      if (typeof record.path !== 'string' || record.path.length === 0 || typeof record.hash !== 'string') {
        throw new Error(`${file}:${lineNumber}: entry non valida`);
      }
      if (entries.has(record.path)) throw new Error(`${file}:${lineNumber}: path duplicato ${record.path}`);
      entries.set(record.path, { path: record.path, inputHash: record.hash, kind: currentKind });
    }
  } finally {
    reader.close();
  }

  if (!header) throw new Error(`${file}: header mancante`);
  if (!footer) throw new Error(`${file}: footer mancante`);
  assertManifestCounts(file, footer.counts, entries);
  return {
    file,
    data: {
      manifestVersion: header.manifestVersion,
      format: header.format,
      locale: header.locale,
      counts: footer.counts,
      kinds: Object.fromEntries(kinds),
    },
    entries,
  };
}

function emptyStats() {
  return { hits: 0, misses: 0, added: 0, removed: 0 };
}

function byKindStats() {
  return Object.fromEntries(PAGE_KINDS.map((kind) => [kind, emptyStats()]));
}

function pathList(label, paths, limit) {
  const sorted = [...paths].sort();
  const lines = [`${label} (${sorted.length}):`];
  for (const pagePath of sorted.slice(0, limit)) lines.push(`- ${pagePath}`);
  if (sorted.length > limit) lines.push(`- … altri ${sorted.length - limit}`);
  if (sorted.length === 0) lines.push('- Nessuno');
  return lines;
}

const RELATED_SITEMAP_SHARD_RE = /^sitemap-search-clusters(?:-\d+)?\.xml$/;

function relatedSitemapTombstoneCandidates(previous, current) {
  return [...previous.entries]
    .filter(([pagePath, entry]) =>
      entry.kind === 'related-search-sitemap'
      && RELATED_SITEMAP_SHARD_RE.test(pagePath)
      && !current.entries.has(pagePath),
    )
    .map(([pagePath]) => pagePath);
}

export function buildReport(previous, current, { limit = 50 } = {}) {
  verifyRuntimeInputExclusion();
  const stats = byKindStats();
  const added = [];
  const removed = [];
  const tombstoneCandidates = relatedSitemapTombstoneCandidates(previous, current);
  let totalHits = 0;
  let totalMisses = 0;

  for (const [pagePath, currentEntry] of current.entries) {
    const previousEntry = previous.entries.get(pagePath);
    const currentStats = stats[currentEntry.kind] || (stats[currentEntry.kind] = emptyStats());
    if (!previousEntry) {
      currentStats.added += 1;
      added.push(pagePath);
      continue;
    }
    if (previousEntry.inputHash === currentEntry.inputHash) {
      currentStats.hits += 1;
      totalHits += 1;
    } else {
      currentStats.misses += 1;
      totalMisses += 1;
    }
  }

  for (const [pagePath, previousEntry] of previous.entries) {
    if (current.entries.has(pagePath)) continue;
    const previousStats = stats[previousEntry.kind] || (stats[previousEntry.kind] = emptyStats());
    previousStats.removed += 1;
    removed.push(pagePath);
  }

  const lines = [
    'Incremental manifest report',
    `Previous: ${previous.file}`,
    `Current: ${current.file}`,
    'Runtime fields esclusi dall’input: OK (ft-build-id, lastmod, date di generazione)',
    '',
    '| Kind | Hit | Miss | Aggiunti | Rimossi |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const kind of PAGE_KINDS) {
    const row = stats[kind];
    lines.push(`| ${kind} | ${row.hits} | ${row.misses} | ${row.added} | ${row.removed} |`);
  }
  lines.push(`| **totale** | **${totalHits}** | **${totalMisses}** | **${added.length}** | **${removed.length}** |`);
  lines.push('');
  lines.push('Collisioni (fingerprint per-entry omesso): non calcolate');
  lines.push('');
  lines.push(...pathList('Path aggiunti', added, limit));
  lines.push('');
  lines.push(...pathList('Path rimossi', removed, limit));
  lines.push('');
  lines.push(...pathList('Tombstone candidati (clearStaleClusterSitemaps)', tombstoneCandidates, limit));
  return `${lines.join('\n')}\n`;
}

export async function runReport(previousFile, currentFile, options) {
  const [previous, current] = await Promise.all([
    loadManifest(previousFile),
    loadManifest(currentFile),
  ]);
  return buildReport(previous, current, options);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.previous || !args.current) {
    console.error(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  try {
    process.stdout.write(await runReport(args.previous, args.current, { limit: args.limit }));
  } catch (error) {
    console.error(`incremental-manifest-report: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
