#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MANIFEST_VERSION = 1;
// Small deltas favor one destination lookup per changed file; broad rebuilds
// keep rclone's recursive inventory instead of issuing thousands of lookups.
const NO_TRAVERSE_MAX_CHANGED_FILES = 1_000;
const NO_TRAVERSE_MAX_CHANGED_RATIO = 0.1;

function fail(message) {
  console.error(`[r2-og-manifest] ${message}`);
  process.exitCode = 1;
}

function isSafeRelativePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\\')) return false;
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
    files.set(file.path, { sha256: file.sha256, size: file.size });
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

async function copyChangedFiles(changedFiles, deltaDir) {
  await fs.rm(deltaDir, { recursive: true, force: true });
  if (changedFiles.length === 0) return;

  await fs.mkdir(deltaDir, { recursive: true });
  const batchSize = 128;
  for (let index = 0; index < changedFiles.length; index += batchSize) {
    const batch = changedFiles.slice(index, index + batchSize);
    await Promise.all(batch.map(async (file) => {
      const targetPath = path.join(deltaDir, ...file.path.split('/'));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(file.absolutePath, targetPath);
    }));
  }
}

async function writeCandidateManifest(candidatePath, files) {
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  const temporaryPath = `${candidatePath}.tmp-${process.pid}`;
  const manifest = {
    version: MANIFEST_VERSION,
    buildId: process.env.DEPLOY_BUILD_ID || null,
    files: files.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })),
  };
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, candidatePath);
}

async function main() {
  const [sourceDir, previousManifestPath, deltaDir, candidatePath] = process.argv.slice(2);
  if (!sourceDir || !previousManifestPath || !deltaDir || !candidatePath) {
    throw new Error('usage: prepare-r2-og-delta.mjs <source-dir> <previous-manifest> <delta-dir> <candidate-manifest>');
  }

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
      absolutePath: file.absolutePath,
    })));
    currentFiles.push(...hashed);
  }

  const previous = await loadPreviousManifest(previousManifestPath);
  const fullPublish = previous.files === null;
  const changedFiles = fullPublish
    ? currentFiles
    : currentFiles.filter((file) => previous.files.get(file.path)?.sha256 !== file.sha256);
  const changedBytes = changedFiles.reduce((total, file) => total + file.size, 0);
  const noTraverseLimit = Math.min(
    NO_TRAVERSE_MAX_CHANGED_FILES,
    Math.ceil(currentFiles.length * NO_TRAVERSE_MAX_CHANGED_RATIO),
  );
  const noTraverse = !fullPublish && changedFiles.length > 0 && changedFiles.length <= noTraverseLimit;

  if (!fullPublish) await copyChangedFiles(changedFiles, path.resolve(deltaDir));
  await writeCandidateManifest(path.resolve(candidatePath), currentFiles);

  const mode = fullPublish ? 'full' : 'delta';
  process.stdout.write(
    `mode=${mode} previous=${previous.status} total_files=${currentFiles.length} `
    + `changed_files=${changedFiles.length} changed_bytes=${changedBytes} `
    + `no_traverse=${noTraverse}\n`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
