#!/usr/bin/env node
/**
 * Observer: a posting that leaves the active job set must stay reachable as an
 * expired soft-landing, i.e. land in the expired archive WITH its title.
 *
 * Without an archive record carrying a title, the build serves the job URL as
 * the noindex «Offerta non verificata · rif. <hash>» stub
 * (build-plugins/shared/jobArchiveEvidence.ts) instead of the indexable
 * soft-landing with title, data and similar jobs. Measured live on 2026-11-12:
 * 26 of the 600 top job pages (5,5% of their clicks) were such stubs, all
 * postings that had been active a week earlier. Città di Locarno, Guess and
 * Sintetica had dropped them through bespoke runners that never archived an
 * ordinary removal (scripts/assemble-jobs-dataset.mjs writeJobsCrawlerSlice).
 *
 * The check compares two revisions of the data (`--base`, `--head`):
 *
 *   retired-unarchived  rows active at base whose slug, at head, is neither
 *                       served by an active row (slug, locale slug or slug
 *                       history) nor by an expired entry with a title;
 *   archive-lost        expired entries with a title at base whose slug, at
 *                       head, has the same lack of coverage — an archive that
 *                       shrinks between two builds (a writer that rewrites the
 *                       expired slice from a partial read, a merge that drops
 *                       records) falls here.
 *
 * Both are printed on every run, with totals per crawler, so the next
 * threshold tightens on a measured number. The default threshold is 0 for
 * both: one job URL turned into a stub is the defect.
 *
 * Usage:
 *   node scripts/ci/check-retired-jobs-archived.mjs --base <rev> [--head <rev>]
 *     [--max-retired-unarchived N] [--max-archive-lost N] [--json <path>]
 *     [--prefetch]
 *
 * `--prefetch` fetches, in bounded packs, the slice blobs of both revisions that
 * a blobless CI checkout does not have yet, through the fetch of
 * scripts/ci/prefetch-history-blobs.mjs (CHECKOUT_TOKEN/GITHUB_TOKEN, REPOSITORY).
 */

import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { isHeldFromPublication } from '../lib/translation-publication-hold.mjs';
import { isSliceFile } from '../lib/crawler-slice-files.mjs';
import { expiredSliceKeyOf } from '../lib/expired-slice-names.mjs';
import { DEFAULT_JSON_STRING_LIMIT, parseLargeJsonArray } from '../lib/read-large-json.mjs';
import { prefetch as prefetchBlobs } from './prefetch-history-blobs.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const ACTIVE_DIR = 'data/jobs/by-crawler';
const EXPIRED_DIR = 'data/jobs/expired/by-crawler';

const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

/** Same identity evidence the build reads (build-plugins/shared/jobArchiveEvidence.ts). */
export function hasArchivedTitle(entry) {
  return nonblank(entry?.title) || Object.values(entry?.titleByLocale || {}).some(nonblank);
}

function addRoutes(target, job, { withHistory }) {
  const add = (value) => {
    if (nonblank(value)) target.add(value.trim());
  };
  add(job?.slug);
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const value of Object.values(job.slugByLocale)) add(value);
  }
  if (!withHistory) return;
  if (Array.isArray(job?.previousSlugs)) job.previousSlugs.forEach(add);
  if (job?.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const values of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(values)) values.forEach(add);
    }
  }
}

/**
 * Pure measurement. Each argument maps a crawler key to the rows of that slice
 * at one revision. Coverage at head is global: a posting handed from one
 * crawler key to another is still served.
 *
 * @param {{
 *   baseActive: Map<string, object[]>,
 *   baseExpired: Map<string, object[]>,
 *   headActive: Map<string, object[]>,
 *   headExpired: Map<string, object[]>,
 * }} input
 */
export function measureRetiredArchiveCoverage({ baseActive, baseExpired, headActive, headExpired }) {
  const served = new Set();
  for (const rows of headActive.values()) {
    for (const job of rows) addRoutes(served, job, { withHistory: true });
  }
  for (const rows of headExpired.values()) {
    for (const entry of rows) {
      if (hasArchivedTitle(entry)) addRoutes(served, entry, { withHistory: true });
    }
  }

  const headActiveSlugs = new Set();
  for (const rows of headActive.values()) {
    for (const job of rows) addRoutes(headActiveSlugs, job, { withHistory: false });
  }

  const retiredUnarchived = [];
  let retired = 0;
  for (const [crawlerKey, rows] of baseActive) {
    for (const job of rows) {
      if (!nonblank(job?.slug)) continue;
      if (typeof job.heldFromPublication === 'boolean' ? job.heldFromPublication : isHeldFromPublication(job)) continue;
      if (headActiveSlugs.has(job.slug.trim())) continue;
      retired++;
      if (served.has(job.slug.trim())) continue;
      retiredUnarchived.push({ crawlerKey, slug: job.slug, title: job.title || '', canton: job.canton || '' });
    }
  }

  const archiveLost = [];
  const seenLost = new Set();
  for (const [crawlerKey, rows] of baseExpired) {
    for (const entry of rows) {
      if (!nonblank(entry?.slug) || !hasArchivedTitle(entry)) continue;
      const slug = entry.slug.trim();
      if (served.has(slug) || seenLost.has(slug)) continue;
      seenLost.add(slug);
      archiveLost.push({ crawlerKey, slug, title: entry.title || '' });
    }
  }

  const countBy = (rows) => {
    const out = {};
    for (const row of rows) out[row.crawlerKey] = (out[row.crawlerKey] || 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  return {
    retired,
    retiredUnarchived,
    retiredUnarchivedByCrawler: countBy(retiredUnarchived),
    archiveLost,
    archiveLostByCrawler: countBy(archiveLost),
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function sliceTree(rev, dir) {
  const out = git(['ls-tree', `${rev}:${dir}`]).trim();
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [meta, name] = line.split('\t');
    // `<key>.shard-NNN.json` belongs to `<key>` (expired-slice-store.mjs).
    return { oid: meta.split(' ')[2], key: expiredSliceKeyOf(name) ?? name.replace(/\.json$/u, ''), name };
  }).filter((entry) => isSliceFile(entry.name));
}

function prefetchMissing(oids) {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return;
  const check = git(['cat-file', '--batch-check'], {
    input: `${unique.join('\n')}\n`,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  const missing = check.split('\n').filter((line) => / missing$/u.test(line)).map((line) => line.split(' ')[0]);
  if (missing.length === 0) return;
  console.log(`📦 Prefetching ${missing.length} slice blob(s) in bounded packs.`);
  prefetchBlobs(missing);
}

/** Streams blobs through one `git cat-file --batch` and parses each slice. */
function createBlobReader() {
  const child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT });
  let buffer = Buffer.alloc(0);
  const waiting = [];
  const drain = () => {
    while (waiting.length > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const header = buffer.subarray(0, newline).toString('utf8');
      if (/ missing$/u.test(header)) {
        buffer = buffer.subarray(newline + 1);
        waiting.shift().reject(new Error(`blob missing: ${header}`));
        continue;
      }
      const size = Number(header.split(' ')[2]);
      if (buffer.length < newline + 1 + size + 1) return;
      const body = buffer.subarray(newline + 1, newline + 1 + size);
      buffer = buffer.subarray(newline + 1 + size + 1);
      waiting.shift().resolve(body);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  // An EOF or a failure of `git cat-file --batch` must reach every pending
  // read() at once; otherwise the run waits for the workflow timeout.
  let failure = null;
  const failAll = (error) => {
    failure = failure || error;
    while (waiting.length > 0) waiting.shift().reject(failure);
  };
  child.on('error', (error) => failAll(new Error(`git cat-file --batch failed: ${error.message}`)));
  child.stdout.on('end', () => failAll(new Error('git cat-file --batch closed its output before answering')));
  child.on('exit', (code, signal) => failAll(new Error(`git cat-file --batch exited (${signal || code})`)));
  child.stdin.on('error', (error) => failAll(new Error(`git cat-file --batch stdin: ${error.message}`)));
  return {
    read(oid) {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        waiting.push({ resolve, reject });
        child.stdin.write(`${oid}\n`);
      });
    },
    close() {
      child.stdin.end();
    },
  };
}

/**
 * Parse one slice blob. Same rule as readJsonFile (#18272): below the V8
 * string limit a plain parse, above it item-wise parsing of the array, and
 * never a silent `[]` — an unreadable slice stops the measurement.
 */
function rowsOf(bytes) {
  if (bytes.length > DEFAULT_JSON_STRING_LIMIT) {
    const decoder = new StringDecoder('utf8');
    const chunks = function* chunked() {
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        yield decoder.write(bytes.subarray(offset, offset + 1024 * 1024));
      }
      yield decoder.end();
    };
    return parseLargeJsonArray(chunks());
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  // Any other root is a malformed slice, not an empty one: counting it as
  // empty would let the observer pass on exactly the data it cannot judge.
  const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
  throw new Error(`unsupported slice root (${shape}${shape === 'object' ? ` with keys ${Object.keys(parsed).slice(0, 5).join(',') || 'none'}` : ''}); expected an array or {jobs: [...]}`);
}

/** Keep only the fields the measurement reads: slices weigh ~2 GB per revision. */
function slim(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    slug: row.slug,
    slugByLocale: row.slugByLocale,
    previousSlugs: row.previousSlugs,
    previousSlugsByLocale: row.previousSlugsByLocale,
    title: typeof row.title === 'string' ? row.title : undefined,
    titleByLocale: row.titleByLocale,
    canton: row.canton,
    // Judged on the whole row: the hold predicate reads more than this slim copy keeps.
    heldFromPublication: isHeldFromPublication(row),
  };
}

async function readRevision(reader, tree) {
  const out = new Map();
  for (const entry of tree) {
    try {
      const rows = rowsOf(await reader.read(entry.oid)).map(slim).filter(Boolean);
      // A sharded archive has several files per key: concatenate them.
      if (out.has(entry.key)) out.get(entry.key).push(...rows);
      else out.set(entry.key, rows);
    } catch (error) {
      throw new Error(`cannot read ${entry.name} (${entry.oid}): ${error.message}`);
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = { head: 'HEAD', maxRetiredUnarchived: 0, maxArchiveLost: 0, json: '', prefetch: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index];
    if (flag === '--base') args.base = value();
    else if (flag === '--head') args.head = value();
    else if (flag === '--max-retired-unarchived') args.maxRetiredUnarchived = Number(value());
    else if (flag === '--max-archive-lost') args.maxArchiveLost = Number(value());
    else if (flag === '--json') args.json = value();
    else if (flag === '--prefetch') args.prefetch = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.base) throw new Error('--base <rev> is required');
  for (const key of ['maxRetiredUnarchived', 'maxArchiveLost']) {
    if (!Number.isInteger(args[key]) || args[key] < 0) throw new Error(`invalid threshold for ${key}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const base = git(['rev-parse', '--verify', `${args.base}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', `${args.head}^{commit}`]).trim();
  const trees = {
    baseActive: sliceTree(base, ACTIVE_DIR),
    baseExpired: sliceTree(base, EXPIRED_DIR),
    headActive: sliceTree(head, ACTIVE_DIR),
    headExpired: sliceTree(head, EXPIRED_DIR),
  };
  if (args.prefetch) prefetchMissing(Object.values(trees).flat().map((entry) => entry.oid));

  const reader = createBlobReader();
  let result;
  try {
    const input = {};
    for (const [name, tree] of Object.entries(trees)) input[name] = await readRevision(reader, tree);
    result = measureRetiredArchiveCoverage(input);
  } finally {
    reader.close();
  }

  const report = {
    base,
    head,
    retired: result.retired,
    retiredUnarchived: result.retiredUnarchived.length,
    archiveLost: result.archiveLost.length,
    thresholds: { retiredUnarchived: args.maxRetiredUnarchived, archiveLost: args.maxArchiveLost },
    retiredUnarchivedByCrawler: result.retiredUnarchivedByCrawler,
    archiveLostByCrawler: result.archiveLostByCrawler,
    retiredUnarchivedSample: result.retiredUnarchived.slice(0, 50),
    archiveLostSample: result.archiveLost.slice(0, 50),
  };
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`🔎 Retired-job archive coverage ${base.slice(0, 12)}..${head.slice(0, 12)}`);
  console.log(`   rows retired from the active set: ${report.retired}`);
  console.log(`   retired WITHOUT an archive record with title: ${report.retiredUnarchived} (max ${args.maxRetiredUnarchived})`);
  console.log(`   archive records with title lost: ${report.archiveLost} (max ${args.maxArchiveLost})`);
  const top = (byCrawler) => Object.entries(byCrawler).slice(0, 15).map(([key, count]) => `${key}×${count}`).join(', ');
  if (report.retiredUnarchived > 0) console.log(`   retired-unarchived by crawler: ${top(report.retiredUnarchivedByCrawler)}`);
  if (report.archiveLost > 0) console.log(`   archive-lost by crawler: ${top(report.archiveLostByCrawler)}`);
  for (const row of result.retiredUnarchived.slice(0, 10)) console.log(`     ↳ retired ${row.crawlerKey}: ${row.slug}`);
  for (const row of result.archiveLost.slice(0, 10)) console.log(`     ↳ lost ${row.crawlerKey}: ${row.slug}`);

  const failed = report.retiredUnarchived > args.maxRetiredUnarchived || report.archiveLost > args.maxArchiveLost;
  if (failed) {
    console.error('❌ Job URLs left the active set without an expired soft-landing: the build will serve them as unverified stubs.');
    console.error('   Recovery: dispatch backfill-expired-from-history.yml (dry_run=false) for the crawlers above.');
  }
  return failed ? 1 : 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
