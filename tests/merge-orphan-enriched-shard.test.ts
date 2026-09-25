import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercises scripts/ci/merge-orphan-enriched-shard.mjs the way git invokes it:
//   node merge-orphan-enriched-shard.mjs %O %A %B   (base, ours, theirs)
// git reads the resolved result back from %A (ours).
//
// Without this driver, two producers that both re-serialise a sorted JSON ARRAY
// get git's default line merge, which keeps both rewritten halves — duplicate
// records and a doubled blob, i.e. the >100 MB push rejection (#4248) coming
// straight back through the merge path instead of the write path.
const DRIVER = path.resolve(__dirname, '..', 'scripts', 'ci', 'merge-orphan-enriched-shard.mjs');

type Rec = Record<string, unknown>;

let dir: string;

function shard(orphans: Rec[]): string {
  return `${JSON.stringify({ orphans }, null, 2)}\n`;
}

function runDriver(base: Rec[], ours: Rec[], theirs: Rec[]): { orphans: Rec[]; raw: string } {
  const o = path.join(dir, 'base.json');
  const a = path.join(dir, 'ours.json');
  const b = path.join(dir, 'theirs.json');
  writeFileSync(o, shard(base));
  writeFileSync(a, shard(ours));
  writeFileSync(b, shard(theirs));
  execFileSync('node', [DRIVER, o, a, b]);
  const raw = readFileSync(a, 'utf8');
  return { orphans: JSON.parse(raw).orphans, raw };
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

const rec = (slug: string, locale = 'it', extra: Rec = {}): Rec => ({
  slug,
  locale,
  path: `/cerca-lavoro-ticino/${slug}/`,
  ...extra,
});

const keys = (orphans: Rec[]): string[] => orphans.map((r) => `${r.locale}:${r.slug}`);

describe('merge-orphan-enriched-shard git merge driver', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orphan-enriched-shard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions records added independently by both sides', () => {
    const base = [rec('a')];
    const { orphans } = runDriver(base, [rec('a'), rec('b')], [rec('a'), rec('c')]);
    expect(keys(orphans).sort()).toEqual(['it:a', 'it:b', 'it:c']);
  });

  it('does not duplicate a record both sides added', () => {
    const { orphans } = runDriver([], [rec('a')], [rec('a')]);
    expect(orphans.length).toBe(1);
  });

  it('honours a deletion instead of resurrecting the record', () => {
    const base = [rec('a'), rec('gone')];
    const { orphans } = runDriver(base, [rec('a')], base);
    expect(keys(orphans)).toEqual(['it:a']);
  });

  it('keeps the side that actually changed a record', () => {
    const base = [rec('a', 'it', { totalImpressions: 1 })];
    const ours = [rec('a', 'it', { totalImpressions: 1 })];
    const theirs = [rec('a', 'it', { totalImpressions: 50 })];
    const { orphans } = runDriver(base, ours, theirs);
    expect(orphans[0].totalImpressions).toBe(50);
  });

  it('keeps the richer GSC observation when BOTH sides changed a record', () => {
    // Losing impressions/queries here costs the soft-landing page the content it
    // exists to render, so the tie-break is deliberately "more signal wins",
    // not "newest wins".
    const base = [rec('a', 'it', { totalImpressions: 1, totalClicks: 0, queries: [] })];
    const ours = [rec('a', 'it', { totalImpressions: 5, totalClicks: 0, queries: [1] })];
    const theirs = [rec('a', 'it', { totalImpressions: 900, totalClicks: 40, queries: [1, 2, 3] })];
    const { orphans } = runDriver(base, ours, theirs);
    expect(orphans[0].totalImpressions).toBe(900);
    expect(orphans[0].totalClicks).toBe(40);
  });

  it('treats the same slug in different locales as distinct records', () => {
    const { orphans } = runDriver([], [rec('a', 'it')], [rec('a', 'de')]);
    expect(keys(orphans).sort()).toEqual(['de:a', 'it:a']);
  });

  it('emits canonical output: sorted by (slug, locale), pretty, trailing newline', () => {
    const { orphans, raw } = runDriver(
      [],
      [rec('zeta', 'it'), rec('alpha', 'it')],
      [rec('alpha', 'de')],
    );
    expect(keys(orphans)).toEqual(['de:alpha', 'it:alpha', 'it:zeta']);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(`${JSON.stringify({ orphans }, null, 2)}\n`);
  });

  it('is idempotent — re-merging its own output changes nothing', () => {
    const first = runDriver([], [rec('a'), rec('b')], [rec('c')]);
    const second = runDriver([], first.orphans, first.orphans);
    expect(second.raw).toBe(first.raw);
  });

  it('refuses to auto-merge when a side fails to parse', () => {
    // Degrading a corrupt side to "empty" would read as "every ancestor record
    // was intentionally deleted" and silently wipe 1/32 of an accumulator that
    // nothing can rebuild.
    const good = shard([rec('a'), rec('b')]);
    const { status } = runDriverRaw(good, '{ not json', good);
    expect(status).not.toBe(0);
  });

  it('refuses to auto-merge when a side is empty while the ancestor has records', () => {
    const good = shard([rec('a'), rec('b')]);
    const { status } = runDriverRaw(good, shard([]), good);
    expect(status).not.toBe(0);
  });

  it('accepts a genuinely empty ancestor (a newly added shard)', () => {
    const { status, ours } = runDriverRaw('', shard([rec('a')]), shard([rec('b')]));
    expect(status).toBe(0);
    expect(JSON.parse(ours).orphans.length).toBe(2);
  });
});
