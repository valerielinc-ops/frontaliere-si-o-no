#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { ticinoTreeBucket } from '../../infra/cloudflare-worker/ticino-tree-bucket.js';

export function ticinoTreePhysicalPath(relativePath) {
  if (relativePath === 'index.html') return relativePath;
  const separator = relativePath.indexOf('/');
  const entry = separator === -1 ? relativePath : relativePath.slice(0, separator);
  if (!entry || entry === 'index.html') return relativePath;
  const suffix = separator === -1 ? '' : relativePath.slice(separator);
  return `_tree/${ticinoTreeBucket(entry)}/${entry}${suffix}`;
}

export function fanoutTicinoTree(root) {
  const fanoutRoot = join(root, '_tree');
  const names = readdirSync(root);
  if (names.includes('_tree')) throw new Error(`Ticino fan-out destination already exists: ${fanoutRoot}`);
  mkdirSync(fanoutRoot);

  const createdBuckets = new Set();
  for (const name of names) {
    if (name === 'index.html') continue;
    const bucketName = ticinoTreeBucket(name);
    const bucket = join(fanoutRoot, bucketName);
    if (!createdBuckets.has(bucketName)) {
      mkdirSync(bucket);
      createdBuckets.add(bucketName);
    }
    renameSync(join(root, name), join(bucket, name));
  }
}

export function unfanoutTicinoTree(root) {
  const fanoutRoot = join(root, '_tree');
  let buckets;
  try {
    buckets = readdirSync(fanoutRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const rootEntries = new Set(readdirSync(root));
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) throw new Error(`Unexpected entry in Ticino fan-out: ${join(fanoutRoot, bucket.name)}`);
    const bucketPath = join(fanoutRoot, bucket.name);
    for (const name of readdirSync(bucketPath)) {
      const target = join(root, name);
      if (rootEntries.has(name)) throw new Error(`Ticino unfan-out would overwrite an existing entry: ${target}`);
      renameSync(join(bucketPath, name), target);
      rootEntries.add(name);
    }
    rmdirSync(bucketPath);
  }
  rmdirSync(fanoutRoot);
}

function mapPathStream() {
  const input = readFileSync(0, 'utf8');
  const output = input
    .split('\0')
    .filter(Boolean)
    .map(ticinoTreePhysicalPath)
    .join('\0');
  process.stdout.write(output ? `${output}\0` : '');
}

const [command, root] = process.argv.slice(2);
try {
  if (command === 'map-paths') {
    mapPathStream();
  } else if (!root || !['fanout', 'unfanout'].includes(command)) {
    throw new Error('Usage: ticino-tree-fanout.mjs <fanout|unfanout> <section-root>');
  } else if (command === 'fanout') {
    fanoutTicinoTree(root);
  } else {
    unfanoutTicinoTree(root);
  }
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
