#!/usr/bin/env node

/**
 * Prefetch the historical job-slice blobs used by the expired-job backfill.
 *
 * The backfill needs the commit/tree history plus the contents of the two job
 * slice directories at revisions that changed a slice. A blobless checkout
 * keeps commit and tree metadata local. This script finds relevant commits
 * without a path-limited revision walk, resolves only the two slice directory
 * trees at those commits, then fetches and verifies every matching blob in
 * bounded packs before the backfill starts. Metadata discovery and local
 * verification disable partial-clone lazy fetching so only the explicit,
 * bounded fetch downloads historical blobs.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const HISTORY_PATHS = [
  'data/jobs/by-crawler',
  'data/jobs/expired/by-crawler',
];
export const HISTORY_BLOB_PREFETCH_BATCH_SIZE = 8192;
export const HISTORY_TREE_OBJECT_BATCH_SIZE = 100;
const SLICE_PATH_RE = /^data\/jobs\/(?:by-crawler|expired\/by-crawler)\/[^/]+\.json$/u;
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIFF_STATUS_RE = /^(?:[ACDMRTUXB])\d*$/u;
const JSON_SUFFIX_BYTES = Buffer.from('.json');

function runGit(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(historySafeGitErrorMessage(error));
  }
}

export function historySafeGitErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https:\/\/x-access-token:[^@\s]+@github\.com/gu, 'https://github.com');
}

export function historyMetadataEnv(baseEnv = process.env) {
  return { ...baseEnv, GIT_NO_LAZY_FETCH: '1' };
}

function checkoutRemoteUrl() {
  const token = process.env.CHECKOUT_TOKEN || process.env.GITHUB_TOKEN;
  const repository = process.env.REPOSITORY || process.env.GITHUB_REPOSITORY;
  if (!token) throw new Error('CHECKOUT_TOKEN or GITHUB_TOKEN is required to prefetch history blobs.');
  if (!repository || !/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error(`Invalid repository for history blob prefetch: ${repository || '(missing)'}`);
  }
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repository}.git`;
}

/** Commit-only walk: retain --all and the same HISTORY_SINCE cutoff as the backfill. */
export function historyCommitWalkArgs(value = process.env.HISTORY_SINCE) {
  return ['rev-list', '--all', ...historySinceArgs(value)];
}

/** Diff only the two slice families for the already date-bounded commit list. */
export function historyDiffTreeArgs() {
  return [
    'diff-tree',
    '--stdin',
    '-r',
    '--root',
    '-m',
    '--name-status',
    '-z',
    '--no-renames',
    '--',
    ...HISTORY_PATHS,
  ];
}

/**
 * Extract commits that changed a direct JSON slice in either family from
 * `git diff-tree --stdin --name-status -z` output.
 */
export function historyCommitOidsFromDiffTree(output) {
  const tokens = String(output).split('\0');
  const commits = new Set();
  let currentCommit = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (OID_RE.test(token)) {
      currentCommit = token;
      continue;
    }

    if (!DIFF_STATUS_RE.test(token)) continue;
    const status = token[0];
    const pathCount = status === 'R' || status === 'C' ? 2 : 1;
    const paths = tokens.slice(index + 1, index + 1 + pathCount);
    if (currentCommit && paths.some((changedPath) => SLICE_PATH_RE.test(changedPath))) {
      commits.add(currentCommit);
    }
    index += pathCount;
  }

  return [...commits];
}

/** Both directory snapshots are inspected for each relevant commit. */
export function historySliceTreeRefInput(commitOids) {
  return commitOids.length === 0
    ? ''
    : `${commitOids.flatMap((oid) => HISTORY_PATHS.map((treePath) => `${oid}:${treePath}`)).join('\n')}\n`;
}

/** Extract distinct directory tree OIDs, allowing a path to be absent at older commits. */
export function historyTreeOidsFromBatchCheck(output) {
  const treeOids = new Set();
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?) tree \d+$/u);
    if (match) {
      treeOids.add(match[1]);
      continue;
    }
    if (line.endsWith(' missing')) continue;
    throw new Error('Could not resolve a historical job-slice directory tree.');
  }
  return [...treeOids];
}

/** Split unique tree objects into bounded reads, preserving every tree OID. */
export function historyTreeOidBatches(treeOids, batchSize = HISTORY_TREE_OBJECT_BATCH_SIZE) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('History tree batch size must be a positive integer.');
  }
  const uniqueOids = [...new Set(treeOids)];
  return Array.from({ length: Math.ceil(uniqueOids.length / batchSize) }, (_, index) =>
    uniqueOids.slice(index * batchSize, (index + 1) * batchSize));
}

/** Read direct JSON blob OIDs from one or more binary Git tree objects. */
export function historyBlobOidsFromTreeBatch(output) {
  const data = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const blobOids = [];
  let offset = 0;

  while (offset < data.length) {
    const headerEnd = data.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('Malformed Git tree batch response header.');
    const header = data.subarray(offset, headerEnd).toString('ascii').split(' ');
    offset = headerEnd + 1;
    if (header.length !== 3 || header[1] !== 'tree') {
      throw new Error('A historical job-slice tree could not be read locally.');
    }

    const oidBytes = header[0].length / 2;
    const size = Number(header[2]);
    const bodyEnd = offset + size;
    if (![20, 32].includes(oidBytes) || !Number.isSafeInteger(size) || size < 0 || bodyEnd >= data.length) {
      throw new Error('Malformed Git tree batch response body.');
    }

    const body = data.subarray(offset, bodyEnd);
    let treeOffset = 0;
    while (treeOffset < body.length) {
      const modeEnd = body.indexOf(0x20, treeOffset);
      const nameEnd = body.indexOf(0x00, modeEnd + 1);
      const oidStart = nameEnd + 1;
      const entryEnd = oidStart + oidBytes;
      if (modeEnd < 0 || nameEnd < 0 || entryEnd > body.length) {
        throw new Error('Malformed historical job-slice tree entry.');
      }

      const mode = body.subarray(treeOffset, modeEnd).toString('ascii');
      const name = body.subarray(modeEnd + 1, nameEnd);
      const isBlob = mode === '100644' || mode === '100755' || mode === '120000';
      if (isBlob && name.length >= JSON_SUFFIX_BYTES.length && name.subarray(-JSON_SUFFIX_BYTES.length).equals(JSON_SUFFIX_BYTES)) {
        blobOids.push(body.subarray(oidStart, entryEnd).toString('hex'));
      }
      treeOffset = entryEnd;
    }

    offset = bodyEnd;
    if (data[offset] !== 0x0a) throw new Error('Malformed Git tree batch response delimiter.');
    offset += 1;
  }

  return blobOids;
}

/**
 * Build one HTTPS-capable fetch invocation for the requested reachable objects.
 * `fetch-pack` does not dispatch an HTTPS URL through Git's transport helpers;
 * `fetch --stdin` sends each full object id as an object want.
 */
export function historyBlobPrefetchArgs(remote) {
  return ['fetch', '--keep', '--no-progress', '--no-tags', '--no-write-fetch-head', '--stdin', remote];
}

export function historyBlobPrefetchInput(oids) {
  return oids.length > 0 ? `${oids.join('\n')}\n` : '';
}

/** Deduplicate object ids, then split them into bounded fetch requests. */
export function historyBlobOidBatches(oids, batchSize = HISTORY_BLOB_PREFETCH_BATCH_SIZE) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('History blob prefetch batch size must be a positive integer.');
  }

  const uniqueOids = [...new Set(oids)];
  for (const oid of uniqueOids) {
    if (!OID_RE.test(oid)) throw new TypeError('History blob prefetch received an invalid object id.');
  }
  return Array.from({ length: Math.ceil(uniqueOids.length / batchSize) }, (_, index) =>
    uniqueOids.slice(index * batchSize, (index + 1) * batchSize));
}

/** Fetch every batch, then verify the complete unique set before callers walk history. */
export function prefetchAndVerifyBlobs(oids, { fetchBatch, verify, batchSize = HISTORY_BLOB_PREFETCH_BATCH_SIZE }) {
  const batches = historyBlobOidBatches(oids, batchSize);
  if (batches.length === 0) return 0;
  if (typeof fetchBatch !== 'function' || typeof verify !== 'function') {
    throw new TypeError('History blob prefetch requires fetchBatch and verify functions.');
  }

  for (let index = 0; index < batches.length; index += 1) {
    fetchBatch(batches[index], index + 1, batches.length);
  }
  verify(batches.flat());
  return batches.length;
}

/** Fetch the given blob ids in bounded packs and verify all of them. */
export function prefetch(oids) {
  let remote;
  return prefetchAndVerifyBlobs(oids, {
    fetchBatch(batch, batchNumber, batchCount) {
      remote ??= checkoutRemoteUrl();
      console.log(`  ↳ Fetching pack ${batchNumber}/${batchCount} (${batch.length} blob OIDs).`);
      runGit(historyBlobPrefetchArgs(remote), {
        input: historyBlobPrefetchInput(batch),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    },
    verify: verifyPrefetchedBlobs,
  });
}

export function verifyPrefetchedBlobs(oids) {
  const output = runGit(['cat-file', '--batch-check'], {
    input: historyBlobPrefetchInput(oids),
    env: historyMetadataEnv(),
  });
  const invalid = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const [, type] = line.split(/\s+/u);
      return type !== 'blob';
    });
  if (invalid.length > 0) {
    throw new Error(`History blob prefetch is incomplete: ${invalid.length} object(s) are not local blobs.`);
  }
}

/** `HISTORY_SINCE` (a git date, e.g. "45 days ago") bounds the walk; empty or "all" keeps the whole history. */
export function historySinceArgs(value = process.env.HISTORY_SINCE) {
  const since = String(value || '').trim();
  return since && since !== 'all' ? [`--since=${since}`] : [];
}

export function main() {
  const env = historyMetadataEnv();
  console.log('🔎 Listing commits in the HISTORY_SINCE window.');
  const commitOutput = runGit(historyCommitWalkArgs(), { env });
  const commitOids = commitOutput.trim().split('\n').filter((oid) => OID_RE.test(oid));
  if (commitOids.length === 0) {
    throw new Error(`No historical job-slice blobs found for ${HISTORY_PATHS.join(' and ')}.`);
  }

  console.log(`🔎 Finding slice-changing commits across ${commitOids.length} history commit(s).`);
  const diffTreeOutput = runGit(historyDiffTreeArgs(), {
    input: historyBlobPrefetchInput(commitOids),
    env,
  });
  const relevantCommits = historyCommitOidsFromDiffTree(diffTreeOutput);
  if (relevantCommits.length === 0) {
    throw new Error(`No historical job-slice blobs found for ${HISTORY_PATHS.join(' and ')}.`);
  }

  console.log(`🔎 Resolving both slice-family trees at ${relevantCommits.length} relevant commit(s).`);
  const treeCheckOutput = runGit(['cat-file', '--batch-check'], {
    input: historySliceTreeRefInput(relevantCommits),
    env,
  });
  const treeOids = historyTreeOidsFromBatchCheck(treeCheckOutput);
  if (treeOids.length === 0) {
    throw new Error(`No historical job-slice trees found for ${HISTORY_PATHS.join(' and ')}.`);
  }

  const treeBatches = historyTreeOidBatches(treeOids);
  const blobOids = new Set();
  for (let index = 0; index < treeBatches.length; index += 1) {
    const batch = treeBatches[index];
    console.log(`  ↳ Reading slice tree batch ${index + 1}/${treeBatches.length} (${batch.length} trees).`);
    const treeOutput = runGit(['cat-file', '--batch'], {
      input: historyBlobPrefetchInput(batch),
      encoding: null,
      env,
    });
    for (const oid of historyBlobOidsFromTreeBatch(treeOutput)) blobOids.add(oid);
  }

  const oids = [...blobOids];
  if (oids.length === 0) {
    throw new Error(`No historical job-slice blobs found for ${HISTORY_PATHS.join(' and ')}.`);
  }

  const batchCount = Math.ceil(oids.length / HISTORY_BLOB_PREFETCH_BATCH_SIZE);
  console.log(`📦 Prefetching ${oids.length} historical job-slice blobs in ${batchCount} bounded pack(s).`);
  prefetch(oids);
  console.log('✅ All historical job-slice blobs are available locally.');
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
