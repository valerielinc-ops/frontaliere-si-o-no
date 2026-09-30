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

interface Listing {
  blobs: Blob[];
  /** Blob committati che questo checkout non ha in locale (clone parziale). */
  unmeasured: number;
}

/**
 * Every committed blob and its size, straight from the object database.
 *
 * `-l` legge la dimensione di OGNI blob. Nel checkout di tests.yml (sparse,
 * `filter: tree:0`) i blob fuori dal profilo non sono in locale, e git li
 * scaricava uno alla volta dalla rete: il worker restava appeso per ore dentro
 * un `execFileSync`, che nessun timeout di Vitest interrompe (run 35481674287
 * del 2026-09-20, cancellata dopo 6 ore, e 36733687811 del 2026-09-30: tutti gli
 * altri file finiti, un `git-remote-https` orfano). Con GIT_NO_LAZY_FETCH git
 * risponde `BAD` per quei blob in un secondo; qui li si conta come non
 * misurati. Un clone completo (full-suite-dispatch, monitor) li misura tutti.
 */
function committedBlobs(): Listing | null {
  let out: string;
  try {
    out = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 256,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      // Tetto sul comando sincrono: se git tornasse a bloccarsi, il test deve
      // fallire in fretta, non tenere fermo il job fino al suo timeout.
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { code?: string; signal?: string | null };
    // Un timeout non è «nessun contesto git»: è un guasto, e va visto.
    if (e.code === 'ETIMEDOUT' || e.signal) throw err;
    return null; // no git context (export/tarball) — nothing to assert against
  }
  const blobs: Blob[] = [];
  let unmeasured = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    // <mode> blob <sha> <size>\t<path>; <size> è `BAD` per un blob assente.
    const m = /^\d+ blob [0-9a-f]+\s+(\S+)\t(.+)$/.exec(line);
    if (!m) continue;
    if (!/^\d+$/.test(m[1])) {
      unmeasured += 1;
      continue;
    }
    blobs.push({ size: Number(m[1]), path: m[2] });
  }
  return { blobs, unmeasured };
}

describe('committed blobs stay pushable', () => {
  it('no committed file is within 5 MB of GitHub 100 MB push limit', () => {
    const listing = committedBlobs();
    if (!listing) return;
    const { blobs } = listing;
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
    const listing = committedBlobs();
    if (!listing) return;
    const { blobs, unmeasured } = listing;
    if (unmeasured > 0) {
      console.log(`${unmeasured} committed blobs not present in this partial checkout: not measured here (a full clone measures them)`);
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
