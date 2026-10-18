#!/usr/bin/env node
/**
 * Keep the nanako loop-sync manifest consistent with the structural generator
 * transport.
 *
 * The generator is staged from this repository under `generator/`, while the
 * loop-sync manifest is owned by the articles repository.  A file copied by
 * the structural transport is not automatically a governed loop-sync twin.
 * That distinction matters for two classes of files:
 *
 * - `article-factuality-gates.mjs` remains an identical twin, so its pure
 *   recognizer and dataset must be registered in the loop-sync manifest too;
 * - `evergreen-topic-generator.mjs` and `harvest-agent-lessons.mjs` consume
 *   repository-specific or adapted dependencies, so pretending that they are
 *   identical would let a pull-side transport copy an incoherent file.
 *
 * This module is deliberately dependency-free and deterministic.  It runs in
 * the source checkout while the transport workflow has the nanako checkout on
 * disk, before that workflow commits its staged branch.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOOP_SYNC_MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';
const ADAPTATION_ISSUE = 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/issues/2880';

/**
 * Dependencies that are delivered byte-for-byte under `generator/` and must
 * therefore be visible to the loop-sync closure checker as identical twins.
 */
export const IDENTICAL_TWIN_DEPENDENCIES = Object.freeze([
  {
    sitePath: 'scripts/lib/first-name-recognition.mjs',
    corpusPath: 'generator/scripts/lib/first-name-recognition.mjs',
  },
  {
    sitePath: 'scripts/lib/first-names.json',
    corpusPath: 'generator/scripts/lib/first-names.json',
  },
]);

/**
 * The generator rewire gives this file a corpus-specific implementation; the
 * CI harvester imports adapted contracts on the two repositories.  Both must
 * remain explicit `adapted` entries rather than being copied by the identical
 * twin puller.
 */
export const ADAPTED_TWIN_DISPOSITIONS = Object.freeze([
  {
    sitePath: 'scripts/lib/evergreen-topic-generator.mjs',
    corpusPath: 'generator/scripts/lib/evergreen-topic-generator.mjs',
    adaptationIssue: ADAPTATION_ISSUE,
    reason:
      'adapted: the nanako generator consumes vendored site data and the generator-side border-data REWIRE; structural transport owns the copy, not loop-sync.',
  },
  {
    sitePath: 'scripts/ci/harvest-agent-lessons.mjs',
    corpusPath: 'scripts/ci/harvest-agent-lessons.mjs',
    adaptationIssue: ADAPTATION_ISSUE,
    reason:
      'adapted: the corpus harvester imports repository-specific close, follow-up, and CI constant contracts; pull-side copying the site file would mix incompatible graphs.',
  },
]);

function cloneManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('loop-sync manifest must be an object');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('loop-sync manifest must contain an array `files`');
  }
  return structuredClone(manifest);
}

function entrySitePath(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = typeof entry.sitePath === 'string' && entry.sitePath.trim()
    ? entry.sitePath
    : entry.path;
  return typeof value === 'string' && value.trim() ? value : null;
}

function entriesForTwin(files, sitePath, corpusPath = null) {
  return files.filter((entry) => (
    entrySitePath(entry) === sitePath
    || (corpusPath && entry?.path === corpusPath)
  ));
}

function requireSingleEntry(files, sitePath, corpusPath = null) {
  const matches = entriesForTwin(files, sitePath, corpusPath);
  if (matches.length === 0) {
    throw new Error(`loop-sync entry missing for ${sitePath}`);
  }
  if (matches.length > 1) {
    throw new Error(`duplicate loop-sync entries for ${sitePath}`);
  }
  return matches[0];
}

function requireHashPair(hashes, sitePath) {
  const pair = hashes instanceof Map ? hashes.get(sitePath) : hashes?.[sitePath];
  if (!pair || typeof pair.site !== 'string' || typeof pair.corpus !== 'string') {
    throw new Error(`hash pair missing for ${sitePath}`);
  }
  return pair;
}

function setIdenticalDependencyEntry(files, dependency, hashes, alignedAt) {
  const existing = entriesForTwin(files, dependency.sitePath, dependency.corpusPath);
  if (existing.length > 1) throw new Error(`duplicate loop-sync entries for ${dependency.sitePath}`);
  const hashPair = requireHashPair(hashes, dependency.sitePath);
  const canonical = {
    path: dependency.corpusPath,
    sitePath: dependency.sitePath,
    mode: 'identical',
    baseline: {
      site: hashPair.site,
      corpus: hashPair.corpus,
      alignedAt,
    },
  };

  if (existing.length === 0) {
    files.push(canonical);
    return 'added';
  }

  const entry = existing[0];
  if (entry.path !== dependency.corpusPath || entry.mode !== 'identical') {
    throw new Error(
      `${dependency.sitePath} is already governed with incompatible path/mode `
      + `(path=${entry.path || '(missing)'}, mode=${entry.mode || '(missing)'})`,
    );
  }
  const before = JSON.stringify(entry);
  entry.baseline = canonical.baseline;
  return before === JSON.stringify(entry) ? 'unchanged' : 'updated';
}

function setAdaptedDisposition(files, disposition) {
  const entry = requireSingleEntry(files, disposition.sitePath, disposition.corpusPath);
  if (entry.mode !== 'identical' && entry.mode !== 'adapted') {
    throw new Error(
      `${disposition.sitePath} has unsupported loop-sync mode ${entry.mode || '(missing)'}`,
    );
  }
  const before = JSON.stringify(entry);
  entry.mode = 'adapted';
  entry.adaptationIssue = disposition.adaptationIssue;
  entry.reason = disposition.reason;
  return before === JSON.stringify(entry) ? 'unchanged' : 'updated';
}

/**
 * Pure manifest reconciliation.  `hashes` is supplied by the caller so this
 * function can be tested without a checkout or network.
 *
 * @param {object} manifest
 * @param {{hashes: Map<string, {site: string, corpus: string}>|Record<string, {site: string, corpus: string}>, alignedAt: string}} options
 * @returns {{manifest: object, added: string[], updated: string[], unchanged: string[]}}
 */
export function reconcileNanakoLoopManifest(manifest, { hashes, alignedAt } = {}) {
  if (typeof alignedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(alignedAt)) {
    throw new Error(`alignedAt must be an ISO date, got ${alignedAt || '(missing)'}`);
  }
  const next = cloneManifest(manifest);
  const counts = { added: [], updated: [], unchanged: [] };

  for (const dependency of IDENTICAL_TWIN_DEPENDENCIES) {
    const result = setIdenticalDependencyEntry(next.files, dependency, hashes, alignedAt);
    counts[result].push(dependency.sitePath);
  }
  for (const disposition of ADAPTED_TWIN_DISPOSITIONS) {
    const result = setAdaptedDisposition(next.files, disposition);
    counts[result].push(disposition.sitePath);
  }

  return { manifest: next, ...counts };
}

function shortHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

function hashesForCheckout(sourceRoot, corpusRoot) {
  const hashes = new Map();
  for (const dependency of IDENTICAL_TWIN_DEPENDENCIES) {
    const sourceFile = path.join(sourceRoot, dependency.sitePath);
    const corpusFile = path.join(corpusRoot, dependency.corpusPath);
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
      throw new Error(`source transport file missing: ${dependency.sitePath}`);
    }
    if (!fs.existsSync(corpusFile) || !fs.statSync(corpusFile).isFile()) {
      throw new Error(`staged corpus transport file missing: ${dependency.corpusPath}`);
    }
    hashes.set(dependency.sitePath, { site: shortHash(sourceFile), corpus: shortHash(corpusFile) });
  }
  return hashes;
}

/** Prepare a nanako checkout and write only its loop-sync manifest. */
export function prepareNanakoLoopSyncManifest({ sourceRoot, corpusRoot, alignedAt } = {}) {
  if (!sourceRoot || !corpusRoot) throw new Error('sourceRoot and corpusRoot are required');
  const manifestPath = path.join(corpusRoot, LOOP_SYNC_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) throw new Error(`loop-sync manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = reconcileNanakoLoopManifest(manifest, {
    hashes: hashesForCheckout(sourceRoot, corpusRoot),
    alignedAt: alignedAt || new Date().toISOString().slice(0, 10),
  });
  if (JSON.stringify(manifest) !== JSON.stringify(result.manifest)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  }
  return { ...result, changed: JSON.stringify(manifest) !== JSON.stringify(result.manifest), manifestPath };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  const corpusRoot = process.argv[2];
  try {
    const result = prepareNanakoLoopSyncManifest({ sourceRoot: ROOT, corpusRoot });
    console.log(JSON.stringify({
      manifest: result.manifestPath,
      changed: result.changed,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
    }));
  } catch (error) {
    console.error(`prepare-nanako-identical-twin-closure fallito: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}
