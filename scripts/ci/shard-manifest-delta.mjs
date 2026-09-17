#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './incremental-manifest-report.mjs';
import { MANIFEST_FORMAT, MANIFEST_VERSION, PAGE_KINDS } from '../../build-plugins/shared/incrementalManifest.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--current=')) args.current = arg.slice('--current='.length);
    else if (arg.startsWith('--previous=')) args.previous = arg.slice('--previous='.length);
    else if (arg.startsWith('--scope=')) args.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--source-root=')) args.sourceRoot = arg.slice('--source-root='.length);
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--snapshot-only') args.snapshotOnly = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Uso: node scripts/ci/shard-manifest-delta.mjs --current=... --previous=... --scope=... --source-root=... --out=...',
    '     node scripts/ci/shard-manifest-delta.mjs --current=... --scope=... --source-root=... --out=... --snapshot-only',
  ].join('\n');
}

function normalizeScope(scope) {
  return String(scope || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function isSafeManifestPath(pagePath) {
  const segments = pagePath.split('/');
  return pagePath === pagePath.replaceAll('\\', '/')
    && !pagePath.startsWith('/')
    && !pagePath.includes('\0')
    && !segments.includes('..')
    && segments.every((segment, index) => segment.length > 0 || index === segments.length - 1);
}

function inScope(pagePath, scope) {
  return !scope || pagePath === scope || pagePath.startsWith(`${scope}/`);
}

function validateManifest(manifest, label) {
  if (!manifest?.data || !PAGE_KINDS.every((kind) => kind in manifest.data.kinds || manifest.data.counts.byKind[kind] === 0)) {
    throw new Error(`${label}: manifest kind metadata non valida`);
  }
  for (const entry of manifest.entries.values()) {
    if (!isSafeManifestPath(entry.path)) {
      throw new Error(`${label}: path non sicuro ${entry.path}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(entry.inputHash)) {
      throw new Error(`${label}: hash non valido per ${entry.path}`);
    }
    const metadata = manifest.data.kinds[entry.kind];
    if (!metadata || metadata.state !== 'live') {
      throw new Error(`${label}: entry non-live ${entry.path}`);
    }
  }
}

function selectEntries(manifest, scope) {
  return new Map([...manifest.entries].filter(([pagePath]) => inScope(pagePath, scope)));
}

function assertPayload(entries, sourceRoot) {
  for (const entry of entries.values()) {
    const base = entry.path.replace(/\/+$/, '');
    const candidates = [
      path.join(sourceRoot, entry.path),
      path.join(sourceRoot, base, 'index.html'),
      path.join(sourceRoot, `${base}.html`),
    ];
    if (!candidates.some((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    })) {
      throw new Error(`payload mancante per ${entry.path}`);
    }
  }
}

function listPayloadFiles(root, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childAbsolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPayloadFiles(childAbsolute, childRelative));
    } else if (entry.isFile()) {
      files.push(childRelative.split(path.sep).join('/'));
    } else {
      throw new Error('payload non-regular: ' + childRelative);
    }
  }
  return files.sort();
}

function relativeManifestPath(pagePath, scope) {
  const normalized = pagePath.replace(/\/+$/, '');
  if (!scope) return normalized;
  const prefix = `${scope}/`;
  if (normalized === scope) return '';
  if (!normalized.startsWith(prefix)) {
    throw new Error(`path ${pagePath} fuori scope ${scope}`);
  }
  return normalized.slice(prefix.length);
}

function isCoveredByManifest(relativePath, manifestBases) {
  if (manifestBases.has(relativePath)) return true;
  if (relativePath === 'index.html' && manifestBases.has('')) return true;
  if (relativePath.endsWith('/index.html')
      && manifestBases.has(relativePath.slice(0, -'/index.html'.length))) {
    return true;
  }
  if (relativePath.endsWith('.html') && manifestBases.has(relativePath.slice(0, -'.html'.length))) {
    return true;
  }
  return false;
}

function writePathList(outputFile, paths) {
  fs.writeFileSync(outputFile, paths.length ? `${paths.join('\n')}\n` : '');
}

function writeSnapshot(manifest, entries, outputFile) {
  const byKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, []]));
  for (const entry of entries.values()) byKind[entry.kind].push(entry);
  const lines = [JSON.stringify({
    type: 'header',
    manifestVersion: MANIFEST_VERSION,
    format: MANIFEST_FORMAT,
    locale: manifest.data.locale,
  })];
  for (const kind of PAGE_KINDS) {
    const kindEntries = byKind[kind].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (kindEntries.length === 0) continue;
    const metadata = manifest.data.kinds[kind];
    lines.push(JSON.stringify({ type: 'kind', kind, ...metadata }));
    for (const entry of kindEntries) {
      lines.push(JSON.stringify({ path: entry.path, hash: entry.inputHash }));
    }
  }
  const counts = {
    total: entries.size,
    byKind: Object.fromEntries(PAGE_KINDS.map((kind) => [kind, byKind[kind].length])),
  };
  const footer = { type: 'footer', counts };
  if (manifest.data.jobsSeoEmitterFingerprint) {
    footer.jobsSeoEmitterFingerprint = manifest.data.jobsSeoEmitterFingerprint;
  }
  lines.push(JSON.stringify(footer));
  fs.writeFileSync(outputFile, `${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.current || args.scope === undefined || !args.sourceRoot || !args.out) {
    if (args.help) {
      console.log(usage());
      return;
    }
    throw new Error(usage());
  }
  if (!args.snapshotOnly && !args.previous) throw new Error(usage());

  const scope = normalizeScope(args.scope);
  const current = await loadManifest(args.current);
  validateManifest(current, 'current');
  if (current.data.locale.length === 0) throw new Error('current: locale vuota');
  const currentEntries = selectEntries(current, scope);
  assertPayload(currentEntries, args.sourceRoot);
  const payloadRoot = path.join(args.sourceRoot, scope);
  if (!fs.statSync(payloadRoot).isDirectory()) {
    throw new Error(`payload root mancante per ${scope || '/'}`);
  }

  let previousEntries = new Map();
  let changed = [...currentEntries.keys()].sort();
  let removed = [];
  if (!args.snapshotOnly) {
    const previous = await loadManifest(args.previous);
    validateManifest(previous, 'previous');
    if (previous.data.locale !== current.data.locale) {
      throw new Error(`locale precedente ${previous.data.locale} diversa da corrente ${current.data.locale}`);
    }
    previousEntries = selectEntries(previous, scope);
    changed = [...currentEntries].filter(([pagePath, currentEntry]) => {
      const previousEntry = previousEntries.get(pagePath);
      return !previousEntry
        || previousEntry.inputHash !== currentEntry.inputHash
        || previousEntry.kind !== currentEntry.kind;
    }).map(([pagePath]) => pagePath).sort();
    removed = [...previousEntries.keys()].filter((pagePath) => !currentEntries.has(pagePath)).sort();
  }

  fs.mkdirSync(args.out, { recursive: true });
  const payloadFiles = listPayloadFiles(payloadRoot);
  const currentBases = new Set([...currentEntries.keys()].map((pagePath) => relativeManifestPath(pagePath, scope)));
  const changedBases = new Set(changed.map((pagePath) => relativeManifestPath(pagePath, scope)));
  const changedFiles = payloadFiles.filter((relativePath) => isCoveredByManifest(relativePath, changedBases));
  const unmanifestedFiles = payloadFiles.filter((relativePath) => !isCoveredByManifest(relativePath, currentBases));
  writeSnapshot(current, currentEntries, path.join(args.out, 'snapshot.jsonl'));
  writePathList(path.join(args.out, 'changed.txt'), changed);
  writePathList(path.join(args.out, 'removed.txt'), removed);
  writePathList(path.join(args.out, 'payload-files.txt'), payloadFiles);
  writePathList(path.join(args.out, 'changed-files.txt'), changedFiles);
  writePathList(path.join(args.out, 'unmanifested-files.txt'), unmanifestedFiles);
  fs.writeFileSync(path.join(args.out, 'summary.json'), `${JSON.stringify({
    locale: current.data.locale,
    scope,
    current: currentEntries.size,
    previous: previousEntries.size,
    changed: changed.length,
    removed: removed.length,
  })}\n`);
  console.log(`manifest delta: scope=${scope || '/'} current=${currentEntries.size} previous=${previousEntries.size} changed=${changed.length} removed=${removed.length}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`shard-manifest-delta: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
