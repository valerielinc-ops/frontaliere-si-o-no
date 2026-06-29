import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercises scripts/ci/merge-compat-shard.mjs the way git invokes it:
//   node merge-compat-shard.mjs %O %A %B   (base, ours, theirs)
// git reads the resolved result back from %A (ours).
const DRIVER = path.resolve(__dirname, '..', 'scripts', 'ci', 'merge-compat-shard.mjs');

let dir: string;

function shard(paths: string[]): string {
  return JSON.stringify({ paths }, null, 2) + '\n';
}

function runDriver(base: string[], ours: string[], theirs: string[]): { paths: string[]; raw: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, shard(base));
  writeFileSync(a, shard(ours));
  writeFileSync(b, shard(theirs));
  execFileSync('node', [DRIVER, o, a, b]);
  const raw = readFileSync(a, 'utf8');
  return { paths: JSON.parse(raw).paths, raw };
}

describe('merge-compat-shard git merge driver', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'compat-shard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions both sides additions and keeps the result sorted + deduped', () => {
    const { paths, raw } = runDriver(['/a'], ['/a', '/b'], ['/a', '/c']);
    expect(paths).toEqual(['/a', '/b', '/c']);
    // no duplicates and canonically sorted
    expect(paths).toEqual([...new Set(paths)].sort());
    // matches writeCompatPaths' shard shape: 2-space pretty print + trailing newline
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(shard(['/a', '/b', '/c']));
  });

  it('never produces the duplicate bloat that git line-merge caused', () => {
    // Both sides are the same large sorted set plus one distinct add each —
    // git's default line merge would keep both copies (~2x); the driver must not.
    const common = Array.from({ length: 500 }, (_, i) => `/p/${String(i).padStart(4, '0')}`);
    const { paths } = runDriver(common, [...common, '/p/zzz-ours'], [...common, '/p/zzz-theirs']);
    expect(paths.length).toBe(502);
    expect(paths.length).toBe(new Set(paths).size); // zero duplicates
    expect(paths).toEqual([...paths].sort());
  });

  it('honours a deletion made by either side (recovered URL dropped)', () => {
    // /old present in base, deleted by ours, untouched by theirs → stays deleted.
    const r1 = runDriver(['/keep', '/old'], ['/keep'], ['/keep', '/old']);
    expect(r1.paths).toEqual(['/keep']);
    // symmetric: deleted by theirs
    const r2 = runDriver(['/keep', '/old'], ['/keep', '/old'], ['/keep']);
    expect(r2.paths).toEqual(['/keep']);
  });

  it('treats a missing/empty/corrupt input as an empty path set', () => {
    const a = path.join(dir, 'ours.json');
    const b = path.join(dir, 'theirs.json');
    const o = path.join(dir, 'base.json');
    writeFileSync(o, '');
    writeFileSync(a, 'not json at all');
    writeFileSync(b, shard(['/only']));
    execFileSync('node', [DRIVER, o, a, b]);
    expect(JSON.parse(readFileSync(a, 'utf8')).paths).toEqual(['/only']);
  });
});
