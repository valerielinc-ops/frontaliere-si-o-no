import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readCompatPaths,
  iterateCompatPaths,
  readCompatPathsStrict,
  readCompatPathsStrictAfterMerge,
  readCompatPathsStrictWithManifestRepair,
  repairCompatManifest,
  writeCompatPaths,
  compatShardFile,
  compatShardIndex,
  compatManifestFile,
  COMPAT_SHARD_COUNT,
} from '../scripts/lib/compat-paths-store.mjs';

// Guards issue #6384: writeCompatPaths used to unconditionally rewrite all 16
// shards on every persist (146 commits/30d touching data/seo-404-compat/, most
// changing only a handful of paths). It now compares the about-to-be-written
// bytes against what's on disk and skips shards whose content is unchanged —
// this test asserts that behaviour directly (mtime/content), not just totals.

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-paths-store-test-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('writeCompatPaths — shard write minimization', () => {
  it('writes every shard on first persist (nothing on disk yet)', () => {
    const result = writeCompatPaths({ paths: ['/a/', '/b/', '/c/'] }, rootDir);
    expect(result.shardsWritten).toBe(COMPAT_SHARD_COUNT);
  });

  it('re-persisting the exact same paths writes zero shards', () => {
    const data = { paths: ['/a/', '/b/', '/c/', '/d/', '/e/'] };
    writeCompatPaths(data, rootDir);
    const second = writeCompatPaths(data, rootDir);
    expect(second.shardsWritten).toBe(0);
  });

  it('adding a single path touches only the shard(s) it lands in', () => {
    const base = { paths: ['/a/', '/b/', '/c/', '/d/', '/e/'] };
    writeCompatPaths(base, rootDir);

    // Snapshot mtimes of all shards after the initial persist.
    const mtimesBefore = Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) =>
      fs.statSync(compatShardFile(i, rootDir)).mtimeMs,
    );

    // Add one new path — sleep a tick so any rewritten file gets a new mtime.
    const withOneMore = { paths: [...base.paths, '/brand-new-path/'] };
    const result = writeCompatPaths(withOneMore, rootDir);

    // At most the single shard the new path was distributed into changed.
    expect(result.shardsWritten).toBeLessThanOrEqual(1);
    expect(result.shardsWritten).toBeGreaterThan(0);

    const changedCount = Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) =>
      fs.statSync(compatShardFile(i, rootDir)).mtimeMs,
    ).filter((mtime, i) => mtime !== mtimesBefore[i]).length;
    expect(changedCount).toBe(result.shardsWritten);
  });

  it('round-trips the logical path set unaffected by the write-skip optimization', () => {
    const first = { paths: ['/x/', '/y/'] };
    writeCompatPaths(first, rootDir);
    writeCompatPaths({ paths: [...first.paths, '/z/'] }, rootDir);

    const read = readCompatPaths(rootDir);
    expect(new Set(read.paths)).toEqual(new Set(['/x/', '/y/', '/z/']));
  });

  it('streams shard paths without requiring the full logical array', () => {
    const paths = ['/stream-a/', '/stream-b/', '/stream-c/'];
    writeCompatPaths({ paths }, rootDir);

    expect([...iterateCompatPaths(rootDir)]).toEqual(expect.arrayContaining(paths));
    expect([...iterateCompatPaths(rootDir)]).toHaveLength(paths.length);
  });

  it('streams the legacy monolith when shards are not present', () => {
    const legacyFile = path.join(rootDir, 'data', 'seo-404-compat-paths.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ paths: ['/legacy-a/', 42, '/legacy-b/'] }));

    expect([...iterateCompatPaths(rootDir)]).toEqual(['/legacy-a/', '/legacy-b/']);
  });

  it('propagates a non-ENOENT error reading a shard instead of silently forcing a write (issue #6696)', () => {
    // A directory where a shard file is expected makes readFileSync throw
    // EISDIR, not ENOENT — the write-skip comparison used to swallow any
    // error here, masking a real disk condition as "shard doesn't exist yet".
    fs.mkdirSync(compatShardFile(0, rootDir), { recursive: true });
    expect(() => writeCompatPaths({ paths: ['/a/'] }, rootDir)).toThrow();
  });

  it('refuses a destructive read when any shard is missing', () => {
    writeCompatPaths({ paths: ['/a/', '/b/'] }, rootDir);
    fs.rmSync(compatShardFile(0, rootDir));

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/incomplete shard set/);
  });

  it('refuses to bootstrap a destructive read from an empty checkout', () => {
    expect(() => readCompatPathsStrict(rootDir)).toThrow(/accumulator is missing/);
  });

  it('refuses a destructive read when any shard is corrupt', () => {
    writeCompatPaths({ paths: ['/a/', '/b/'] }, rootDir);
    fs.writeFileSync(compatShardFile(0, rootDir), '{');

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/cannot read part-00\.json/);
  });

  it('refuses a destructive read when shard contents disagree with the manifest', () => {
    writeCompatPaths({ paths: ['/a/', '/b/'] }, rootDir);
    const manifestFile = compatManifestFile(rootDir);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    manifest.totalPaths += 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/manifest declares 3 paths/);
  });

  it('can validate shards while a merge resolver recomputes a stale manifest', () => {
    writeCompatPaths({ paths: ['/stale-manifest/'] }, rootDir);
    const manifestFile = compatManifestFile(rootDir);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    manifest.totalPaths += 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    expect(() => readCompatPathsStrictAfterMerge(rootDir, Number.NaN)).toThrow(/expected path count/);
    expect(readCompatPathsStrictAfterMerge(rootDir, 1).paths).toEqual(['/stale-manifest/']);
  });

  it('repairs only stale manifest metadata after validating every shard', () => {
    writeCompatPaths({ paths: ['/repair-a/', '/repair-b/'] }, rootDir);
    const manifestFile = compatManifestFile(rootDir);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    manifest.totalPaths -= 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    const repaired = repairCompatManifest(rootDir);

    expect(repaired).toMatchObject({ changed: true, previousTotalPaths: 1, totalPaths: 2 });
    expect(new Set(readCompatPathsStrict(rootDir).paths)).toEqual(new Set(['/repair-a/', '/repair-b/']));
    expect(repairCompatManifest(rootDir).changed).toBe(false);
  });

  it('returns the validated store while repairing its manifest in one pass', () => {
    writeCompatPaths({ paths: ['/one-pass-a/', '/one-pass-b/'] }, rootDir);
    const manifestFile = compatManifestFile(rootDir);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    manifest.totalPaths += 4;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    const prepared = readCompatPathsStrictWithManifestRepair(rootDir);

    expect(prepared).toMatchObject({ changed: true, previousTotalPaths: 6, totalPaths: 2 });
    expect(new Set(prepared.data.paths)).toEqual(new Set(['/one-pass-a/', '/one-pass-b/']));
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(2);
  });

  it('rejects a post-merge count that does not match the resolver preflight', () => {
    writeCompatPaths({ paths: ['/post-merge-count/'] }, rootDir);
    expect(() => readCompatPathsStrictAfterMerge(rootDir, 2)).toThrow(/expected 2/);
  });

  it('heals an exact duplicate inside the same shard and reports it', () => {
    writeCompatPaths({ paths: ['/dup-a/', '/dup-b/', '/dup-c/'] }, rootDir);
    const index = compatShardIndex('/dup-a/');
    const file = compatShardFile(index, rootDir);
    const shard = JSON.parse(fs.readFileSync(file, 'utf-8'));
    shard.paths.push('/dup-a/');
    fs.writeFileSync(file, JSON.stringify(shard));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const data = readCompatPathsStrict(rootDir);
      expect(data.duplicatesRemoved).toBe(1);
      expect(data.paths).toHaveLength(3);
      expect(new Set(data.paths)).toEqual(new Set(['/dup-a/', '/dup-b/', '/dup-c/']));
      expect(Object.keys(data)).not.toContain('duplicatesRemoved');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`dropped 1 exact duplicate path(s) in shard(s) part-${String(index).padStart(2, '0')}.json`);

      // The manifest repair counts unique paths and the rewrite persists them deduplicated.
      const repaired = readCompatPathsStrictWithManifestRepair(rootDir);
      expect(repaired.totalPaths).toBe(3);
      writeCompatPaths(repaired.data, rootDir);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).paths.filter((p: string) => p === '/dup-a/')).toHaveLength(1);
      const manifest = JSON.parse(fs.readFileSync(compatManifestFile(rootDir), 'utf-8'));
      expect(manifest.totalPaths).toBe(3);
      expect(manifest.duplicatesRemoved).toBeUndefined();
      expect(readCompatPathsStrict(rootDir).duplicatesRemoved).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('validates the resolver expected total against the deduplicated count', () => {
    writeCompatPaths({ paths: ['/dup-x/', '/dup-y/'] }, rootDir);
    const file = compatShardFile(compatShardIndex('/dup-x/'), rootDir);
    const shard = JSON.parse(fs.readFileSync(file, 'utf-8'));
    shard.paths.push('/dup-x/');
    fs.writeFileSync(file, JSON.stringify(shard));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readCompatPathsStrictAfterMerge(rootDir, 2).paths).toHaveLength(2);
      expect(() => readCompatPathsStrictAfterMerge(rootDir, 3)).toThrow(/expected 3/);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses duplicate paths spread across shards', () => {
    writeCompatPaths({ paths: ['/duplicate/'] }, rootDir);
    const sourceIndex = compatShardIndex('/duplicate/');
    const targetIndex = (sourceIndex + 1) % COMPAT_SHARD_COUNT;
    const targetFile = compatShardFile(targetIndex, rootDir);
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    target.paths.push('/duplicate/');
    fs.writeFileSync(targetFile, JSON.stringify(target));

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/duplicate path/);
  });

  it('refuses a path stored in the wrong shard', () => {
    writeCompatPaths({ paths: ['/wrong-shard/'] }, rootDir);
    const sourceIndex = compatShardIndex('/wrong-shard/');
    const targetIndex = (sourceIndex + 1) % COMPAT_SHARD_COUNT;
    const sourceFile = compatShardFile(sourceIndex, rootDir);
    const targetFile = compatShardFile(targetIndex, rootDir);
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    source.paths = source.paths.filter((p: string) => p !== '/wrong-shard/');
    target.paths.push('/wrong-shard/');
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    fs.writeFileSync(targetFile, JSON.stringify(target));

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/assigned to shard/);
  });
});
