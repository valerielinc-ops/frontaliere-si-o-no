import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readCompatPaths,
  readCompatPathsStrict,
  writeCompatPaths,
  compatShardFile,
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
});
