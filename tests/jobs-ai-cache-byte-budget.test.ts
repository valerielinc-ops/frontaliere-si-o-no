// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const {
  persistAiCacheToDisk,
  seedAiCacheForTests,
  resetAiCacheStateForTests,
  trimAiCacheEntriesToByteBudget,
  resolveAiCacheDiskMaxBytes,
  AI_CACHE_DISK_MAX_BYTES_DEFAULT,
} = __testables;

/**
 * `data/jobs-ai-cache.json` was bounded in the WRONG UNIT (issue #4248
 * follow-up).
 *
 * `AI_CACHE_DISK_MAX_ENTRIES` caps the cache at 30,000 ENTRIES while GitHub
 * rejects a push — the whole push — when a blob crosses 100 MB, which is a
 * limit in BYTES. Entry size here spans two orders of magnitude (median 2.0 KB,
 * mean 3.5 KB, max 73.7 KB), so the count cap cannot bound the file: at the
 * measured mean the DEFAULT cap already permits ~104 MB.
 *
 * Measured on the committed blobs, the file went 72.93 MB (2026-07-26) →
 * 85.49 MB (2026-08-05), ~1.26 MB/day — about eleven days from GH001. And it is
 * committed by every crawler via STANDARD_FILES in git-commit-data.sh, so the
 * failure would land on ~40 workflows at once instead of the single workflow
 * that #4248 took down for three weeks.
 *
 * These tests pin the invariant that makes that impossible: what gets written
 * is under the byte budget, and what gets dropped is the least recently used.
 */

const tmpPaths: string[] = [];

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  delete process.env.AI_CACHE_PATH_OVERRIDE;
  delete process.env.JOBS_AI_CACHE_DISK_MAX_BYTES;
  resetAiCacheStateForTests();
});

type Entry = { key: string; touchedAt: number; value: unknown };

/** An entry whose rendered cost is roughly `kb` KB. */
function entry(key: string, touchedAt: number, kb = 1): Entry {
  return { key, touchedAt, value: { text: 'x'.repeat(kb * 1024) } };
}

/** The document `persistAiCacheToDisk` writes, rendered exactly as on disk. */
function rendered(entries: Entry[]): number {
  return JSON.stringify(
    { version: 1, savedAt: new Date(0).toISOString(), entries },
    null,
    2,
  ).length;
}

describe('AI cache byte budget — the invariant', () => {
  it('keeps the rendered document under the budget', () => {
    const entries = Array.from({ length: 400 }, (_, i) => entry(`k${i}`, i, 2));
    const budget = 128 * 1024;

    const r = trimAiCacheEntriesToByteBudget(entries, budget);

    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.length).toBeLessThan(entries.length);
    expect(rendered(r.entries)).toBeLessThanOrEqual(budget);
  });

  it('accounts for pretty-print overhead, not just compact size', () => {
    // writeJsonAtomic emits 2-space JSON. On the real cache that is a 5%
    // difference (81.4 MB compact vs 85.5 MB on disk) — a budget measured on
    // the compact form would be silently over.
    const entries = Array.from({ length: 200 }, (_, i) => entry(`k${i}`, i, 2));
    const budget = 200 * 1024;

    const r = trimAiCacheEntriesToByteBudget(entries, budget);
    const compact = JSON.stringify({ version: 1, savedAt: '', entries: r.entries }).length;

    expect(rendered(r.entries)).toBeLessThanOrEqual(budget);
    expect(compact).toBeLessThan(rendered(r.entries)); // pretty really is bigger
  });

  it('measures UTF-8 BYTES, not UTF-16 code units', () => {
    // The bug this pins: `String.prototype.length` counts code units, and this
    // cache is job descriptions in German, French and Italian where every `ü`,
    // `é`, `à` is one code unit but two UTF-8 bytes. Verified with `.length`,
    // a merge of the real 24,602-entry cache produced a 65.11 MB file against a
    // 64 MB budget and reported itself compliant — git measures bytes.
    const accented = Array.from({ length: 300 }, (_, i) => ({
      key: `k${i}`,
      touchedAt: i,
      // Every character here is 2 bytes in UTF-8, 1 code unit in UTF-16.
      value: { text: 'üéàöè'.repeat(400) },
    }));
    const budget = 256 * 1024;

    const r = trimAiCacheEntriesToByteBudget(accented, budget);
    const doc = JSON.stringify(
      { version: 1, savedAt: new Date(0).toISOString(), entries: r.entries },
      null,
      2,
    );

    expect(r.droppedEntries).toBeGreaterThan(0);
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(budget);
    // And the byte size really is bigger than the code-unit count here, so the
    // assertion above is not passing by accident on ASCII.
    expect(Buffer.byteLength(doc, 'utf8')).toBeGreaterThan(doc.length);
  });

  it('is a no-op when the whole set already fits', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`k${i}`, i, 1));
    const r = trimAiCacheEntriesToByteBudget(entries, 10 * 1024 * 1024);

    expect(r.droppedEntries).toBe(0);
    expect(r.droppedBytes).toBe(0);
    expect(r.entries).toBe(entries); // same reference: nothing copied, nothing dropped
  });

  it('drops the LEAST RECENTLY USED, keeping the newest', () => {
    // Input arrives sorted oldest-first, as persistAiCacheToDisk sorts it.
    const entries = Array.from({ length: 100 }, (_, i) => entry(`k${i}`, i * 1000, 2));
    const r = trimAiCacheEntriesToByteBudget(entries, 64 * 1024);

    expect(r.droppedEntries).toBeGreaterThan(0);
    // Everything kept is newer than everything dropped.
    const oldestKept = Math.min(...r.entries.map((e: Entry) => e.touchedAt));
    const newestDropped = Math.max(
      ...entries.slice(0, r.droppedEntries).map((e: Entry) => e.touchedAt),
    );
    expect(oldestKept).toBeGreaterThan(newestDropped);
    // And the very newest entry always survives.
    expect(r.entries[r.entries.length - 1].key).toBe('k99');
  });

  it('never returns more than the budget even when one entry alone exceeds it', () => {
    const entries = [entry('huge', 1, 512)];
    const r = trimAiCacheEntriesToByteBudget(entries, 16 * 1024);

    expect(r.entries.length).toBe(0);
    expect(r.droppedEntries).toBe(1);
  });

  it('is deterministic — the property that lets ~40 concurrent writers converge', () => {
    // Each crawler re-reads the on-disk snapshot, merges by touchedAt, then
    // applies this trim. Same merged set in, same file out, so siblings
    // persisting in the same minute agree instead of fighting.
    const entries = Array.from({ length: 300 }, (_, i) => entry(`k${i}`, i, 3));
    const a = trimAiCacheEntriesToByteBudget(entries, 96 * 1024);
    const b = trimAiCacheEntriesToByteBudget([...entries], 96 * 1024);

    expect(a.entries.map((e: Entry) => e.key)).toEqual(b.entries.map((e: Entry) => e.key));
  });

  it('tolerates a missing or nonsensical budget instead of emptying the cache', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`k${i}`, i, 1));
    expect(trimAiCacheEntriesToByteBudget(entries, 0).entries).toBe(entries);
    expect(trimAiCacheEntriesToByteBudget(entries, Number.NaN).entries).toBe(entries);
    expect(trimAiCacheEntriesToByteBudget([], 1024).entries).toEqual([]);
  });
});

describe('AI cache byte budget — configuration', () => {
  it('defaults to 64 MiB, far below GitHub 100 MB push limit', () => {
    expect(AI_CACHE_DISK_MAX_BYTES_DEFAULT).toBe(64 * 1024 * 1024);
    expect(resolveAiCacheDiskMaxBytes()).toBe(64 * 1024 * 1024);
  });

  it('never lets an override reach the push limit', () => {
    // The old entry cap could be raised to 100,000 (~347 MB at the measured
    // mean entry size). A byte budget that could be raised past 100 MB would
    // reintroduce exactly the bug it exists to remove, so the clamp is the
    // guarantee — not the default.
    process.env.JOBS_AI_CACHE_DISK_MAX_BYTES = String(500 * 1024 * 1024);
    expect(resolveAiCacheDiskMaxBytes()).toBeLessThan(100 * 1024 * 1024);
    expect(resolveAiCacheDiskMaxBytes()).toBe(90 * 1024 * 1024);
  });

  it('honours a smaller override', () => {
    process.env.JOBS_AI_CACHE_DISK_MAX_BYTES = String(16 * 1024 * 1024);
    expect(resolveAiCacheDiskMaxBytes()).toBe(16 * 1024 * 1024);
  });
});

describe('persistAiCacheToDisk enforces the budget on the file it writes', () => {
  it('writes a file under the budget and drops only the oldest entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-budget-'));
    tmpPaths.push(dir);
    const cachePath = path.join(dir, 'jobs-ai-cache.json');
    process.env.AI_CACHE_PATH_OVERRIDE = cachePath;
    process.env.JOBS_AI_CACHE_DISK_MAX_BYTES = String(8 * 1024 * 1024);

    // ~12 MB of cache against an 8 MB budget.
    seedAiCacheForTests(
      Array.from({ length: 1200 }, (_, i) => ({
        key: `k${String(i).padStart(4, '0')}`,
        touchedAt: 1_700_000_000_000 + i * 1000,
        value: { text: 'y'.repeat(10 * 1024) },
      })),
    );

    persistAiCacheToDisk({ force: true });

    const bytes = fs.statSync(cachePath).size;
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);

    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(saved.entries.length).toBeGreaterThan(0);
    expect(saved.entries.length).toBeLessThan(1200);
    // The survivors are the most recent ones, and the newest is always there.
    expect(saved.entries[saved.entries.length - 1].key).toBe('k1199');
    const keptKeys = new Set(saved.entries.map((e: Entry) => e.key));
    expect(keptKeys.has('k0000')).toBe(false);
  });

  it('still merges a concurrent sibling write before applying the budget', () => {
    // Order matters: trimming before the merge would evict entries the sibling
    // is about to re-add, so the two would fight and the file would churn.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-budget-merge-'));
    tmpPaths.push(dir);
    const cachePath = path.join(dir, 'jobs-ai-cache.json');
    process.env.AI_CACHE_PATH_OVERRIDE = cachePath;
    process.env.JOBS_AI_CACHE_DISK_MAX_BYTES = String(8 * 1024 * 1024);

    seedAiCacheForTests([{ key: 'own-key', touchedAt: 5_000, value: { from: 'self' } }]);
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      savedAt: new Date(2000).toISOString(),
      entries: [{ key: 'sibling-key', touchedAt: 9_000, value: { from: 'sibling' } }],
    }));

    persistAiCacheToDisk({ force: true });

    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const keys = saved.entries.map((e: Entry) => e.key).sort();
    expect(keys).toEqual(['own-key', 'sibling-key']);
  });
});
