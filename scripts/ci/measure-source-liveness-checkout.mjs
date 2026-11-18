#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [parentFullArg, parentSparseArg, headFullArg, headSparseArg] = process.argv.slice(2);

if (!parentFullArg || !parentSparseArg || !headFullArg || !headSparseArg) {
  console.error(
    'Usage: measure-source-liveness-checkout.mjs <parent-full> <parent-sparse> <head-full> <head-sparse>',
  );
  process.exit(2);
}

function absoluteDirectory(value, label) {
  const directory = path.resolve(value);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} checkout directory is missing: ${value}`);
  }
  return directory;
}

function gitDirectory(directory) {
  const gitEntry = path.join(directory, '.git');
  const gitStat = fs.lstatSync(gitEntry);
  if (gitStat.isDirectory()) return gitEntry;
  return path.resolve(directory, fs.readFileSync(gitEntry, 'utf8').trim().replace(/^gitdir:\s*/u, ''));
}

function revision(directory) {
  const gitDir = gitDirectory(directory);
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;

  const ref = head.slice('ref: '.length);
  const looseRef = path.join(gitDir, ref);
  if (fs.existsSync(looseRef)) return fs.readFileSync(looseRef, 'utf8').trim();

  const packedRefs = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
  const packedLine = packedRefs.split('\n').find((line) => line.endsWith(` ${ref}`));
  if (packedLine) return packedLine.split(' ', 1)[0];
  throw new Error(`cannot resolve HEAD ref ${ref}`);
}

function measureWorkingTree(directory) {
  const pending = [directory];
  let bytes = 0;
  let files = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      const stat = fs.lstatSync(child);
      files += 1;
      bytes += stat.size;
    }
  }

  return { bytes, files };
}

function formatGigabytes(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(3)} GB`;
}

function reduction(full, sparse) {
  if (sparse.bytes >= full.bytes) {
    throw new Error(`sparse checkout is not smaller: full=${full.bytes} sparse=${sparse.bytes}`);
  }
  return ((full.bytes - sparse.bytes) / full.bytes) * 100;
}

function printProfile(label, ref, full, sparse) {
  const delta = reduction(full, sparse);
  console.log(`${label} ref: ${ref}`);
  console.log(
    `${label} full checkout: ${full.bytes} bytes (${formatGigabytes(full.bytes)}), ${full.files} files`,
  );
  console.log(
    `${label} sparse checkout: ${sparse.bytes} bytes (${formatGigabytes(sparse.bytes)}), ${sparse.files} files`,
  );
  console.log(`${label} working-tree reduction: ${delta.toFixed(2)}%`);
  return delta;
}

try {
  const parentFull = absoluteDirectory(parentFullArg, 'parent full');
  const parentSparse = absoluteDirectory(parentSparseArg, 'parent sparse');
  const headFull = absoluteDirectory(headFullArg, 'HEAD full');
  const headSparse = absoluteDirectory(headSparseArg, 'HEAD sparse');

  const parentRevision = revision(parentFull);
  if (revision(parentSparse) !== parentRevision) {
    throw new Error('parent full/sparse checkout HEAD mismatch');
  }
  const headRevision = revision(headFull);
  if (revision(headSparse) !== headRevision) {
    throw new Error('HEAD full/sparse checkout HEAD mismatch');
  }

  const parentFullMeasurement = measureWorkingTree(parentFull);
  const parentSparseMeasurement = measureWorkingTree(parentSparse);
  const headFullMeasurement = measureWorkingTree(headFull);
  const headSparseMeasurement = measureWorkingTree(headSparse);

  console.log('source-liveness checkout measurements on one runner and one checkout phase');
  printProfile('parent', parentRevision, parentFullMeasurement, parentSparseMeasurement);
  printProfile('HEAD', headRevision, headFullMeasurement, headSparseMeasurement);

  if (headSparseMeasurement.bytes >= parentSparseMeasurement.bytes) {
    throw new Error(
      `HEAD sparse checkout is not smaller than parent sparse checkout: parent=${parentSparseMeasurement.bytes} HEAD=${headSparseMeasurement.bytes}`,
    );
  }
  const crossReduction = ((parentSparseMeasurement.bytes - headSparseMeasurement.bytes)
    / parentSparseMeasurement.bytes) * 100;
  console.log(`HEAD sparse working-tree delta vs parent sparse: ${crossReduction.toFixed(2)}%`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
