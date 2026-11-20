#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createR2Request } from '../lib/r2-section-lock.mjs';

const MANIFEST_VERSION = 1;
const R2_MANIFEST_KEY = 'purge-ledger/og-published-manifest.json';
const PUBLISH_START_KEY = 'cdn-publish-start-id.txt';
const PUBLISH_COMPLETE_KEY = 'cdn-publish-complete-id.txt';
const BUILD_ID_KEY = 'cdn-build-id.txt';
const R2_MANIFEST_TIMEOUT_MS = 30_000;
const BUILD_ID = /^\d{1,20}$/;
const PUBLISH_WINDOW = /^\d{21,40}$/;

function fail(message) {
  console.error(`[r2-og-manifest] ${message}`);
  process.exitCode = 1;
}

function isSafeRelativePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0
    || filePath.includes('\\') || /[\r\n]/.test(filePath)) return false;
  if (path.posix.isAbsolute(filePath)) return false;
  const parts = filePath.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function listFiles(root, relativeDir = '') {
  const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe source path: ${relativePath}`);
    const absolutePath = path.join(root, relativeDir, entry.name);

    if (entry.isSymbolicLink()) throw new Error(`symbolic link in OG source: ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push({ path: relativePath, absolutePath });
    } else {
      throw new Error(`unsupported OG entry: ${relativePath}`);
    }
  }
  return files;
}

async function hashFile(filePath) {
  const before = await fs.stat(filePath);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  const after = await fs.stat(filePath);
  if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`OG file changed while hashing: ${filePath}`);
  }
  return { sha256: hash.digest('hex'), size };
}

function parsePreviousManifest(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) return null;

  const files = new Map();
  for (const file of manifest.files) {
    if (!file || !isSafeRelativePath(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || files.has(file.path)) {
      return null;
    }
    files.set(file.path, { path: file.path, sha256: file.sha256, size: file.size });
  }
  return files;
}

async function loadPreviousManifest(manifestPath) {
  try {
    const files = parsePreviousManifest(await fs.readFile(manifestPath, 'utf8'));
    return files ? { files, status: 'valid' } : { files: null, status: 'invalid' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: null, status: 'missing' };
    return { files: null, status: 'invalid' };
  }
}

async function writeManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, manifestPath);
}

function manifestFromFiles(files, buildId) {
  return {
    version: MANIFEST_VERSION,
    buildId: buildId ?? null,
    files: [...files.values()]
      .map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

function r2ManifestEnabled(env = process.env) {
  return BUILD_ID.test(env.DEPLOY_BUILD_ID ?? '') && Boolean(
    env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_S3_ENDPOINT && env.R2_BUCKET,
  );
}

async function readR2Text(request, key, deadline) {
  const response = await request({ method: 'GET', key, deadline });
  if (response.status === 404) return null;
  const text = await response.text();
  if (response.status !== 200) throw new Error('R2 object read failed');
  return text;
}

async function restoreDurableManifest(manifestPath) {
  try {
    const request = createR2Request();
    const deadline = Date.now() + R2_MANIFEST_TIMEOUT_MS;
    const raw = await readR2Text(request, R2_MANIFEST_KEY, deadline);
    if (raw === null) return { files: null, status: 'missing' };

    const files = parsePreviousManifest(raw);
    if (!files) return { files: null, status: 'invalid' };
    const { buildId, publishWindow } = JSON.parse(raw);
    if (typeof buildId !== 'string' || !BUILD_ID.test(buildId)
      || typeof publishWindow !== 'string' || !PUBLISH_WINDOW.test(publishWindow)) {
      return { files: null, status: 'invalid' };
    }

    // A newer interrupted publisher may already have overwritten some OG
    // objects. Read its start marker last, after reading the closed window.
    const [complete, liveBuild] = await Promise.all([
      readR2Text(request, PUBLISH_COMPLETE_KEY, deadline),
      readR2Text(request, BUILD_ID_KEY, deadline),
    ]);
    const start = await readR2Text(request, PUBLISH_START_KEY, deadline);
    if (complete?.trim() !== publishWindow || start?.trim() !== publishWindow
      || liveBuild?.trim() !== buildId) {
      console.error('[r2-og-manifest] R2 manifest does not match the completed publish window');
      return { files: null, status: 'invalid' };
    }

    await writeManifest(manifestPath, manifestFromFiles(files, buildId));
    console.error('[r2-og-manifest] restored the published OG manifest from R2');
    return { files, status: 'valid' };
  } catch {
    console.error('[r2-og-manifest] R2 manifest restore failed; publishing the full OG payload');
    return { files: null, status: 'invalid' };
  }
}

async function storeDurableManifest(manifest) {
  try {
    const request = createR2Request();
    const deadline = Date.now() + R2_MANIFEST_TIMEOUT_MS;
    const publishWindow = (await readR2Text(request, PUBLISH_START_KEY, deadline))?.trim();
    if (!PUBLISH_WINDOW.test(publishWindow ?? '')) throw new Error('R2 publish window is missing');
    const response = await request({
      method: 'PUT',
      key: R2_MANIFEST_KEY,
      body: JSON.stringify({ ...manifest, publishWindow }),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
      },
      deadline,
    });
    if (!response.ok) {
      await response.text();
      throw new Error('R2 manifest write failed');
    }
    console.error('[r2-og-manifest] stored the verified OG manifest on R2');
  } catch {
    console.error('[r2-og-manifest] R2 manifest write failed; the local OG checkpoint remains available');
  }
}

async function writeCandidateManifest(candidatePath, files) {
  const candidateFiles = new Map(files.map((file) => [file.path, file]));
  await writeManifest(candidatePath, manifestFromFiles(candidateFiles, process.env.DEPLOY_BUILD_ID));
}

async function writeChangedFiles(filePath, files) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, files.map((file) => file.path).join('\n') + (files.length ? '\n' : ''), { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function readPathList(raw, label) {
  const paths = raw.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const filePath of paths) {
    if (!isSafeRelativePath(filePath) || seen.has(filePath)) {
      throw new Error(`${label} contains an unsafe or duplicate path: ${filePath}`);
    }
    seen.add(filePath);
  }
  return seen;
}

async function recordPublishedProgress({ candidatePath, previousPath, changedPath, completedPath, publishedPath, sourcePath, complete }) {
  const candidateRaw = await fs.readFile(candidatePath, 'utf8');
  const candidate = JSON.parse(candidateRaw);
  const candidateFiles = parsePreviousManifest(candidateRaw);
  if (!candidate || candidate.version !== MANIFEST_VERSION || !candidateFiles) {
    throw new Error('candidate manifest is invalid; refusing to checkpoint unverified OG files');
  }

  const changed = readPathList(await fs.readFile(changedPath, 'utf8'), 'changed OG file list');
  const completed = readPathList(await fs.readFile(completedPath, 'utf8'), 'completed OG file list');
  const previous = await loadPreviousManifest(previousPath);
  for (const filePath of changed) {
    if (!candidateFiles.has(filePath)) throw new Error(`changed OG path is missing from the candidate manifest: ${filePath}`);
  }
  for (const filePath of completed) {
    if (!changed.has(filePath)) throw new Error(`completed OG path was not in the changed list: ${filePath}`);
    const expected = candidateFiles.get(filePath);
    const alreadyPublished = previous.files?.get(filePath);
    if (alreadyPublished?.sha256 === expected.sha256 && alreadyPublished.size === expected.size) continue;
    const sourceFile = path.join(sourcePath, ...filePath.split('/'));
    const actual = await hashFile(sourceFile);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`completed OG source no longer matches the candidate manifest: ${filePath}`);
    }
  }

  let publishedFiles;
  if (complete) {
    if (completed.size !== changed.size) {
      throw new Error(`cannot complete OG manifest: ${completed.size}/${changed.size} changed files were verified`);
    }
    publishedFiles = candidateFiles;
  } else {
    publishedFiles = previous.files ? new Map(previous.files) : new Map();
    for (const filePath of completed) publishedFiles.set(filePath, candidateFiles.get(filePath));
  }

  const manifest = manifestFromFiles(publishedFiles, candidate.buildId);
  await writeManifest(publishedPath, manifest);
  if (complete && r2ManifestEnabled() && manifest.buildId === process.env.DEPLOY_BUILD_ID) {
    await storeDurableManifest(manifest);
  }
  process.stdout.write(
    `published_files=${publishedFiles.size} completed_changed=${completed.size} `
    + `candidate_files=${candidateFiles.size} complete=${complete}\n`,
  );
}

async function readDeferredSlugs(filePath) {
  if (!filePath) return [];
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`could not read deferred OG slug list: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('deferred OG slug list must be a JSON array');
  const slugs = [];
  for (const slug of parsed) {
    if (typeof slug !== 'string' || !slug || !isSafeRelativePath(`jobs/${slug}.webp`)) {
      throw new Error(`unsafe deferred OG slug: ${String(slug)}`);
    }
    slugs.push(slug);
  }
  return [...new Set(slugs)].sort();
}

async function prepareDelta(sourceDir, previousManifestPath, changedFilesPath, candidatePath, deferredSlugsPath) {
  const sourceRoot = path.resolve(sourceDir);
  const sourceStat = await fs.stat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new Error(`OG source is not a directory: ${sourceDir}`);

  const sourceFiles = await listFiles(sourceRoot);
  const currentFiles = [];
  const hashBatchSize = 64;
  for (let index = 0; index < sourceFiles.length; index += hashBatchSize) {
    const batch = sourceFiles.slice(index, index + hashBatchSize);
    const hashed = await Promise.all(batch.map(async (file) => ({
      path: file.path,
      ...(await hashFile(file.absolutePath)),
    })));
    currentFiles.push(...hashed);
    if ((index + hashBatchSize) % 1_024 === 0 || index + hashBatchSize >= sourceFiles.length) {
      console.error(`[r2-og-manifest] hashed ${Math.min(index + hashBatchSize, sourceFiles.length)}/${sourceFiles.length} source files`);
    }
  }

  let previous = await loadPreviousManifest(previousManifestPath);
  if (previous.status === 'missing' && r2ManifestEnabled()) {
    previous = await restoreDurableManifest(previousManifestPath);
  }
  const fullPublish = previous.files === null;
  const deferredSlugs = await readDeferredSlugs(deferredSlugsPath);
  const changedFiles = fullPublish
    ? currentFiles
    : currentFiles.filter((file) => previous.files.get(file.path)?.sha256 !== file.sha256);
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const preservedDeferredFiles = fullPublish
    ? []
    : deferredSlugs
      .map((slug) => {
        const filePath = `jobs/${slug}.webp`;
        const previousFile = previous.files.get(filePath);
        if (!previousFile || currentPaths.has(filePath)) return null;
        return previousFile;
      })
      .filter(Boolean);
  const candidateFiles = [...currentFiles, ...preservedDeferredFiles]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const changedBytes = changedFiles.reduce((total, file) => total + file.size, 0);
  await writeChangedFiles(path.resolve(changedFilesPath), changedFiles);
  await writeCandidateManifest(path.resolve(candidatePath), candidateFiles);

  const mode = fullPublish ? 'full' : 'delta';
  process.stdout.write(
    `mode=${mode} previous=${previous.status} total_files=${candidateFiles.length} `
    + `changed_files=${changedFiles.length} changed_bytes=${changedBytes} `
    + `preserved_deferred=${preservedDeferredFiles.length} no_traverse=${changedFiles.length > 0}\n`,
  );
}

async function main() {
  if (process.argv[2] === 'record-progress') {
    const [, , , candidatePath, previousPath, changedPath, completedPath, publishedPath, sourcePath, mode] = process.argv;
    if (!candidatePath || !previousPath || !changedPath || !completedPath || !publishedPath || !sourcePath
      || !['partial', 'complete'].includes(mode)) {
      throw new Error('usage: prepare-r2-og-delta.mjs record-progress <candidate> <previous> <changed-list> <completed-list> <published-manifest> <source-dir> <partial|complete>');
    }
    await recordPublishedProgress({
      candidatePath,
      previousPath,
      changedPath,
      completedPath,
      publishedPath,
      sourcePath,
      complete: mode === 'complete',
    });
    return;
  }

  const [sourceDir, previousManifestPath, changedFilesPath, candidatePath, deferredSlugsPath] = process.argv.slice(2);
  if (!sourceDir || !previousManifestPath || !changedFilesPath || !candidatePath) {
    throw new Error('usage: prepare-r2-og-delta.mjs <source-dir> <previous-manifest> <changed-files> <candidate-manifest> [deferred-slugs.json]');
  }
  await prepareDelta(sourceDir, previousManifestPath, changedFilesPath, candidatePath, deferredSlugsPath);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
