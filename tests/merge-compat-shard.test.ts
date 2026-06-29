import { execFileSync, spawnSync } from 'node:child_process';
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

// Run the driver with raw file contents (to exercise corrupt/empty inputs) and
// return its exit status without throwing. `status` is null when the process
// exits 0; non-zero means the driver failed closed (surfaced a conflict).
function runDriverRaw(baseRaw: string, oursRaw: string, theirsRaw: string): { status: number | null; ours: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, baseRaw);
  writeFileSync(a, oursRaw);
  writeFileSync(b, theirsRaw);
  const res = spawnSync('node', [DRIVER, o, a, b], { encoding: 'utf8' });
  return { status: res.status, ours: readFileSync(a, 'utf8') };
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

  it('fails closed on a corrupt/mid-write side instead of silently truncating', () => {
    // A corrupt side used to degrade to `[]` and the merge wrote whatever
    // survived, exiting 0 → a clean auto-merge that skips the resolver's floor
    // guard + resolvability prune. The driver must now surface a conflict.
    const { status, ours } = runDriverRaw('', 'not json at all', shard(['/only']));
    expect(status).not.toBe(0);
    // it must NOT overwrite the shard with a truncated result
    expect(ours).toBe('not json at all');
  });

  it('fails closed when a contributing side is empty while the ancestor has paths', () => {
    // ours emptied the shard (parse-degraded read or true wipe) while base+theirs
    // still hold the paths → the deletion step would collapse the whole shard.
    // Surface a conflict so resolve-404-compat-conflict.mjs (with the total floor
    // guard) decides, rather than auto-resolving to an empty shard.
    const big = Array.from({ length: 50 }, (_, i) => `/p/${i}`);
    const { status, ours } = runDriverRaw(shard(big), shard([]), shard(big));
    expect(status).not.toBe(0);
    expect(ours).toBe(shard([])); // not rewritten to the collapsed set
    // symmetric: theirs empty
    expect(runDriverRaw(shard(big), shard(big), shard([])).status).not.toBe(0);
  });

  it('still auto-merges a brand-new shard (add/add with no merge base)', () => {
    // No false positive: an empty base (no ancestor blob) with two non-empty
    // sides is a normal add/add → union them, do not fail closed.
    const { paths } = runDriver([], ['/a'], ['/b']);
    expect(paths).toEqual(['/a', '/b']);
  });
});
