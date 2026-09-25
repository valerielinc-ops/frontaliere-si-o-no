#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './incremental-manifest-report.mjs';
import { collectSourceModuleFiles } from '../../build-plugins/shared/incrementalHtmlReuse.mjs';
import {
  LEGACY_OPTIONAL_KINDS,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  PAGE_KINDS,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const SECTION_SHARD_SLUGS = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/section-shard-slugs.json'),
    'utf8',
  ),
);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// An entry's `hash` covers the page INPUT, not the code that renders it. A
// renderer change with unchanged input (#9788: the OFFERWALL snippet in
// build-plugins/constants.ts) re-rendered every IT job page, but deploy run
// 36112880009 kept the bytes already in the ticino-it shard for all 277'952
// files whose input hash had not moved. So the snapshot also records, per
// kind, the render identity under which EVERY entry of that kind in the
// published tree was last evaluated (`renderFingerprint`). When it differs
// from the current build's, is missing, or the kind metadata moved, every
// entry of the kind is planned as changed; shard_delta_apply_source_tree still
// compares blob ids, so only the files whose bytes really differ are written.
//
// The jobs SEO kinds carry the build-time emitter fingerprint (render source
// graph, render flags, static-shell assets). The other kinds come from
// renderers the build does not fingerprint: their identity is the source graph
// of those renderers, hashed from this checkout (the build and the shard push
// run in the same job), plus the jobs fingerprint, which carries the
// build-time flags and assets shared by every SEO page. Full-content 404
// bridges copy a job or cluster page byte for byte while keying their input on
// that page's manifest hash, so they depend on both renderers. A kind with
// neither source of identity has no fingerprint and is always re-evaluated.
export const RENDERER_ENTRIES_BY_KIND = Object.freeze({
  'related-search-cluster': Object.freeze(['build-plugins/relatedSearchClustersPlugin.ts']),
  'related-search-sitemap': Object.freeze(['build-plugins/relatedSearchClustersPlugin.ts']),
  'cf-hot-404-bridge': Object.freeze([
    'build-plugins/cfHot404BridgePlugin.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
  ]),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceGraphHash(rootDir, entryFiles) {
  if (!entryFiles.every((file) => fs.existsSync(path.join(rootDir, file)))) return null;
  const records = collectSourceModuleFiles(rootDir, entryFiles).map((file) => ({
    path: file,
    hash: sha256(fs.readFileSync(path.join(rootDir, file))),
  }));
  return sha256(JSON.stringify(records));
}

/**
 * Per-kind render identity of the current build. Missing build-time
 * fingerprint or renderer source ⇒ no entry for the kind ⇒ always re-evaluated.
 */
export function renderFingerprints(manifest, rootDir = REPO_ROOT) {
  const emitter = manifest.data.jobsSeoEmitterFingerprint;
  const fingerprints = {};
  if (!emitter) return fingerprints;
  const graphHashes = new Map();
  for (const kind of PAGE_KINDS) {
    if (emitter[kind]) {
      fingerprints[kind] = emitter[kind];
      continue;
    }
    const entryFiles = RENDERER_ENTRIES_BY_KIND[kind];
    if (!entryFiles) continue;
    const key = entryFiles.join('\n');
    if (!graphHashes.has(key)) graphHashes.set(key, sourceGraphHash(rootDir, entryFiles));
    const sourceGraph = graphHashes.get(key);
    if (!sourceGraph) continue;
    fingerprints[kind] = sha256(JSON.stringify({ kind, sourceGraph, jobsSeoEmitterFingerprint: emitter }));
  }
  return fingerprints;
}

// Only the snapshot footer written by this tool vouches for the published
// bytes. Its `jobsSeoEmitterFingerprint` does not: it is the fingerprint of the
// build that wrote the snapshot, and before `renderFingerprint` existed that
// build kept older bytes for every page whose input hash had not moved. A
// malformed value vouches for nothing, as if absent.
function publishedRenderFingerprint(manifest) {
  const value = manifest.footer?.renderFingerprint;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([kind, fingerprint]) => (
    PAGE_KINDS.includes(kind) && typeof fingerprint === 'string' && fingerprint.length > 0
  )));
}

/** Kinds whose published entries must all be re-evaluated against the payload. */
export function staleRenderKinds(previous, current, currentFingerprints) {
  const published = publishedRenderFingerprint(previous);
  return new Set(PAGE_KINDS.filter((kind) => {
    const before = previous.data.kinds[kind];
    const after = current.data.kinds[kind];
    return !currentFingerprints[kind]
      || published[kind] !== currentFingerprints[kind]
      || before?.templateVersion !== after?.templateVersion
      || before?.sourceVersion !== after?.sourceVersion;
  }));
}

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

function sectionScopesForLocale(scope) {
  // The non-IT locale dist is stripped after each section shard is pushed;
  // its build manifest is intentionally the pre-strip corpus.
  if (!['en', 'de', 'fr'].includes(scope)) return [];
  return Object.values(SECTION_SHARD_SLUGS)
    .filter((section) => section && typeof section === 'object')
    .map((section) => section[scope])
    .filter(Boolean)
    .map((slug) => `${scope}/${slug}`);
}

function inScope(pagePath, scope, excludedScopes) {
  if (scope && pagePath !== scope && !pagePath.startsWith(`${scope}/`)) return false;
  return !excludedScopes.some((excludedScope) => (
    pagePath === excludedScope || pagePath.startsWith(`${excludedScope}/`)
  ));
}

function validateManifest(manifest, label) {
  const kinds = manifest?.data?.kinds;
  const countsByKind = manifest?.data?.counts?.byKind;
  if (!manifest?.data || !kinds || !countsByKind || !PAGE_KINDS.every((kind) => {
    if (kind in kinds) return true;
    if (Object.prototype.hasOwnProperty.call(countsByKind, kind)) {
      return countsByKind[kind] === 0;
    }
    return LEGACY_OPTIONAL_KINDS.has(kind);
  })) {
    throw new Error(`${label}: manifest kind metadata non valida`);
  }
  for (const entry of manifest.entries.values()) {
    if (!isSafeManifestPath(entry.path)) {
      throw new Error(`${label}: path non sicuro ${entry.path}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(entry.inputHash)) {
      throw new Error(`${label}: hash non valido per ${entry.path}`);
    }
    if (entry.reuseHash !== undefined && !/^[0-9a-f]{64}$/i.test(entry.reuseHash)) {
      throw new Error(`${label}: reuseHash non valido per ${entry.path}`);
    }
    const metadata = manifest.data.kinds[entry.kind];
    if (!metadata || metadata.state !== 'live') {
      throw new Error(`${label}: entry non-live ${entry.path}`);
    }
  }
}

function selectEntries(manifest, scope) {
  const excludedScopes = sectionScopesForLocale(scope);
  return new Map([...manifest.entries].filter(([pagePath]) => (
    inScope(pagePath, scope, excludedScopes)
  )));
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
  fs.writeFileSync(outputFile, paths.length ? `${paths.join('\0')}\0` : '');
}

function writeSnapshot(manifest, entries, outputFile, renderFingerprint) {
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
      lines.push(JSON.stringify({
        path: entry.path,
        hash: entry.inputHash,
        ...(entry.reuseHash !== undefined ? { reuseHash: entry.reuseHash } : {}),
      }));
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
  // Written by both the full and the delta publication: after either, every
  // entry of a fingerprinted kind holds bytes rendered under that fingerprint.
  if (Object.keys(renderFingerprint).length > 0) footer.renderFingerprint = renderFingerprint;
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

  const currentRenderFingerprint = renderFingerprints(current);
  let previousEntries = new Map();
  let changed = [...currentEntries.keys()].sort();
  let removed = [];
  const renderStale = {};
  if (!args.snapshotOnly) {
    const previous = await loadManifest(args.previous);
    validateManifest(previous, 'previous');
    if (previous.data.locale !== current.data.locale) {
      throw new Error(`locale precedente ${previous.data.locale} diversa da corrente ${current.data.locale}`);
    }
    previousEntries = selectEntries(previous, scope);
    const staleKinds = staleRenderKinds(previous, current, currentRenderFingerprint);
    for (const entry of currentEntries.values()) {
      if (staleKinds.has(entry.kind)) renderStale[entry.kind] = (renderStale[entry.kind] || 0) + 1;
    }
    changed = [...currentEntries].filter(([pagePath, currentEntry]) => {
      const previousEntry = previousEntries.get(pagePath);
      return !previousEntry
        || staleKinds.has(currentEntry.kind)
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
  const manifestCoveredFiles = payloadFiles.filter((relativePath) => isCoveredByManifest(relativePath, currentBases));
  const unmanifestedFiles = payloadFiles.filter((relativePath) => !isCoveredByManifest(relativePath, currentBases));
  const unchangedFiles = manifestCoveredFiles.filter((relativePath) => (
    !isCoveredByManifest(relativePath, changedBases)
  ));
  writeSnapshot(current, currentEntries, path.join(args.out, 'snapshot.jsonl'), currentRenderFingerprint);
  writePathList(path.join(args.out, 'changed.txt'), changed);
  writePathList(path.join(args.out, 'removed.txt'), removed);
  writePathList(path.join(args.out, 'payload-files.txt'), payloadFiles);
  writePathList(path.join(args.out, 'changed-files.txt'), changedFiles);
  writePathList(path.join(args.out, 'manifest-covered-files.txt'), manifestCoveredFiles);
  writePathList(path.join(args.out, 'unmanifested-files.txt'), unmanifestedFiles);
  writePathList(path.join(args.out, 'unchanged-files.txt'), unchangedFiles);
  fs.writeFileSync(path.join(args.out, 'summary.json'), `${JSON.stringify({
    locale: current.data.locale,
    scope,
    current: currentEntries.size,
    previous: previousEntries.size,
    changed: changed.length,
    removed: removed.length,
    unchanged: unchangedFiles.length,
    unmanifested: unmanifestedFiles.length,
    renderStale,
  })}\n`);
  const renderStaleLog = args.snapshotOnly
    ? ''
    : ` render-stale=${Object.entries(renderStale).map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`;
  console.log(`manifest delta: mode=${args.snapshotOnly ? 'snapshot' : 'delta'} scope=${scope || '/'} current=${currentEntries.size} previous=${previousEntries.size} changed=${changed.length} unchanged=${unchangedFiles.length} unmanifested=${unmanifestedFiles.length} removed=${removed.length}${renderStaleLog}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`shard-manifest-delta: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
