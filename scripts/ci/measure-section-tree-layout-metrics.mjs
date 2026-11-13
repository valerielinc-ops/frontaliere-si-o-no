#!/usr/bin/env node
import { opendir, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const DEFAULT_SECTION_TREE_LIMIT_BYTES = 52_428_800;
const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECTION_SLUGS_PATH = path.join(REPO_ROOT, 'scripts/lib/section-shard-slugs.json');

function checkedTreeLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('SHARD_REMOTE_TREE_LIMIT_BYTES must be a positive safe integer');
  }
  return limit;
}

function treeEntryBytes(name, isDirectory) {
  // Git stores all non-directory modes as six octal characters (100644,
  // 100755, or 120000), and directories as five (40000). Object IDs are
  // always 20 raw bytes in this repository's SHA-1 object format.
  return (isDirectory ? 5 : 6) + 1 + Buffer.byteLength(name, 'utf8') + 1 + 20;
}

async function measureDirectory(directory) {
  let bytes = 0;
  let largest = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entry.isDirectory()) {
      const child = await measureDirectory(path.join(directory, entry.name));
      if (child.bytes > 0) {
        bytes += treeEntryBytes(entry.name, true);
        largest = Math.max(largest, child.largest);
      }
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(`unsupported filesystem entry in section tree: ${path.join(directory, entry.name)}`);
    }
    bytes += treeEntryBytes(entry.name, false);
  }
  largest = Math.max(largest, bytes);
  return { bytes, largest };
}

export async function measureLargestSectionGitTreeBytes(root) {
  try {
    const result = await measureDirectory(root);
    return result.largest;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function measureSectionTreeLayoutMetrics({
  dist,
  locale,
  sourceRunId,
  sourceRunAttempt = 1,
  sourceSha,
  treeLimitBytes = process.env.SHARD_REMOTE_TREE_LIMIT_BYTES || DEFAULT_SECTION_TREE_LIMIT_BYTES,
  slugs,
} = {}) {
  if (!LOCALES.includes(locale)) throw new Error(`unsupported locale: ${locale}`);
  if (typeof sourceRunId !== 'string' || !/^\d+$/u.test(sourceRunId)) throw new Error('sourceRunId must be a decimal run id');
  if (!Number.isSafeInteger(Number(sourceRunAttempt)) || Number(sourceRunAttempt) < 1) throw new Error('sourceRunAttempt must be a positive safe integer');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sourceSha)) throw new Error('sourceSha must be a 40-character Git SHA');
  if (typeof dist !== 'string' || dist.length === 0) throw new Error('dist is required');
  const limit = checkedTreeLimit(treeLimitBytes);
  const sectionSlugs = slugs ?? JSON.parse(await readFile(SECTION_SLUGS_PATH, 'utf8'));
  const sections = {};
  for (const [section, localeSlugs] of Object.entries(sectionSlugs)) {
    if (section.startsWith('_')) continue;
    const slug = localeSlugs?.[locale];
    if (typeof slug !== 'string' || slug.length === 0) throw new Error(`missing section slug for ${section}/${locale}`);
    const sub = locale === 'it' ? slug : path.join(locale, slug);
    const bytes = await measureLargestSectionGitTreeBytes(path.join(dist, sub));
    sections[section] = { bytes, pct: (bytes * 100) / limit };
  }
  return {
    version: 1,
    locale,
    sourceRunId,
    sourceRunAttempt: Number(sourceRunAttempt),
    sourceSha,
    treeLimitBytes: limit,
    sections,
  };
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
}

async function main(args = process.argv.slice(2)) {
  const metrics = await measureSectionTreeLayoutMetrics({
    dist: flag(args, '--dist'),
    locale: flag(args, '--locale'),
    sourceRunId: flag(args, '--source-run-id'),
    sourceRunAttempt: Number(flag(args, '--source-run-attempt')),
    sourceSha: flag(args, '--source-sha'),
    treeLimitBytes: flag(args, '--tree-limit'),
  });
  const out = flag(args, '--out');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(metrics)}\n`);
  process.stdout.write(`measured ${Object.keys(metrics.sections).length} section trees for ${metrics.locale}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
