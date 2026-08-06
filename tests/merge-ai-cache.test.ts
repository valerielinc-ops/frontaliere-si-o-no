import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAiCacheDiskMaxBytes } from '../scripts/lib/ai-cache-budget.mjs';

// Exercises scripts/ci/merge-ai-cache.mjs the way git invokes it:
//   node merge-ai-cache.mjs %O %A %B   (base, ours, theirs)
// git reads the resolved result back from %A (ours).
//
// The driver exists because the byte budget applied at persist time is not
// enough on its own: ~40 crawlers write data/jobs-ai-cache.json concurrently,
// and git's generic 3-way merge unions the `entries` array on `key`. A union of
// two sides that are each exactly at budget is ABOVE budget, so without this
// driver the merge silently undoes the bound and the whole crawler group's push
// dies on GH001 — the #4248 failure, on ~40 workflows instead of one.
const DRIVER = path.resolve(__dirname, '..', 'scripts', 'ci', 'merge-ai-cache.mjs');

type Entry = { key: string; touchedAt: number; value: unknown };

let dir: string;

function doc(entries: Entry[]): string {
  return `${JSON.stringify({ version: 1, savedAt: new Date(0).toISOString(), entries }, null, 2)}\n`;
}

function runDriver(
  base: Entry[],
  ours: Entry[],
  theirs: Entry[],
  env: NodeJS.ProcessEnv = {},
): { entries: Entry[]; raw: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, doc(base));
  writeFileSync(a, doc(ours));
  writeFileSync(b, doc(theirs));
  execFileSync('node', [DRIVER, o, a, b], { env: { ...process.env, ...env } });
  const raw = readFileSync(a, 'utf8');
  return { entries: JSON.parse(raw).entries, raw };
}

const entry = (key: string, touchedAt: number, kb = 1, from = 'x'): Entry => ({
  key,
  touchedAt,
  value: { from, text: 'y'.repeat(kb * 1024) },
});

const keys = (entries: Entry[]): string[] => entries.map((e) => e.key).sort();

describe('merge-ai-cache git merge driver', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ai-cache-merge-driver-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions entries added independently by both sides', () => {
    const { entries } = runDriver([entry('a', 1)], [entry('a', 1), entry('b', 2)], [entry('a', 1), entry('c', 3)]);
    expect(keys(entries)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the most recently touched observation of a shared key', () => {
    const { entries } = runDriver(
      [entry('a', 100, 1, 'base')],
      [entry('a', 150, 1, 'ours')],
      [entry('a', 900, 1, 'theirs')],
    );
    expect(entries.length).toBe(1);
    expect(entries[0].touchedAt).toBe(900);
    expect((entries[0].value as { from: string }).from).toBe('theirs');
  });

  // 8 MiB is AI_CACHE_DISK_MIN_BYTES: the resolver clamps anything smaller, so
  // a driver test has to work at a realistic budget with realistic fixtures —
  // an earlier draft of these two used a 256 KB budget, got silently clamped up
  // to 8 MB, and asserted against a file that had never been trimmed at all.
  const MIN_BUDGET = 8 * 1024 * 1024;

  it('re-applies the byte budget so a union cannot exceed it', () => {
    // The whole reason this driver exists: two sides each near budget, whose
    // union is over it.
    const ours = Array.from({ length: 200 }, (_, i) => entry(`ours-${i}`, 1000 + i, 32));
    const theirs = Array.from({ length: 200 }, (_, i) => entry(`theirs-${i}`, 2000 + i, 32));

    const { raw, entries } = runDriver([], ours, theirs, {
      JOBS_AI_CACHE_DISK_MAX_BYTES: String(MIN_BUDGET),
    });

    expect(raw.length).toBeLessThanOrEqual(MIN_BUDGET);
    // The union would have been 400 entries; the budget cut it down.
    expect(entries.length).toBeLessThan(400);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('evicts the least recently used when the union is over budget', () => {
    // `theirs` alone is ~9.9 MB against an 8 MB budget, so nothing older than
    // `new-*` can survive and "kept == most recent" is actually falsifiable.
    // Sized deliberately: with 200 newer entries (~6.6 MB) the budget still had
    // room for ~48 of the older ones, and the assertion below passed for the
    // wrong reason.
    const ours = Array.from({ length: 200 }, (_, i) => entry(`old-${i}`, 1_000 + i, 32));
    const theirs = Array.from({ length: 300 }, (_, i) => entry(`new-${i}`, 9_000 + i, 32));

    const { entries } = runDriver([], ours, theirs, {
      JOBS_AI_CACHE_DISK_MAX_BYTES: String(MIN_BUDGET),
    });

    // Survivors are the newest, and they stay sorted oldest-first on disk.
    expect(entries[entries.length - 1].key).toBe('new-299');
    expect(entries.every((e, i, arr) => i === 0 || arr[i - 1].touchedAt <= e.touchedAt)).toBe(true);
    expect(entries.some((e) => e.key.startsWith('old-'))).toBe(false);
  });

  it('emits the exact on-disk format writeJsonAtomic produces', () => {
    // Byte-compatible with the crawler's own write, or every merge would show
    // up as a whole-file diff on the next commit.
    const { raw, entries } = runDriver([], [entry('a', 1)], [entry('b', 2)]);
    const saved = JSON.parse(raw);
    expect(saved.version).toBe(1);
    expect(typeof saved.savedAt).toBe('string');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect(keys(entries)).toEqual(['a', 'b']);
  });

  it('treats a corrupt or empty side as an empty cache instead of conflicting', () => {
    // Opposite policy to the accumulator drivers, on purpose: a lost cache
    // entry costs one LLM call, so wedging the push-retry loop would be the
    // more expensive outcome.
    const o = path.join(dir, 'base.json');
    const a = path.join(dir, 'ours.json');
    const b = path.join(dir, 'theirs.json');
    writeFileSync(o, doc([entry('a', 1)]));
    writeFileSync(a, '{ not json at all');
    writeFileSync(b, doc([entry('b', 2)]));

    execFileSync('node', [DRIVER, o, a, b]); // must not throw
    const saved = JSON.parse(readFileSync(a, 'utf8'));
    expect(saved.entries.map((e: Entry) => e.key)).toEqual(['b']);
  });

  it('is idempotent — re-merging its own output changes the entry set not at all', () => {
    const first = runDriver([], [entry('a', 1), entry('b', 2)], [entry('c', 3)]);
    const second = runDriver([], first.entries, first.entries);
    expect(keys(second.entries)).toEqual(keys(first.entries));
  });

  it('uses the same budget resolver as the crawler', () => {
    // One module owns the bound; if these ever disagreed the merge could hand
    // back a file the crawler considers legal and git does not.
    expect(resolveAiCacheDiskMaxBytes({} as NodeJS.ProcessEnv)).toBe(64 * 1024 * 1024);
  });
});
