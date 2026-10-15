import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercises scripts/ci/merge-known-slugs-shard.mjs the way git invokes it:
//   node merge-known-slugs-shard.mjs %O %A %B   (base, ours, theirs)
// git reads the resolved result back from %A (ours).
const DRIVER = path.resolve(__dirname, '..', 'scripts', 'ci', 'merge-known-slugs-shard.mjs');

type Slugs = Record<string, Record<string, string>>;

let dir: string;

function shard(slugs: Slugs): string {
  return JSON.stringify({ slugs }, null, 2) + '\n';
}

function runDriver(base: Slugs, ours: Slugs, theirs: Slugs): { slugs: Slugs; raw: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, shard(base));
  writeFileSync(a, shard(ours));
  writeFileSync(b, shard(theirs));
  execFileSync('node', [DRIVER, o, a, b]);
  const raw = readFileSync(a, 'utf8');
  return { slugs: JSON.parse(raw).slugs, raw };
}

// Run the driver with raw file contents (to exercise corrupt/empty inputs) and
// return its exit status without throwing. Non-zero means it failed closed and
// surfaced the conflict instead of guessing.
function runDriverRaw(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): { status: number | null; ours: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, baseRaw);
  writeFileSync(a, oursRaw);
  writeFileSync(b, theirsRaw);
  const res = spawnSync('node', [DRIVER, o, a, b], { encoding: 'utf8' });
  return { status: res.status, ours: readFileSync(a, 'utf8') };
}

const p = (s: string): Record<string, string> => ({ it: `/cerca-lavoro-ticino/${s}` });

describe('merge-known-slugs-shard git merge driver', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'known-slugs-shard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions both sides additions, sorted, with no duplicate keys', () => {
    const { slugs, raw } = runDriver({ a: p('a') }, { a: p('a'), b: p('b') }, { a: p('a'), c: p('c') });
    expect(Object.keys(slugs)).toEqual(['a', 'b', 'c']);
    // matches writeAllKnownJobSlugs' shard shape: 2-space pretty print + newline
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(shard({ a: p('a'), b: p('b'), c: p('c') }));
  });

  it('honours a deletion made by either side', () => {
    const base = { a: p('a'), b: p('b') };
    expect(Object.keys(runDriver(base, { a: p('a') }, base).slugs)).toEqual(['a']);
    expect(Object.keys(runDriver(base, base, { b: p('b') }).slugs)).toEqual(['b']);
  });

  it('takes the side that actually changed an entry', () => {
    const base = { a: { it: '/cerca-lavoro-ticino/a' } };
    const ours = { a: { it: '/cerca-lavoro-ticino/a' } };
    const theirs = { a: { it: '/cerca-lavoro-zurigo/a' } };
    // Only theirs migrated the canton section — keep the migration.
    expect(runDriver(base, ours, theirs).slugs.a).toEqual({ it: '/cerca-lavoro-zurigo/a' });
    // Symmetric.
    expect(runDriver(base, theirs, ours).slugs.a).toEqual({ it: '/cerca-lavoro-zurigo/a' });
  });

  it('unions locale paths additively when both sides changed the same entry', () => {
    const base = { a: { it: '/it/a' } };
    const ours = { a: { it: '/it/a2', en: '/en/a' } };
    const theirs = { a: { it: '/it/a3', de: '/de/a' } };
    const merged = runDriver(base, ours, theirs).slugs.a;
    // No locale is dropped — a lost locale path costs a soft-landing page.
    expect(merged.en).toBe('/en/a');
    expect(merged.de).toBe('/de/a');
    // Ours wins the direct collision.
    expect(merged.it).toBe('/it/a2');
  });

  it('fails closed when a side is unparseable (never wipes the shard)', () => {
    const good = shard({ a: p('a'), b: p('b') });
    const res = runDriverRaw(good, '{ not json', good);
    expect(res.status).not.toBe(0);
    // %A is left untouched so git surfaces the conflict.
    expect(res.ours).toBe('{ not json');
  });

  it('fails closed when a contributing side is empty but the ancestor is not', () => {
    const base = shard({ a: p('a'), b: p('b') });
    const res = runDriverRaw(base, shard({}), base);
    expect(res.status).not.toBe(0);
  });

  it('auto-merges a newly added shard with no merge base', () => {
    const { slugs } = runDriver({}, { a: p('a') }, { b: p('b') });
    expect(Object.keys(slugs)).toEqual(['a', 'b']);
  });
});
