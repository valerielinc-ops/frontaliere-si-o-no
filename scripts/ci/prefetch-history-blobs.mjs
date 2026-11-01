#!/usr/bin/env node

/**
 * Prefetch the historical job-slice blobs used by the expired-job backfill.
 *
 * The backfill needs every commit and tree, plus the contents of the two job
 * slice directories at each revision. A full checkout downloads unrelated
 * historical blobs as well and has grown past the checkout timeout. A
 * blobless checkout keeps the commit/tree walk complete; this script gathers
 * the exact slice blob object ids and asks Git for them in one pack, avoiding
 * one network lazy-fetch per `git show` in the backfill.
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
const SLICE_PATH_RE = /^data\/jobs\/(?:by-crawler|expired\/by-crawler)\/[^/]+\.json$/u;
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
}

/**
 * Extract only file blobs for the two historical slice directories. `git
 * rev-list --objects` also emits commits and trees, and may emit the same blob
 * through several refs; deduplicate before sending the wants to fetch-pack.
 */
export function historyBlobOidsFromRevList(output) {
  const oids = new Set();
  for (const line of String(output).split('\n')) {
    const match = line.match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(.+)$/u);
    if (!match || !OID_RE.test(match[1]) || !SLICE_PATH_RE.test(match[2])) continue;
    oids.add(match[1]);
  }
  return [...oids];
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

function prefetch(oids) {
  const input = `${oids.join('\n')}\n`;
  runGit(['fetch-pack', '--keep', '--no-progress', '--stdin', checkoutRemoteUrl()], { input });
}

function verifyPrefetchedBlobs(oids) {
  const output = runGit(['cat-file', '--batch-check'], { input: `${oids.join('\n')}\n` });
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

export function main() {
  const revList = runGit(['rev-list', '--objects', '--all', '--', ...HISTORY_PATHS]);
  const oids = historyBlobOidsFromRevList(revList);
  if (oids.length === 0) {
    throw new Error(`No historical job-slice blobs found for ${HISTORY_PATHS.join(' and ')}.`);
  }

  console.log(`📦 Prefetching ${oids.length} historical job-slice blobs in one pack.`);
  prefetch(oids);
  verifyPrefetchedBlobs(oids);
  console.log('✅ Historical job-slice blobs are available locally.');
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
