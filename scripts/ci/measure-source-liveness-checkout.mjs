#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [
  parentFullArg,
  parentSparseArg,
  headFullArg,
  headSparseArg,
  metricsDirArg,
  expectedParentRevisionArg,
  expectedHeadRevisionArg,
] = process.argv.slice(2);

if (
  !parentFullArg
  || !parentSparseArg
  || !headFullArg
  || !headSparseArg
  || !metricsDirArg
  || !expectedParentRevisionArg
  || !expectedHeadRevisionArg
) {
  console.error(
    'Usage: measure-source-liveness-checkout.mjs <parent-full> <parent-sparse> <head-full> <head-sparse> <metrics-dir> <expected-parent-revision> <expected-head-revision>',
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

function readTimestamp(metricsDirectory, checkoutName, suffix) {
  const file = path.join(metricsDirectory, `${checkoutName}.${suffix}`);
  if (!fs.existsSync(file)) throw new Error(`checkout timer is missing: ${file}`);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^\d+$/u.test(value)) throw new Error(`checkout timer is invalid: ${file}`);
  return BigInt(value);
}

function checkoutPhaseMs(metricsDirectory, checkoutName) {
  const start = readTimestamp(metricsDirectory, checkoutName, 'start');
  const end = readTimestamp(metricsDirectory, checkoutName, 'end');
  if (end <= start) throw new Error(`checkout timer does not advance: ${checkoutName}`);
  return Number(end - start) / 1_000_000;
}

function countObjects(directory) {
  const output = execFileSync('git', ['-C', directory, 'count-objects', '-v'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 1_000_000,
  });
  const fields = new Map();
  for (const line of output.split('\n')) {
    const match = /^(count|in-pack|size|size-pack):\s+(\d+)$/u.exec(line);
    if (match) fields.set(match[1], Number(match[2]));
  }
  for (const field of ['count', 'in-pack', 'size', 'size-pack']) {
    if (!fields.has(field)) throw new Error(`git count-objects omitted ${field}: ${directory}`);
  }
  const looseBytes = fields.get('size') * 1024;
  const packBytes = fields.get('size-pack') * 1024;
  return {
    objectCount: fields.get('count') + fields.get('in-pack'),
    looseBytes,
    packBytes,
    objectStoreBytes: looseBytes + packBytes,
  };
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

function formatMegabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(3)} MB`;
}

function reduction(full, sparse) {
  if (sparse.bytes >= full.bytes) {
    throw new Error(`sparse checkout is not smaller: full=${full.bytes} sparse=${sparse.bytes}`);
  }
  return ((full.bytes - sparse.bytes) / full.bytes) * 100;
}

function printDelta(label, metric, baseline, candidate) {
  if (baseline === 0) {
    console.log(`${label} ${metric} delta: unavailable (baseline is zero)`);
    return;
  }
  const delta = ((baseline - candidate) / baseline) * 100;
  console.log(`${label} ${metric} delta: ${delta.toFixed(2)}%`);
}

function printCheckout(profile) {
  const { label, ref, phaseMs, objects, workingTree } = profile;
  console.log(`${label} ref: ${ref}`);
  console.log(`${label} checkout phase: ${phaseMs.toFixed(2)} ms`);
  console.log(`${label} object count: ${objects.objectCount}`);
  console.log(
    `${label} checkout transfer bytes (pack store proxy): ${objects.packBytes} bytes (${formatMegabytes(objects.packBytes)})`,
  );
  console.log(
    `${label} object store bytes: ${objects.objectStoreBytes} bytes (${formatMegabytes(objects.objectStoreBytes)})`,
  );
  console.log(
    `${label} working tree: ${workingTree.bytes} bytes (${formatGigabytes(workingTree.bytes)}), ${workingTree.files} files`,
  );
}

function printWorkingTreePair(label, full, sparse) {
  const delta = reduction(full, sparse);
  console.log(`${label} working-tree reduction: ${delta.toFixed(2)}%`);
  return delta;
}

try {
  const parentFull = absoluteDirectory(parentFullArg, 'parent full');
  const parentSparse = absoluteDirectory(parentSparseArg, 'parent sparse');
  const headFull = absoluteDirectory(headFullArg, 'HEAD full');
  const headSparse = absoluteDirectory(headSparseArg, 'HEAD sparse');
  const metricsDirectory = absoluteDirectory(metricsDirArg, 'metrics');

  const parentRevision = revision(parentFull);
  if (revision(parentSparse) !== parentRevision) {
    throw new Error('parent full/sparse checkout HEAD mismatch');
  }
  const headRevision = revision(headFull);
  if (revision(headSparse) !== headRevision) {
    throw new Error('HEAD full/sparse checkout HEAD mismatch');
  }
  if (parentRevision !== expectedParentRevisionArg) {
    throw new Error(
      `parent checkout revision mismatch: expected ${expectedParentRevisionArg}, actual ${parentRevision}`,
    );
  }
  if (headRevision !== expectedHeadRevisionArg) {
    throw new Error(
      `HEAD checkout revision mismatch: expected ${expectedHeadRevisionArg}, actual ${headRevision}`,
    );
  }

  const parentFullMeasurement = measureWorkingTree(parentFull);
  const parentSparseMeasurement = measureWorkingTree(parentSparse);
  const headFullMeasurement = measureWorkingTree(headFull);
  const headSparseMeasurement = measureWorkingTree(headSparse);

  const profiles = [
    {
      label: 'parent full', ref: parentRevision,
      phaseMs: checkoutPhaseMs(metricsDirectory, 'source-liveness-parent-full'),
      objects: countObjects(parentFull), workingTree: parentFullMeasurement,
    },
    {
      label: 'parent sparse', ref: parentRevision,
      phaseMs: checkoutPhaseMs(metricsDirectory, 'source-liveness-parent-sparse'),
      objects: countObjects(parentSparse), workingTree: parentSparseMeasurement,
    },
    {
      label: 'HEAD full', ref: headRevision,
      phaseMs: checkoutPhaseMs(metricsDirectory, 'source-liveness-head-full'),
      objects: countObjects(headFull), workingTree: headFullMeasurement,
    },
    {
      label: 'HEAD sparse', ref: headRevision,
      phaseMs: checkoutPhaseMs(metricsDirectory, 'source-liveness-head-sparse'),
      objects: countObjects(headSparse), workingTree: headSparseMeasurement,
    },
  ];

  console.log('source-liveness checkout measurements on one runner and one checkout phase');
  for (const profile of profiles) printCheckout(profile);
  printWorkingTreePair(
    'parent', parentFullMeasurement, parentSparseMeasurement,
  );
  printWorkingTreePair(
    'HEAD', headFullMeasurement, headSparseMeasurement,
  );

  if (headSparseMeasurement.bytes >= parentSparseMeasurement.bytes) {
    throw new Error(
      `HEAD sparse checkout is not smaller than parent sparse checkout: parent=${parentSparseMeasurement.bytes} HEAD=${headSparseMeasurement.bytes}`,
    );
  }
  const crossReduction = ((parentSparseMeasurement.bytes - headSparseMeasurement.bytes)
    / parentSparseMeasurement.bytes) * 100;
  console.log(`HEAD sparse working-tree delta vs parent sparse: ${crossReduction.toFixed(2)}%`);
  printDelta(
    'HEAD sparse vs parent sparse',
    'checkout transfer bytes',
    profiles[1].objects.packBytes,
    profiles[3].objects.packBytes,
  );
  printDelta(
    'HEAD sparse vs parent sparse',
    'object count',
    profiles[1].objects.objectCount,
    profiles[3].objects.objectCount,
  );
  printDelta(
    'HEAD sparse vs parent sparse',
    'checkout phase',
    profiles[1].phaseMs,
    profiles[3].phaseMs,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
