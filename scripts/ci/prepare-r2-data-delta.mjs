#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const PREFIX = 'data';

function checkDeadline(stage) {
  const rawDeadline = process.env.R2_DATA_DEADLINE_EPOCH_MS;
  if (!rawDeadline) return;
  const deadline = Number(rawDeadline);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error('R2_DATA_DEADLINE_EPOCH_MS must be a positive epoch-millisecond integer');
  }
  if (Date.now() >= deadline) throw new Error(`R2 data phase exceeded its total limit during ${stage}`);
}

function fail(message) {
  console.error(`[r2-data-manifest] ${message}`);
  process.exitCode = 1;
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0
    && !value.includes('\\') && !/[\r\n]/.test(value)
    && !path.posix.isAbsolute(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function listFiles(root) {
  const files = [];
  const directories = [''];
  while (directories.length) {
    checkDeadline('source traversal');
    const relativeDir = directories.pop();
    const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if ((files.length & 255) === 0) checkDeadline('source traversal');
      if (entry.name === '.DS_Store') continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (!safePath(relativePath)) throw new Error(`unsafe data source path: ${relativePath}`);
      const absolutePath = path.join(root, ...relativePath.split('/'));
      if (entry.isSymbolicLink()) throw new Error(`symbolic link in data source: ${relativePath}`);
      if (entry.isDirectory()) directories.push(relativePath);
      else if (entry.isFile()) files.push({ path: relativePath, absolutePath });
      else throw new Error(`unsupported data entry: ${relativePath}`);
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function hashFile(filePath) {
  checkDeadline('source hashing');
  const before = await fs.stat(filePath);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    checkDeadline('source hashing');
    hash.update(chunk);
    size += chunk.length;
  }
  const after = await fs.stat(filePath);
  if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`data source changed while hashing: ${filePath}`);
  }
  checkDeadline('source hashing');
  return { sha256: hash.digest('hex'), size };
}

function parseManifest(raw) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return null; }
  if (!manifest || manifest.version !== VERSION || manifest.prefix !== PREFIX || !Array.isArray(manifest.files)) return null;
  const files = new Map();
  for (const file of manifest.files) {
    if (!file || !safePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || files.has(file.path)) return null;
    files.set(file.path, { path: file.path, sha256: file.sha256, size: file.size });
  }
  return files;
}

async function loadManifest(filePath) {
  try {
    const files = parseManifest(await fs.readFile(filePath, 'utf8'));
    return files ? { files, status: 'valid' } : { files: null, status: 'invalid' };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { files: null, status: 'missing' }
      : { files: null, status: 'invalid' };
  }
}

function manifestObject(files, buildId) {
  return {
    version: VERSION,
    prefix: PREFIX,
    buildId: buildId ?? null,
    files: [...files.values()]
      .map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function pathSet(raw, label) {
  const paths = raw.split(/\r?\n/).filter(Boolean);
  const result = new Set();
  for (const filePath of paths) {
    if (!safePath(filePath) || result.has(filePath)) throw new Error(`${label} has an unsafe or duplicate path: ${filePath}`);
    result.add(filePath);
  }
  return result;
}

async function prepare(sourceDir, previousPath, changedPath, candidatePath) {
  checkDeadline('manifest preparation');
  const root = path.resolve(sourceDir);
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`data source is not a directory: ${sourceDir}`);
  const files = [];
  const sourceFiles = await listFiles(root);
  for (let offset = 0; offset < sourceFiles.length; offset += 64) {
    checkDeadline('source hashing');
    const batch = sourceFiles.slice(offset, offset + 64);
    files.push(...await Promise.all(batch.map(async (file) => ({ path: file.path, ...(await hashFile(file.absolutePath)) }))));
    if ((offset + 64) % 1024 === 0 || offset + 64 >= sourceFiles.length) {
      console.error(`[r2-data-manifest] hashed ${Math.min(offset + 64, sourceFiles.length)}/${sourceFiles.length} source files`);
    }
  }
  const previous = await loadManifest(previousPath);
  const full = previous.files === null;
  const changed = full ? files : files.filter((file) => {
    const prior = previous.files.get(file.path);
    return prior?.sha256 !== file.sha256 || prior?.size !== file.size;
  });
  // R2 copy is additive. Keep fingerprints of old keys so a later reappearing
  // source file remains part of the published state until the janitor removes it.
  const candidate = previous.files ? new Map(previous.files) : new Map();
  for (const file of files) candidate.set(file.path, file);
  await writeAtomic(changedPath, changed.map((file) => file.path).join('\n') + (changed.length ? '\n' : ''));
  await writeAtomic(candidatePath, `${JSON.stringify(manifestObject(candidate, process.env.DEPLOY_BUILD_ID))}\n`);
  const changedBytes = changed.reduce((total, file) => total + file.size, 0);
  checkDeadline('manifest write');
  process.stdout.write(`mode=${full ? 'full' : 'delta'} previous=${previous.status} total_files=${candidate.size} changed_files=${changed.length} changed_bytes=${changedBytes}\n`);
}

async function recordProgress(candidatePath, previousPath, changedPath, completedPath, publishedPath, sourceDir, complete) {
  checkDeadline('checkpoint verification');
  const raw = await fs.readFile(candidatePath, 'utf8');
  const candidate = JSON.parse(raw);
  const candidateFiles = parseManifest(raw);
  if (!candidateFiles) throw new Error('candidate data manifest is invalid; refusing to checkpoint');
  const changed = pathSet(await fs.readFile(changedPath, 'utf8'), 'changed data list');
  // `completedPath` contains only the most recently uploaded checkpoint group.
  // The previous manifest advances after each successful remote checkpoint,
  // so earlier groups are already proven and must not be re-hashed here.
  const completed = pathSet(await fs.readFile(completedPath, 'utf8'), 'completed data list');
  const previous = await loadManifest(previousPath);
  for (const filePath of changed) {
    checkDeadline('checkpoint verification');
    if (!candidateFiles.has(filePath)) throw new Error(`changed data path is absent from candidate: ${filePath}`);
  }
  for (const filePath of completed) {
    checkDeadline('checkpoint verification');
    if (!changed.has(filePath)) throw new Error(`completed data path was not changed: ${filePath}`);
    const expected = candidateFiles.get(filePath);
    const alreadyPublished = previous.files?.get(filePath);
    if (alreadyPublished?.sha256 === expected.sha256 && alreadyPublished.size === expected.size) continue;
    const actual = await hashFile(path.join(sourceDir, ...filePath.split('/')));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`completed data source no longer matches candidate: ${filePath}`);
    }
  }
  const publishedSoFar = previous.files ? new Map(previous.files) : new Map();
  for (const filePath of completed) publishedSoFar.set(filePath, candidateFiles.get(filePath));
  let published;
  if (complete) {
    for (const filePath of changed) {
      checkDeadline('complete-manifest verification');
      const checkpointed = publishedSoFar.get(filePath);
      const expected = candidateFiles.get(filePath);
      if (checkpointed?.sha256 !== expected.sha256 || checkpointed.size !== expected.size) {
        throw new Error(`cannot complete data manifest: ${filePath} has no verified checkpoint`);
      }
    }
    published = candidateFiles;
  } else {
    published = publishedSoFar;
  }
  checkDeadline('checkpoint manifest write');
  await writeAtomic(publishedPath, `${JSON.stringify(manifestObject(published, candidate.buildId))}\n`);
  process.stdout.write(`published_files=${published.size} completed_changed=${completed.size} candidate_files=${candidateFiles.size} complete=${complete}\n`);
}

async function main() {
  if (process.argv[2] === 'record-progress') {
    const [, , , candidate, previous, changed, completed, published, source, mode] = process.argv;
    if (!candidate || !previous || !changed || !completed || !published || !source || !['partial', 'complete'].includes(mode)) {
      throw new Error('usage: prepare-r2-data-delta.mjs record-progress <candidate> <previous> <changed> <completed> <published> <source> <partial|complete>');
    }
    await recordProgress(candidate, previous, changed, completed, published, source, mode === 'complete');
    return;
  }
  const [source, previous, changed, candidate] = process.argv.slice(2);
  if (!source || !previous || !changed || !candidate) {
    throw new Error('usage: prepare-r2-data-delta.mjs <source> <previous> <changed> <candidate>');
  }
  await prepare(source, previous, changed, candidate);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
