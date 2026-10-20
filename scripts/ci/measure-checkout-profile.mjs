#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [fullArg, sparseArg] = process.argv.slice(2);

if (!fullArg || !sparseArg) {
  console.error('Usage: measure-checkout-profile.mjs <full-checkout> <sparse-checkout>');
  process.exit(2);
}

function absoluteDirectory(value, label) {
  const directory = path.resolve(value);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} checkout directory is missing: ${value}`);
  }
  return directory;
}

function revision(directory) {
  const gitEntry = path.join(directory, '.git');
  const gitStat = fs.lstatSync(gitEntry);
  const gitDirectory = gitStat.isDirectory()
    ? gitEntry
    : path.resolve(directory, fs.readFileSync(gitEntry, 'utf8').trim().replace(/^gitdir:\s*/u, ''));
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;

  const ref = head.slice('ref: '.length);
  const looseRef = path.join(gitDirectory, ref);
  if (fs.existsSync(looseRef)) return fs.readFileSync(looseRef, 'utf8').trim();

  const packedRefs = fs.readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8');
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

try {
  const full = absoluteDirectory(fullArg, 'full');
  const sparse = absoluteDirectory(sparseArg, 'sparse');
  const fullRevision = revision(full);
  const sparseRevision = revision(sparse);

  if (fullRevision !== sparseRevision) {
    throw new Error(`checkout HEAD mismatch: full=${fullRevision} sparse=${sparseRevision}`);
  }

  const fullMeasurement = measureWorkingTree(full);
  const sparseMeasurement = measureWorkingTree(sparse);
  if (sparseMeasurement.bytes >= fullMeasurement.bytes) {
    throw new Error(
      `sparse checkout is not smaller: full=${fullMeasurement.bytes} sparse=${sparseMeasurement.bytes}`,
    );
  }

  const reduction = ((fullMeasurement.bytes - sparseMeasurement.bytes) / fullMeasurement.bytes) * 100;
  console.log(`checkout measurements on the same HEAD: ${fullRevision}`);
  console.log(
    `full checkout: ${fullMeasurement.bytes} bytes (${formatGigabytes(fullMeasurement.bytes)}), ${fullMeasurement.files} files`,
  );
  console.log(
    `issue-fix sparse checkout: ${sparseMeasurement.bytes} bytes (${formatGigabytes(sparseMeasurement.bytes)}), ${sparseMeasurement.files} files`,
  );
  console.log(`working-tree reduction: ${reduction.toFixed(2)}%`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
