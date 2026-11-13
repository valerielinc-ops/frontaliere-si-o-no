#!/usr/bin/env node
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SECTION_TREE_FANOUT_SECTIONS,
  legacyTicinoTreeBucket,
  sectionTreeBucket,
  sectionUsesHashFanout as sectionUsesStaticHashFanout,
} from '../../infra/cloudflare-worker/ticino-tree-bucket.js';
import { isInvokedDirectly } from './is-invoked-directly.mjs';

export { SECTION_TREE_FANOUT_SECTIONS };

export function sectionTreeLayoutSectionsFromEnv(value = process.env.SECTION_TREE_LAYOUT_SECTIONS_JSON) {
  if (value === undefined || value === '') return new Set(SECTION_TREE_FANOUT_SECTIONS);
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('SECTION_TREE_LAYOUT_SECTIONS_JSON must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.some((section) => typeof section !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(section))) {
    throw new Error('SECTION_TREE_LAYOUT_SECTIONS_JSON must contain section names');
  }
  return new Set([...SECTION_TREE_FANOUT_SECTIONS, ...parsed]);
}

export function sectionUsesHashFanout(section, fannedSections = sectionTreeLayoutSectionsFromEnv()) {
  return sectionUsesStaticHashFanout(section) || fannedSections.has(section);
}

export function sectionTreePhysicalPath(section, relativePath, fannedSections = sectionTreeLayoutSectionsFromEnv()) {
  if (!sectionUsesHashFanout(section, fannedSections)) return relativePath;
  if (relativePath === 'index.html') return relativePath;
  const separator = relativePath.indexOf('/');
  const entry = separator === -1 ? relativePath : relativePath.slice(0, separator);
  if (!entry || entry === 'index.html') return relativePath;
  const suffix = separator === -1 ? '' : relativePath.slice(separator);
  return `_tree/${sectionTreeBucket(entry)}/${entry}${suffix}`;
}

export function ticinoTreePhysicalPath(relativePath) {
  return sectionTreePhysicalPath('ticino', relativePath);
}

export function fanoutSectionTree(root) {
  const fanoutRoot = join(root, '_tree');
  const names = readdirSync(root);
  if (names.includes('_tree')) throw new Error(`Section fan-out destination already exists: ${fanoutRoot}`);
  mkdirSync(fanoutRoot);

  const createdBuckets = new Set();
  for (const name of names) {
    if (name === 'index.html') continue;
    const bucketName = sectionTreeBucket(name);
    const bucket = join(fanoutRoot, bucketName);
    if (!createdBuckets.has(bucketName)) {
      mkdirSync(bucket);
      createdBuckets.add(bucketName);
    }
    renameSync(join(root, name), join(bucket, name));
  }
}

export function fanoutTicinoTree(root) {
  return fanoutSectionTree(root);
}

export function unfanoutSectionTree(root) {
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
    if (!bucket.isDirectory()) throw new Error(`Unexpected entry in section fan-out: ${join(fanoutRoot, bucket.name)}`);
    const bucketPath = join(fanoutRoot, bucket.name);
    for (const name of readdirSync(bucketPath)) {
      const target = join(root, name);
      if (rootEntries.has(name)) throw new Error(`Section unfan-out would overwrite an existing entry: ${target}`);
      renameSync(join(bucketPath, name), target);
      rootEntries.add(name);
    }
    rmdirSync(bucketPath);
  }
  rmdirSync(fanoutRoot);
}

export function unfanoutTicinoTree(root) {
  return unfanoutSectionTree(root);
}

function mapSectionRelativePath(section, relativePath, layout) {
  if (layout === 'hash-v1') {
    if (relativePath.startsWith('_tree/')) {
      const rest = relativePath.slice('_tree/'.length);
      const bucketSeparator = rest.indexOf('/');
      if (bucketSeparator === -1) throw new Error(`invalid hash-fanout path: ${relativePath}`);
      const bucket = rest.slice(0, bucketSeparator);
      const entryAndSuffix = rest.slice(bucketSeparator + 1);
      const entrySeparator = entryAndSuffix.indexOf('/');
      const entry = entrySeparator === -1 ? entryAndSuffix : entryAndSuffix.slice(0, entrySeparator);
      const expectedBucket = sectionTreeBucket(entry);
      if (!entry || (bucket !== expectedBucket && !(section === 'ticino' && bucket === legacyTicinoTreeBucket(entry)))) {
        throw new Error(`invalid hash-fanout bucket for ${relativePath}`);
      }
      return relativePath;
    }
    return sectionTreePhysicalPath('ticino', relativePath, new Set(SECTION_TREE_FANOUT_SECTIONS));
  }
  if (layout !== 'canonical') throw new Error(`unsupported section tree layout: ${layout}`);
  if (!relativePath.startsWith('_tree/')) return relativePath;

  const rest = relativePath.slice('_tree/'.length);
  const bucketSeparator = rest.indexOf('/');
  if (bucketSeparator === -1) throw new Error(`invalid hash-fanout path: ${relativePath}`);
  const bucket = rest.slice(0, bucketSeparator);
  const entryAndSuffix = rest.slice(bucketSeparator + 1);
  const entrySeparator = entryAndSuffix.indexOf('/');
  const entry = entrySeparator === -1 ? entryAndSuffix : entryAndSuffix.slice(0, entrySeparator);
  if (!entry) throw new Error(`invalid hash-fanout path: ${relativePath}`);
  const expectedBucket = sectionTreeBucket(entry);
  if (bucket !== expectedBucket && !(section === 'ticino' && bucket === legacyTicinoTreeBucket(entry))) {
    throw new Error(`invalid hash-fanout bucket for ${relativePath}`);
  }
  const suffix = entrySeparator === -1 ? '' : entryAndSuffix.slice(entrySeparator);
  return `${entry}${suffix}`;
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

function forEachNulRecord(file, visit) {
  const fd = openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (size === 0) break;
      const input = pending.length === 0 ? chunk.subarray(0, size) : Buffer.concat([pending, chunk.subarray(0, size)]);
      let start = 0;
      while (true) {
        const separator = input.indexOf(0, start);
        if (separator === -1) {
          pending = Buffer.from(input.subarray(start));
          break;
        }
        visit(input.subarray(start, separator));
        start = separator + 1;
      }
    }
    if (pending.length > 0) visit(pending);
  } finally {
    closeSync(fd);
  }
}

function gitIndex(stage, args, { env = process.env, stdoutFd = 'ignore', stdinFd = 'ignore' } = {}) {
  const result = spawnSync('git', ['-C', stage, ...args], {
    env,
    stdio: [stdinFd, stdoutFd, 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const error = result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`git ${args[0]} failed: ${error}`);
  }
}

/** Rewrite only the section subtree in the active Git index, streaming paths to disk. */
export function rewriteSectionTreeIndex(stage, section, prefix, targetLayout) {
  if (!['hash-v1', 'canonical'].includes(targetLayout)) throw new Error(`unsupported target layout: ${targetLayout}`);
  const work = mkdtempSync(join(tmpdir(), 'section-tree-index-'));
  const listed = join(work, 'index-records.z');
  const deletions = join(work, 'deletions.info');
  const updates = join(work, 'updates.info');
  const listedFd = openSync(listed, 'w');
  let deleteFd;
  let updateFd;
  let moved = 0;
  try {
    gitIndex(stage, ['ls-files', '--stage', '-z'], { stdoutFd: listedFd });
    closeSync(listedFd);
    deleteFd = openSync(deletions, 'w');
    updateFd = openSync(updates, 'w');
    const sectionPrefix = `${prefix.replace(/\/+$/u, '')}/`;
    forEachNulRecord(listed, (record) => {
      const tab = record.indexOf(9);
      if (tab < 0) throw new Error('invalid git ls-files index record');
      const metadata = record.subarray(0, tab).toString('ascii').split(' ');
      const [mode, oid, stageNumber] = metadata;
      if (!mode || !/^[0-9a-f]{40,64}$/u.test(oid ?? '') || stageNumber !== '0') {
        throw new Error('refusing to rewrite an unmerged or malformed Git index entry');
      }
      const pathBuffer = record.subarray(tab + 1);
      const path = pathBuffer.toString('utf8');
      if (!path.startsWith(sectionPrefix)) return;
      const relative = path.slice(sectionPrefix.length);
      const mappedRelative = mapSectionRelativePath(section, relative, targetLayout);
      if (mappedRelative === relative) return;
      const mappedPath = `${sectionPrefix}${mappedRelative}`;
      writeAll(deleteFd, Buffer.from(`0 ${'0'.repeat(oid.length)} 0\t${path}\0`));
      writeAll(updateFd, Buffer.from(`${mode} ${oid} 0\t${mappedPath}\0`));
      moved += 1;
    });
    closeSync(deleteFd);
    closeSync(updateFd);
    if (moved > 0) {
      const inputDelete = openSync(deletions, 'r');
      try { gitIndex(stage, ['update-index', '-z', '--index-info'], { stdinFd: inputDelete }); }
      finally { closeSync(inputDelete); }
      const inputUpdate = openSync(updates, 'r');
      try { gitIndex(stage, ['update-index', '-z', '--index-info'], { stdinFd: inputUpdate }); }
      finally { closeSync(inputUpdate); }
    }
    return moved;
  } finally {
    try { closeSync(listedFd); } catch { /* already closed */ }
    if (deleteFd !== undefined) { try { closeSync(deleteFd); } catch { /* already closed */ } }
    if (updateFd !== undefined) { try { closeSync(updateFd); } catch { /* already closed */ } }
    rmSync(work, { recursive: true, force: true });
  }
}

async function writeStdout(chunk) {
  if (process.stdout.write(chunk)) return;
  await once(process.stdout, 'drain');
}

async function mapPathStream(section = 'ticino') {
  const fannedSections = sectionTreeLayoutSectionsFromEnv();
  let pending = Buffer.alloc(0);

  for await (const chunk of process.stdin) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;

    while (start < input.length) {
      const separator = input.indexOf(0, start);
      if (separator === -1) {
        pending = pending.length === 0
          ? input.subarray(start)
          : Buffer.concat([pending, input.subarray(start)]);
        break;
      }

      const record = pending.length === 0
        ? input.subarray(start, separator)
        : Buffer.concat([pending, input.subarray(start, separator)]);
      pending = Buffer.alloc(0);
      if (record.length > 0) {
        await writeStdout(`${sectionTreePhysicalPath(section, record.toString('utf8'), fannedSections)}\0`);
      }
      start = separator + 1;
    }
  }

  if (pending.length > 0) {
    await writeStdout(`${sectionTreePhysicalPath(section, pending.toString('utf8'), fannedSections)}\0`);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  await (async () => {
    const [command, firstArgument] = process.argv.slice(2);
    try {
      if (command === 'is-fanned') {
        if (!firstArgument) throw new Error('Usage: ticino-tree-fanout.mjs is-fanned <section>');
        process.stdout.write(`${sectionUsesHashFanout(firstArgument) ? 'true' : 'false'}\n`);
      } else if (command === 'index-layout') {
        const [stage, section, prefix, targetLayout] = process.argv.slice(3);
        if (!stage || !section || !prefix || !targetLayout) {
          throw new Error('Usage: ticino-tree-fanout.mjs index-layout <stage> <section> <prefix> <hash-v1|canonical>');
        }
        process.stdout.write(`${JSON.stringify({ moved: rewriteSectionTreeIndex(stage, section, prefix, targetLayout) })}\n`);
      } else if (command === 'map-paths') {
        await mapPathStream(firstArgument || 'ticino');
      } else if (!firstArgument || !['fanout', 'unfanout'].includes(command)) {
        throw new Error('Usage: ticino-tree-fanout.mjs <fanout|unfanout> <section-root> | map-paths [section] | is-fanned <section> | index-layout <stage> <section> <prefix> <layout>');
      } else if (command === 'fanout') {
        fanoutTicinoTree(firstArgument);
      } else {
        unfanoutTicinoTree(firstArgument);
      }
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
}
