#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ASSEMBLE_AUX_DATA_INPUTS,
  ASSEMBLE_OUTPUT_CACHE_VERSION,
  assembleCacheFileContract,
  isAssembleCacheManifestValid,
  listAssembleCodeClosure,
} from '../assemble-jobs-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNAPSHOT_ROOT = path.join(ROOT, '.cache', 'assemble-jobs-test-snapshot');
const SNAPSHOT_SCRIPT = fileURLToPath(import.meta.url);
const NODE_MAJOR = process.versions.node.split('.')[0];
const MAX_AGE_MS = 60 * 60 * 1000;
const SNAPSHOT_CACHE_PREFIX = 'assemble-jobs-test-snapshot';
const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 2;
const SOURCE_CACHE_KEY_RE = /^([0-9a-f]{64})_(stats(?:_noreconcile)?(?:_withheld)?)$/u;
const PUBLIC_TWINS = new Set(['jobs.json', 'expired-jobs.json', 'jobs-stats.json']);
const SNAPSHOT_FILES = assembleCacheFileContract({
  withStats: true,
  withSummaries: true,
  withExpired: true,
}).requiredSnapshotFiles;
const ASSEMBLE_INPUT_PATHS = Object.freeze([
  'data/jobs/by-crawler',
  'data/jobs/expired/by-crawler',
  'data/jobs-crawler-summaries/by-crawler',
  ...ASSEMBLE_AUX_DATA_INPUTS,
  // These files are normally assembler outputs; a PR that edits one must not
  // have its change overwritten by a snapshot built from main.
  ...SNAPSHOT_FILES.flatMap((name) => [
    `data/${name}`,
    ...(PUBLIC_TWINS.has(name) ? [`public/data/${name}`] : []),
  ]),
]);

function relativePath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function addFileHash(hasher, file) {
  const relative = relativePath(file);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    hasher.update(`missing:${relative}\0`);
    return;
  }
  hasher.update(relative);
  hasher.update('\0');
  hasher.update(String(bytes.length));
  hasher.update('\0');
  hasher.update(bytes);
  hasher.update('\0');
}

function computeCompatibilityFingerprint() {
  // Fingerprint output compatibility, not workflow orchestration: unrelated
  // edits to tests.yml must not invalidate an otherwise reusable dataset.
  const files = new Set([
    ...listAssembleCodeClosure(),
    SNAPSHOT_SCRIPT,
    path.join(ROOT, 'package-lock.json'),
  ]);
  const hasher = crypto.createHash('sha256');
  hasher.update('assemble-test-snapshot:v3\0');
  hasher.update(`output:${ASSEMBLE_OUTPUT_CACHE_VERSION}\0node:${NODE_MAJOR}\0mode:stats,summaries,expired\0`);
  for (const file of [...files].sort()) addFileHash(hasher, file);
  return hasher.digest('hex');
}

function writeOutput(name, value) {
  const safeValue = String(value).replace(/[\r\n]/gu, ' ');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${safeValue}\n`);
  }
  console.log(`${name}=${safeValue}`);
}

function outputTargets(name) {
  return [
    `data/${name}`,
    ...(PUBLIC_TWINS.has(name) ? [`public/data/${name}`] : []),
  ];
}

function normalizedChangedPath(value) {
  return path.posix.normalize(String(value).trim().replace(/^\.\//, ''));
}

function isAssembleInputPath(value) {
  const changedPath = normalizedChangedPath(value);
  return ASSEMBLE_INPUT_PATHS.some((inputPath) => (
    changedPath === inputPath || changedPath.startsWith(`${inputPath}/`)
  ));
}

function checkChangedPaths() {
  const statusFile = process.env.CHANGED_PATHS_STATUS_FILE || 'changed-paths-status.txt';
  const pathsFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
  let status = '';
  let changedPaths = [];
  let pathsRead = false;
  try { status = fs.readFileSync(statusFile, 'utf8').trim(); } catch { /* fail closed below */ }
  try {
    changedPaths = fs.readFileSync(pathsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    pathsRead = true;
  } catch { /* fail closed below */ }

  if (status !== 'complete' || !pathsRead) {
    return { eligible: false, reason: !pathsRead ? 'changed-path list is unavailable' : `changed-path list is ${status || 'unavailable'}` };
  }
  const inputChange = changedPaths.find(isAssembleInputPath);
  if (inputChange) {
    return { eligible: false, reason: `PR changes assembler input: ${inputChange}` };
  }
  return { eligible: true, reason: 'PR diff does not change assembler inputs' };
}

function expectedCacheManifest(sourceCacheKey) {
  const cacheKey = String(sourceCacheKey || '');
  const match = cacheKey.match(SOURCE_CACHE_KEY_RE);
  if (!match) throw new Error('the pre-assemble cache key is missing or invalid');
  const inputFingerprint = match[1];
  const contract = assembleCacheFileContract({ withStats: true, withSummaries: true, withExpired: true });
  return {
    cache: { inputFingerprint, cacheKey },
    expected: {
      inputFingerprint,
      cacheKey,
      includeTranslationHeld: match[2].endsWith('_withheld'),
      withStats: true,
      withSummaries: true,
      withExpired: true,
      ...contract,
    },
  };
}

function hasValidSourceCacheIdentity(manifest) {
  const match = String(manifest?.sourceCacheKey || '').match(SOURCE_CACHE_KEY_RE);
  return Boolean(match && manifest.sourceInputFingerprint === match[1]);
}

export function buildSnapshotCacheKey({
  runnerOs = 'Linux',
  compatibilityFingerprint,
  sourceCacheKey,
} = {}) {
  if (!/^[0-9a-f]{64}$/u.test(String(compatibilityFingerprint || ''))) {
    throw new Error('the snapshot compatibility fingerprint is missing or invalid');
  }
  if (!SOURCE_CACHE_KEY_RE.test(String(sourceCacheKey || ''))) {
    throw new Error('the snapshot source cache key is missing or invalid');
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(String(runnerOs || ''))) {
    throw new Error('the runner OS is missing or invalid');
  }
  return `${SNAPSHOT_CACHE_PREFIX}-${runnerOs}-${compatibilityFingerprint}-${sourceCacheKey}`;
}

function validateSnapshotManifest(manifest, {
  expectedRunId = '',
  expectedRunAttempt = '',
  compatibilityFingerprint,
  now = Date.now(),
  requireFresh = true,
} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return 'snapshot manifest is not an object';
  }
  if (manifest.schemaVersion !== SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
    return 'snapshot manifest schema is unsupported';
  }
  if (expectedRunId && manifest.sourceRunId !== expectedRunId) {
    return 'snapshot run id does not match the selected workflow run';
  }
  if (expectedRunAttempt && manifest.sourceRunAttempt !== expectedRunAttempt) {
    return 'snapshot run attempt does not match the selected workflow run';
  }
  if (manifest.compatibilityFingerprint !== compatibilityFingerprint) {
    return 'assembler or test snapshot compatibility changed';
  }
  if (manifest.outputCacheVersion !== ASSEMBLE_OUTPUT_CACHE_VERSION
    || manifest.nodeMajor !== NODE_MAJOR
    || manifest.mode !== 'stats,summaries,expired') {
    return 'snapshot output contract changed';
  }
  if (!hasValidSourceCacheIdentity(manifest)) {
    return 'snapshot source cache key does not match its input fingerprint';
  }
  if (manifest.fileCount !== SNAPSHOT_FILES.length
    || !Array.isArray(manifest.snapshotFiles)
    || manifest.snapshotFiles.length !== SNAPSHOT_FILES.length
    || !SNAPSHOT_FILES.every((name) => manifest.snapshotFiles.includes(name))) {
    return 'snapshot manifest does not list the expected output files';
  }
  if (requireFresh) {
    const ageMs = now - Date.parse(manifest.sourceCapturedAt || '');
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE_MS) {
      return 'snapshot is older than 60 minutes or has an invalid timestamp';
    }
  }
  return '';
}

function readManifest(file, missingReason) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(missingReason);
  }
}

export function snapshotCacheKeyFromMetadata({
  metadataPath = String(process.env.ASSEMBLE_TEST_SNAPSHOT_METADATA_FILE || ''),
  expectedRunId = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ID || ''),
  expectedRunAttempt = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ATTEMPT || ''),
  compatibilityFingerprint = String(
    process.env.ASSEMBLE_TEST_SNAPSHOT_COMPATIBILITY_FINGERPRINT || computeCompatibilityFingerprint(),
  ),
  runnerOs = String(process.env.RUNNER_OS || 'Linux'),
  now = Date.now(),
} = {}) {
  if (!metadataPath) throw new Error('the selected snapshot manifest path is missing');
  const manifest = readManifest(metadataPath, 'the selected snapshot manifest is missing or invalid JSON');
  const reason = validateSnapshotManifest(manifest, {
    expectedRunId,
    expectedRunAttempt,
    compatibilityFingerprint,
    now,
  });
  if (reason) throw new Error(reason);
  return buildSnapshotCacheKey({
    runnerOs,
    compatibilityFingerprint,
    sourceCacheKey: manifest.sourceCacheKey,
  });
}

export function prepare({
  root = ROOT,
  snapshotRoot = SNAPSHOT_ROOT,
  sourceCacheKey = String(process.env.ASSEMBLE_TEST_SNAPSHOT_SOURCE_CACHE_KEY || ''),
  sourceRunId = String(process.env.GITHUB_RUN_ID || ''),
  sourceRunAttempt = String(process.env.GITHUB_RUN_ATTEMPT || ''),
  sourceCapturedAt = String(process.env.ASSEMBLE_TEST_SNAPSHOT_SOURCE_AT || ''),
  compatibilityFingerprint = computeCompatibilityFingerprint(),
  now = Date.now(),
} = {}) {
  if (!/^\d+$/.test(sourceRunId) || !/^\d+$/.test(sourceRunAttempt)) {
    throw new Error('GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT is missing or invalid');
  }
  if (!Number.isFinite(Date.parse(sourceCapturedAt)) || Date.parse(sourceCapturedAt) > now) {
    throw new Error('ASSEMBLE_TEST_SNAPSHOT_SOURCE_AT is missing or invalid');
  }

  const { cache, expected } = expectedCacheManifest(sourceCacheKey);
  const sourceDir = path.join(root, '.cache', 'assemble-jobs', cache.cacheKey);
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isAssembleCacheManifestValid(manifest, expected)) {
    throw new Error('the exact assembler cache manifest is invalid; refusing to publish a test snapshot');
  }

  const requiredFiles = expected.requiredSnapshotFiles;
  for (const name of requiredFiles) {
    if (!manifest.snapshotFiles.includes(name) || !fs.statSync(path.join(sourceDir, name)).isFile()) {
      throw new Error(`the exact assembler snapshot is missing ${name}`);
    }
  }

  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  fs.mkdirSync(snapshotRoot, { recursive: true });
  for (const name of requiredFiles) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(snapshotRoot, name));
  }
  fs.writeFileSync(path.join(snapshotRoot, 'test-snapshot.json'), JSON.stringify({
    schemaVersion: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    sourceRunId,
    sourceRunAttempt,
    sourceCapturedAt,
    snapshotAt: new Date(now).toISOString(),
    compatibilityFingerprint,
    outputCacheVersion: ASSEMBLE_OUTPUT_CACHE_VERSION,
    nodeMajor: NODE_MAJOR,
    mode: 'stats,summaries,expired',
    sourceInputFingerprint: cache.inputFingerprint,
    sourceCacheKey: cache.cacheKey,
    snapshotFiles: requiredFiles,
    fileCount: requiredFiles.length,
  }, null, 2));
  console.log(`Prepared hourly test snapshot from ${cache.cacheKey.slice(0, 12)}... (${requiredFiles.length} outputs)`);
}

export function restore({
  snapshotRoot = SNAPSHOT_ROOT,
  root = ROOT,
  metadataPath = String(process.env.ASSEMBLE_TEST_SNAPSHOT_METADATA_FILE || ''),
  expectedRunId = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ID || ''),
  expectedRunAttempt = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ATTEMPT || ''),
  compatibilityFingerprint = computeCompatibilityFingerprint(),
  now = Date.now(),
  output = writeOutput,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'test-snapshot.json'), 'utf8'));
  } catch {
    output('restored', 'false');
    output('reason', 'snapshot manifest is missing or invalid JSON');
    return;
  }

  let selectedManifest;
  try {
    if (!metadataPath) throw new Error('the selected snapshot manifest path is missing');
    selectedManifest = readManifest(metadataPath, 'the selected snapshot manifest is missing or invalid JSON');
  } catch (error) {
    output('restored', 'false');
    output('reason', error.message);
    return;
  }

  const selectedManifestError = validateSnapshotManifest(selectedManifest, {
    expectedRunId,
    expectedRunAttempt,
    compatibilityFingerprint,
    now,
  });
  if (selectedManifestError) {
    output('restored', 'false');
    output('reason', selectedManifestError);
    return;
  }

  const expectedFiles = SNAPSHOT_FILES;
  const allFilesPresent = Array.isArray(manifest?.snapshotFiles)
    && expectedFiles.length === manifest.snapshotFiles.length
    && expectedFiles.every((name) => {
      if (!manifest.snapshotFiles.includes(name)) return false;
      try { return fs.lstatSync(path.join(snapshotRoot, name)).isFile(); } catch { return false; }
    });
  // A stable key may point to an archive saved by an earlier run. The latest
  // successful run's artifact supplies the freshness window; the cache key
  // and source fingerprint prove the archived output has identical inputs.
  const cachedManifestError = validateSnapshotManifest(manifest, {
    compatibilityFingerprint,
    requireFresh: false,
  });
  const valid = !cachedManifestError
    && manifest.sourceCacheKey === selectedManifest.sourceCacheKey
    && allFilesPresent;
  if (!valid) {
    const reason = cachedManifestError
      || (manifest?.sourceCacheKey !== selectedManifest.sourceCacheKey
        ? 'cached snapshot does not match the selected source cache key'
        : 'snapshot manifest or outputs do not match the expected contract');
    output('restored', 'false');
    output('reason', reason);
    return;
  }

  const restorePairs = expectedFiles.flatMap((name) => outputTargets(name).map((target) => [
    path.join(snapshotRoot, name),
    path.join(root, target),
  ]));
  for (const [, target] of restorePairs) fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const [source, target] of restorePairs) fs.copyFileSync(source, target);
  const ageMs = now - Date.parse(selectedManifest.sourceCapturedAt);
  output('restored', 'true');
  output('reason', `snapshot from run ${expectedRunId}, age ${Math.floor(ageMs / 60000)} min`);
}

if ((() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  const command = process.argv[2];
  if (command === 'fingerprint') {
    writeOutput('fingerprint', computeCompatibilityFingerprint());
  } else if (command === 'can-use') {
    const result = checkChangedPaths();
    writeOutput('eligible', String(result.eligible));
    writeOutput('reason', result.reason);
  } else if (command === 'prepare') {
    prepare();
  } else if (command === 'cache-key') {
    writeOutput('key', snapshotCacheKeyFromMetadata());
  } else if (command === 'restore') {
    restore();
  } else {
    console.error('Usage: assemble-test-snapshot.mjs <fingerprint|can-use|prepare|cache-key|restore>');
    process.exitCode = 2;
  }
}
