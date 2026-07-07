// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const { persistAiCacheToDisk, seedAiCacheForTests, resetAiCacheStateForTests } = __testables;

// Regression coverage for a last-write-wins clobber: crawler-group jobs run
// ~25 sibling processes concurrently against one shared checkout, each
// loading data/jobs-ai-cache.json once at startup, then overwriting it
// wholesale at exit. Without merging, whichever process persists last would
// erase every key a sibling added or refreshed after this process's own
// load. persistAiCacheToDisk now re-reads the on-disk snapshot right before
// writing and folds in any key with a newer touchedAt than what this
// process already holds, so siblings merge instead of clobbering.
describe('persistAiCacheToDisk merges concurrent sibling writes', () => {
  const tmpPaths: string[] = [];

  afterEach(() => {
    for (const p of tmpPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    delete process.env.AI_CACHE_PATH_OVERRIDE;
    resetAiCacheStateForTests();
  });

  it('keeps a sibling-added key this process never loaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-merge-'));
    tmpPaths.push(dir);
    const cachePath = path.join(dir, 'jobs-ai-cache.json');
    process.env.AI_CACHE_PATH_OVERRIDE = cachePath;

    // This process only ever knew about "own-key".
    seedAiCacheForTests([{ key: 'own-key', touchedAt: 1000, value: { ok: true, from: 'self' } }]);

    // A sibling process persisted after this one's load, adding a key this
    // process's in-memory Map has never seen.
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      savedAt: new Date(2000).toISOString(),
      entries: [
        { key: 'own-key', touchedAt: 500, value: { ok: true, from: 'self-stale-disk-copy' } },
        { key: 'sibling-key', touchedAt: 2000, value: { ok: true, from: 'sibling' } },
      ],
    }));

    persistAiCacheToDisk({ force: true });

    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const byKey = Object.fromEntries(saved.entries.map((e: { key: string }) => [e.key, e]));

    expect(Object.keys(byKey).sort()).toEqual(['own-key', 'sibling-key']);
    // own-key: this process's in-memory touch (1000) is newer than the on-disk
    // copy (500) it loaded from, so its own value wins.
    expect(byKey['own-key'].value.from).toBe('self');
    // sibling-key: never in this process's memory, must survive the merge.
    expect(byKey['sibling-key'].value.from).toBe('sibling');
  });

  it('prefers the newer touchedAt when both sides touched the same key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-merge-'));
    tmpPaths.push(dir);
    const cachePath = path.join(dir, 'jobs-ai-cache.json');
    process.env.AI_CACHE_PATH_OVERRIDE = cachePath;

    // This process's own touch is older than what a sibling wrote afterwards.
    seedAiCacheForTests([{ key: 'shared-key', touchedAt: 100, value: { from: 'self-old' } }]);

    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      savedAt: new Date(2000).toISOString(),
      entries: [
        { key: 'shared-key', touchedAt: 9999, value: { from: 'sibling-newer' } },
      ],
    }));

    persistAiCacheToDisk({ force: true });

    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].value.from).toBe('sibling-newer');
  });
});
