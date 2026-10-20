#!/usr/bin/env node
import { mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { ticinoTreeBucket } from '../../infra/cloudflare-worker/ticino-tree-bucket.js';

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

const [command, root] = process.argv.slice(2);
try {
  if (!root || !['fanout', 'unfanout'].includes(command)) {
    throw new Error('Usage: ticino-tree-fanout.mjs <fanout|unfanout> <section-root>');
  }
  if (command === 'fanout') fanoutTicinoTree(root);
  else unfanoutTicinoTree(root);
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
