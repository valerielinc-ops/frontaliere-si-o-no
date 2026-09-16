#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_KINDS, verifyRuntimeInputExclusion } from '../../build-plugins/shared/incrementalManifest.mjs';

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
    'Uso: node scripts/ci/incremental-manifest-report.mjs <precedente.json> <corrente.json>',
    '     node scripts/ci/incremental-manifest-report.mjs --previous=... --current=... [--limit=50]',
  ].join('\n');
}

function loadManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.entries)) {
    throw new Error(`${file}: manifest.entries deve essere un array`);
  }
  const entries = new Map();
  for (const entry of data.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.inputHash !== 'string' || typeof entry.kind !== 'string') {
      throw new Error(`${file}: entry non valida`);
    }
    if (entries.has(entry.path)) throw new Error(`${file}: path duplicato ${entry.path}`);
    entries.set(entry.path, entry);
  }
  return { file, data, entries };
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

export function buildReport(previous, current, { limit = 50 } = {}) {
  verifyRuntimeInputExclusion();
  const stats = byKindStats();
  const collisions = [];
  const added = [];
  const removed = [];
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
      const previousFingerprint = previousEntry.inputFingerprint || previousEntry.canonicalInputHash;
      const currentFingerprint = currentEntry.inputFingerprint || currentEntry.canonicalInputHash;
      if (previousFingerprint && currentFingerprint && previousFingerprint === currentFingerprint) {
        collisions.push({
          path: pagePath,
          previousHash: previousEntry.inputHash,
          currentHash: currentEntry.inputHash,
          kind: currentEntry.kind,
        });
      }
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
  lines.push(`Collisioni (stesso path, input canonico uguale, inputHash diverso): ${collisions.length}`);
  for (const collision of collisions.slice(0, limit)) {
    lines.push(`- ${collision.path} — ${collision.kind} (${collision.previousHash} → ${collision.currentHash})`);
  }
  if (collisions.length > limit) lines.push(`- … altre ${collisions.length - limit}`);
  if (collisions.length === 0) lines.push('- Nessuna');
  lines.push('');
  lines.push(...pathList('Path aggiunti', added, limit));
  lines.push('');
  lines.push(...pathList('Path rimossi', removed, limit));
  return `${lines.join('\n')}\n`;
}

export function runReport(previousFile, currentFile, options) {
  return buildReport(loadManifest(previousFile), loadManifest(currentFile), options);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.previous || !args.current) {
    console.error(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  try {
    process.stdout.write(runReport(args.previous, args.current, { limit: args.limit }));
  } catch (error) {
    console.error(`incremental-manifest-report: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
