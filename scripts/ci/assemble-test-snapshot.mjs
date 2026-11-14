#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSEMBLE_AUX_DATA_INPUTS,
  ASSEMBLE_OUTPUT_CACHE_VERSION,
  assembleCacheFileContract,
  computeAssembleCacheKey,
  isAssembleCacheManifestValid,
  listAssembleCodeClosure,
} from '../assemble-jobs-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNAPSHOT_ROOT = path.join(ROOT, '.cache', 'assemble-jobs-test-snapshot');
const SNAPSHOT_SCRIPT = fileURLToPath(import.meta.url);
const NODE_MAJOR = process.versions.node.split('.')[0];
const MAX_AGE_MS = 60 * 60 * 1000;
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
  const files = new Set([
    ...listAssembleCodeClosure(),
    SNAPSHOT_SCRIPT,
    path.join(ROOT, 'package-lock.json'),
    path.join(ROOT, '.github', 'workflows', 'tests.yml'),
    path.join(ROOT, '.github', 'workflows', 'hourly-test-assemble-snapshot.yml'),
  ]);
  const hasher = crypto.createHash('sha256');
  hasher.update('assemble-test-snapshot:v1\0');
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

function expectedCacheManifest() {
  const cache = computeAssembleCacheKey({ withStats: true, withSummaries: true, withExpired: true });
  const contract = assembleCacheFileContract({ withStats: true, withSummaries: true, withExpired: true });
  return {
    cache,
    expected: {
      inputFingerprint: cache.inputFingerprint,
      cacheKey: cache.cacheKey,
      includeTranslationHeld: cache.includeTranslationHeld,
      withStats: true,
      withSummaries: true,
      withExpired: true,
      ...contract,
    },
  };
}

function prepare() {
  const sourceRunId = String(process.env.GITHUB_RUN_ID || '');
  const sourceRunAttempt = String(process.env.GITHUB_RUN_ATTEMPT || '');
  const sourceCapturedAt = String(process.env.ASSEMBLE_TEST_SNAPSHOT_SOURCE_AT || '');
  if (!/^\d+$/.test(sourceRunId) || !/^\d+$/.test(sourceRunAttempt)) {
    throw new Error('GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT is missing or invalid');
  }
  if (!Number.isFinite(Date.parse(sourceCapturedAt)) || Date.parse(sourceCapturedAt) > Date.now()) {
    throw new Error('ASSEMBLE_TEST_SNAPSHOT_SOURCE_AT is missing or invalid');
  }

  const { cache, expected } = expectedCacheManifest();
  const sourceDir = path.join(ROOT, '.cache', 'assemble-jobs', cache.cacheKey);
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

  fs.rmSync(SNAPSHOT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  for (const name of requiredFiles) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(SNAPSHOT_ROOT, name));
  }
  fs.writeFileSync(path.join(SNAPSHOT_ROOT, 'test-snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    sourceRunId,
    sourceRunAttempt,
    sourceCapturedAt,
    snapshotAt: new Date().toISOString(),
    compatibilityFingerprint: computeCompatibilityFingerprint(),
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

function restore() {
  const expectedRunId = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ID || '');
  const expectedRunAttempt = String(process.env.ASSEMBLE_TEST_SNAPSHOT_RUN_ATTEMPT || '');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_ROOT, 'test-snapshot.json'), 'utf8'));
  } catch {
    writeOutput('restored', 'false');
    writeOutput('reason', 'snapshot manifest is missing or invalid JSON');
    return;
  }

  // Age starts at checkout, before npm install and assembly. Using the later
  // publish time would make data already stale during a slow seed appear fresh.
  const ageMs = Date.now() - Date.parse(manifest?.sourceCapturedAt || '');
  const expectedFiles = SNAPSHOT_FILES;
  const compatibilityFingerprint = computeCompatibilityFingerprint();
  const allFilesPresent = Array.isArray(manifest?.snapshotFiles)
    && expectedFiles.length === manifest.snapshotFiles.length
    && expectedFiles.every((name) => {
      if (!manifest.snapshotFiles.includes(name)) return false;
      try { return fs.lstatSync(path.join(SNAPSHOT_ROOT, name)).isFile(); } catch { return false; }
    });
  const valid = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.schemaVersion === 1
    && manifest.sourceRunId === expectedRunId
    && manifest.sourceRunAttempt === expectedRunAttempt
    && manifest.compatibilityFingerprint === compatibilityFingerprint
    && manifest.outputCacheVersion === ASSEMBLE_OUTPUT_CACHE_VERSION
    && manifest.nodeMajor === NODE_MAJOR
    && manifest.mode === 'stats,summaries,expired'
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs <= MAX_AGE_MS
    && manifest.fileCount === expectedFiles.length
    && allFilesPresent;
  if (!valid) {
    let reason = 'snapshot manifest or outputs do not match the expected contract';
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      reason = 'snapshot manifest is not an object';
    } else if (manifest.sourceRunId !== expectedRunId) {
      reason = 'snapshot run id does not match the selected workflow run';
    } else if (manifest.sourceRunAttempt !== expectedRunAttempt) {
      reason = 'snapshot run attempt does not match the selected workflow run';
    } else if (manifest.compatibilityFingerprint !== compatibilityFingerprint) {
      reason = 'assembler or test snapshot compatibility changed';
    } else if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE_MS) {
      reason = 'snapshot is older than 60 minutes or has an invalid timestamp';
    }
    writeOutput('restored', 'false');
    writeOutput('reason', reason);
    return;
  }

  const restorePairs = expectedFiles.flatMap((name) => outputTargets(name).map((target) => [
    path.join(SNAPSHOT_ROOT, name),
    path.join(ROOT, target),
  ]));
  for (const [, target] of restorePairs) fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const [source, target] of restorePairs) fs.copyFileSync(source, target);
  writeOutput('restored', 'true');
  writeOutput('reason', `snapshot from run ${expectedRunId}, age ${Math.floor(ageMs / 60000)} min`);
}

const command = process.argv[2];
if (command === 'fingerprint') {
  writeOutput('fingerprint', computeCompatibilityFingerprint());
} else if (command === 'can-use') {
  const result = checkChangedPaths();
  writeOutput('eligible', String(result.eligible));
  writeOutput('reason', result.reason);
} else if (command === 'prepare') {
  prepare();
} else if (command === 'restore') {
  restore();
} else {
  console.error('Usage: assemble-test-snapshot.mjs <fingerprint|can-use|prepare|restore>');
  process.exitCode = 2;
}
