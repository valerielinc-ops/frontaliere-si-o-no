/**
 * Robust data-file loader — `loadDataJson` (#2594, follow-up to #2588/#2596).
 *
 * Adversarial-review items on the lazy `data/*.json` loader:
 *  1. path resolution must not ENOENT-crash the build when cwd != repo-root
 *     (callers like slugCantonIndex pass no rootDir);
 *  2. the cache must be keyed per resolved path (Map), never a single slot, so
 *     two consumers resolving different absolute paths don't thrash a 150 MB
 *     re-read/re-parse.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataJson, releaseDataJson } from '../build-plugins/shared/loadDataJson';
import { loadJobsJson, releaseJobsJson } from '../build-plugins/shared/loadJobsJson';

function writeJson(dir: string, rel: string, value: unknown): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(value), 'utf-8');
}

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'load-data-json-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('loadDataJson — resolution + cache (#2594)', () => {
  it('reads + parses a file resolved against an explicit rootDir', () => {
    const dir = mkTmp();
    writeJson(dir, 'data/sample-2594.json', [{ a: 1 }]);
    const out = loadDataJson<Array<{ a: number }>>('data/sample-2594.json', dir);
    expect(out).toEqual([{ a: 1 }]);
  });

  it('caches per resolved absolute path (same ref on repeat, no re-read)', () => {
    const dir = mkTmp();
    writeJson(dir, 'data/cache-2594.json', [{ x: 1 }]);
    const a = loadDataJson('data/cache-2594.json', dir);
    // Mutate the file on disk; a cached loader must NOT observe the change.
    writeJson(dir, 'data/cache-2594.json', [{ x: 999 }]);
    const b = loadDataJson('data/cache-2594.json', dir);
    expect(a).toBe(b); // same object reference → served from cache
    expect(b).toEqual([{ x: 1 }]);
  });

  it('does NOT thrash between two distinct paths — each keeps its own cache slot', () => {
    const dir1 = mkTmp();
    const dir2 = mkTmp();
    writeJson(dir1, 'data/multi-2594.json', [{ from: 1 }]);
    writeJson(dir2, 'data/multi-2594.json', [{ from: 2 }]);
    // Alternate calls to two different absolute paths — a single-slot cache
    // would thrash and re-read; a Map keeps both.
    const a1 = loadDataJson('data/multi-2594.json', dir1);
    const b1 = loadDataJson('data/multi-2594.json', dir2);
    const a2 = loadDataJson('data/multi-2594.json', dir1);
    const b2 = loadDataJson('data/multi-2594.json', dir2);
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).toEqual([{ from: 1 }]);
    expect(b1).toEqual([{ from: 2 }]);
  });

  it('falls back to process.cwd() when no rootDir is given and the file exists there', () => {
    const rel = 'data/cwd-probe-2594.json';
    const abs = path.resolve(process.cwd(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify([{ cwd: true }]), 'utf-8');
    try {
      const out = loadDataJson<Array<{ cwd: boolean }>>(rel);
      expect(out).toEqual([{ cwd: true }]);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
});

/**
 * Cache eviction — `releaseDataJson` / `releaseJobsJson` (#5330 follow-up).
 *
 * The cache is module-level and unbounded: a file loaded by one plugin stays
 * live for the rest of the build. `employerProfilePagesPlugin` now has to undo
 * that for `data/jobs.json` — it moved ahead of `jobsSeoPagesPlugin` (the
 * build's memory peak, which parses the corpus itself and never reads this
 * cache), so leaving the parse behind put a second ~545 MB copy on the heap for
 * the whole peak and OOM'd the runner.
 *
 * What has to hold for that to be a real release rather than a comforting
 * no-op: the entry is actually gone (next load re-reads from disk), the return
 * value distinguishes a hit from a miss, and the release key resolves to the
 * same absolute path the load key did — a drift there would return `false`
 * forever while the corpus quietly stayed resident.
 */
describe('releaseDataJson — cache eviction (#5330)', () => {
  it('evicts the entry so the NEXT load re-reads from disk', () => {
    const dir = mkTmp();
    writeJson(dir, 'data/release-5330.json', [{ x: 1 }]);
    const a = loadDataJson('data/release-5330.json', dir);
    expect(releaseDataJson('data/release-5330.json', dir)).toBe(true);
    // Same on-disk mutation the cache test above proves is NOT observed while
    // cached — observed here precisely because the entry was dropped.
    writeJson(dir, 'data/release-5330.json', [{ x: 999 }]);
    const b = loadDataJson('data/release-5330.json', dir);
    expect(b).not.toBe(a);
    expect(b).toEqual([{ x: 999 }]);
  });

  it('reports false for a path that was never cached, and for a double release', () => {
    const dir = mkTmp();
    writeJson(dir, 'data/never-5330.json', [{ x: 1 }]);
    // Never loaded → nothing to evict. Distinguishing this from a real
    // eviction is what lets a caller/test catch a load-key vs release-key drift
    // instead of reading a silent no-op as success.
    expect(releaseDataJson('data/never-5330.json', dir)).toBe(false);
    loadDataJson('data/never-5330.json', dir);
    expect(releaseDataJson('data/never-5330.json', dir)).toBe(true);
    expect(releaseDataJson('data/never-5330.json', dir)).toBe(false);
  });

  it('releases ONLY the requested path — sibling cache slots survive', () => {
    const dir = mkTmp();
    writeJson(dir, 'data/keep-5330.json', [{ keep: true }]);
    writeJson(dir, 'data/drop-5330.json', [{ drop: true }]);
    const keep = loadDataJson('data/keep-5330.json', dir);
    loadDataJson('data/drop-5330.json', dir);
    expect(releaseDataJson('data/drop-5330.json', dir)).toBe(true);
    // Mutating the survivor on disk must still be invisible: it is cached.
    writeJson(dir, 'data/keep-5330.json', [{ keep: 'mutated' }]);
    expect(loadDataJson('data/keep-5330.json', dir)).toBe(keep);
  });

  it('releaseJobsJson targets the same key loadJobsJson populated', () => {
    // The whole point of the thin wrappers: `data/jobs.json` is spelled once,
    // so the release can never miss the slot the load filled. A regression here
    // is invisible at runtime (release returns false, build still succeeds,
    // heap silently keeps the 545 MB) — which is why it is asserted directly.
    const dir = mkTmp();
    writeJson(dir, 'data/jobs.json', [{ slug: 'a', company: 'Acme' }]);
    loadJobsJson(dir);
    expect(releaseJobsJson(dir)).toBe(true);
    expect(releaseJobsJson(dir)).toBe(false);
  });
});
