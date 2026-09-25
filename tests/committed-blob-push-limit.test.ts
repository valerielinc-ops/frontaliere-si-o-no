import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Repo-wide guard against the failure #4248 actually was: a committed blob that
 * grows past GitHub's HARD 100 MB per-file push limit and takes a workflow's
 * `git push` down with it.
 *
 * The two stores that hit it (`data/all-known-job-slugs.json` at 116.78 MB,
 * `data/orphan-enriched-data.json` at 111.90 MB) are now sharded — but the
 * expensive part of that incident was never the sharding. It was that nothing
 * saw it coming and nothing said so afterwards: `sync-gsc-orphans.yml` failed
 * on 100/100 runs for three weeks, GH001 rejected the whole push, and the only
 * signal was a red badge on a workflow whose actual job — giving the 404s
 * Search Console reports a soft landing — had silently stopped.
 *
 * GH001 has two properties that make a pre-emptive check worth more than usual:
 *  - it rejects the ENTIRE push if ANY single blob is over, so one oversize
 *    file blocks every unrelated file travelling with it;
 *  - it fires at push time, i.e. AFTER the job has done all its work, so the
 *    work is computed and then thrown away, every run, until someone notices.
 *
 * This test moves that discovery to CI, where it costs one red test instead of
 * weeks of compounding organic-traffic loss.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** GitHub's hard limit. A push carrying a blob at or above this is rejected. */
const GITHUB_HARD_LIMIT = 100 * 1024 * 1024;

/**
 * Fail here, not at 100 MB. These files are accumulators written by scheduled
 * jobs — the gap between "CI noticed" and "the next scheduled run pushes" has
 * to be wide enough to land a fix. At the observed growth of the registry
 * (~1 MB/day) 5 MB of headroom is about five days.
 */
const FAIL_AT = 95 * 1024 * 1024;

interface Blob {
  path: string;
  size: number;
}

/** Every committed blob and its size, straight from the object database. */
function committedBlobs(): Blob[] {
  const out = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 256,
  });
  const blobs: Blob[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // <mode> blob <sha> <size>\t<path>
    const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    blobs.push({ size: Number(m[1]), path: m[2] });
  }
  return blobs;
}

describe('committed blobs stay pushable', () => {
  it('no committed file is within 5 MB of GitHub 100 MB push limit', () => {
    let blobs: Blob[];
    try {
      blobs = committedBlobs();
    } catch {
      return; // no git context (export/tarball) — nothing to assert against
    }
    if (blobs.length === 0) return;

    const over = blobs
      .filter((b) => b.size >= FAIL_AT)
      .sort((a, b) => b.size - a.size)
      .map((b) => `${b.path} — ${(b.size / 1024 / 1024).toFixed(1)} MB`);

    // A file listed here will make `git push` fail with GH001 for EVERY
    // workflow that commits alongside it, and the failure arrives only after
    // the job has finished its real work. Shard it before that happens: the
    // repo has three worked examples — scripts/lib/compat-paths-store.mjs
    // (#2988), scripts/lib/all-known-job-slugs-store.mjs and
    // scripts/lib/orphan-enriched-store.mjs (#4248).
    expect(over).toEqual([]);
  });

  it('reports the current headroom, so the next one is seen coming', () => {
    let blobs: Blob[];
    try {
      blobs = committedBlobs();
    } catch {
      return;
    }
    if (blobs.length === 0) return;

    const largest = blobs.reduce((a, b) => (b.size > a.size ? b : a));
    // Not an assertion about a specific file — just a printed watchlist, so the
    // number is in the log of every run instead of being discovered by a push
    // rejection. The assertion below only restates the hard invariant.
    const top = [...blobs]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((b) => `${(b.size / 1024 / 1024).toFixed(1)} MB  ${b.path}`);
    console.log(`largest committed blobs:\n  ${top.join('\n  ')}`);

    expect(largest.size).toBeLessThan(GITHUB_HARD_LIMIT);
  });
});
