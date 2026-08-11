/**
 * job-locale-mark-persistence — a `needsRetranslation` mark must reach the
 * COMMITTED slices, not just the build artefact.
 *
 * WHAT THIS GUARDS. `data/jobs.json` is gitignored and re-assembled from
 * `data/jobs/by-crawler/*.json` at the top of every pipeline run. Until
 * 2026-08-11 `scripts/mark-locale-mismatched-jobs.mjs` — the ONLY script that
 * services the descriptions family — wrote the flag to that artefact alone, so
 * each mark was discarded before the cascade could drain it. The same jobs were
 * re-detected and re-flagged five times a day and the backlog never moved,
 * until a batch of German apprenticeship postings pushed
 * tests/job-locale-consistency.test.ts to 0.320% against its 0.300% ratchet and
 * reddened every open PR at once.
 *
 * The failure was invisible to the existing tests because both writes "worked":
 * the flag really was set, on an object that was about to be thrown away. So
 * these assertions are about the FILE ON DISK, never the in-memory list.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMarks, persistMarksToSlices } from '../scripts/lib/job-mark-persistence.mjs';

function makeRoot(slices: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-persist-'));
  const byCrawler = path.join(root, 'data', 'jobs', 'by-crawler');
  fs.mkdirSync(byCrawler, { recursive: true });
  for (const [name, payload] of Object.entries(slices)) {
    fs.writeFileSync(path.join(byCrawler, name), JSON.stringify(payload, null, 2));
  }
  return root;
}

function readSlice(root: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs', 'by-crawler', name), 'utf8'));
}

describe('applyMarks', () => {
  it('sets the flag only on the named slugs, and only once', () => {
    const list = [
      { slug: 'a' },
      { slug: 'b' },
      { slug: 'c', needsRetranslation: true },
    ];
    expect(applyMarks(list, new Set(['a', 'c']))).toBe(1); // 'c' already flagged
    expect(list[0].needsRetranslation).toBe(true);
    expect((list[1] as any).needsRetranslation).toBeUndefined();
    // Monotone: a second pass over the same list writes nothing.
    expect(applyMarks(list, new Set(['a', 'c']))).toBe(0);
  });

  it('never clears an existing flag', () => {
    const list = [{ slug: 'a', needsRetranslation: true }];
    applyMarks(list, new Set(['zzz']));
    expect(list[0].needsRetranslation).toBe(true);
  });
});

describe('persistMarksToSlices', () => {
  it('writes the flag into the committed slice file, not just the in-memory list', () => {
    const root = makeRoot({
      'alpha.json': [{ slug: 'job-1' }, { slug: 'job-2' }],
    });

    const result = persistMarksToSlices(new Set(['job-1']), { root });

    expect(result.totalMarked).toBe(1);
    expect(result.slicesChanged).toBe(1);
    expect(result.unresolved).toBe(0);
    // The assertion that matters: re-read from DISK.
    const onDisk = readSlice(root, 'alpha.json');
    expect(onDisk[0].needsRetranslation).toBe(true);
    expect(onDisk[1].needsRetranslation).toBeUndefined();
  });

  it('handles the {jobs: [...]} slice shape as well as a bare array', () => {
    const root = makeRoot({
      'wrapped.json': { jobs: [{ slug: 'job-3' }] },
    });

    expect(persistMarksToSlices(new Set(['job-3']), { root }).totalMarked).toBe(1);
    expect(readSlice(root, 'wrapped.json').jobs[0].needsRetranslation).toBe(true);
  });

  it('is idempotent — a second run rewrites nothing', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'job-1' }] });
    persistMarksToSlices(new Set(['job-1']), { root });
    const mtime = fs.statSync(path.join(root, 'data', 'jobs', 'by-crawler', 'alpha.json')).mtimeMs;

    const second = persistMarksToSlices(new Set(['job-1']), { root });

    expect(second.totalMarked).toBe(0);
    expect(second.slicesChanged).toBe(0);
    expect(fs.statSync(path.join(root, 'data', 'jobs', 'by-crawler', 'alpha.json')).mtimeMs).toBe(mtime);
  });

  it('dryRun reports what it would do without touching the file', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'job-1' }] });

    const result = persistMarksToSlices(new Set(['job-1']), { root, dryRun: true });

    expect(result.totalMarked).toBe(1);
    expect(readSlice(root, 'alpha.json')[0].needsRetranslation).toBeUndefined();
  });

  it('counts slugs that match no slice as unresolved — they would evaporate', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'job-1' }] });

    const result = persistMarksToSlices(new Set(['job-1', 'ghost']), { root });

    expect(result.totalMarked).toBe(1);
    expect(result.unresolved).toBe(1);
  });

  it('does not count an already-flagged slice record as unresolved', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'job-1', needsRetranslation: true }] });

    const result = persistMarksToSlices(new Set(['job-1']), { root });

    expect(result.totalMarked).toBe(0);
    expect(result.unresolved).toBe(0);
  });

  it('skips an unparseable slice instead of losing every other mark', () => {
    const root = makeRoot({ 'good.json': [{ slug: 'job-1' }] });
    fs.writeFileSync(path.join(root, 'data', 'jobs', 'by-crawler', 'corrupt.json'), '{ not json');

    const result = persistMarksToSlices(new Set(['job-1']), { root });

    expect(result.totalMarked).toBe(1);
    expect(readSlice(root, 'good.json')[0].needsRetranslation).toBe(true);
  });

  it('is a no-op when there is no by-crawler directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-persist-empty-'));
    expect(() => persistMarksToSlices(new Set(['job-1']), { root })).not.toThrow();
  });
});

describe('both markers persist to the slices', () => {
  // A source-level guard. The runtime behaviour is covered above, but the
  // regression being prevented is specifically "someone writes only the
  // artefact again" — which reads as a working script and passes every
  // behavioural test that inspects the in-memory list.
  const MARKERS = ['mark-locale-mismatched-jobs.mjs', 'mark-mistranslated-jobs.mjs'];

  for (const marker of MARKERS) {
    it(`${marker} routes its marks through persistMarksToSlices`, () => {
      const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', marker), 'utf8');
      expect(source).toContain('persistMarksToSlices');
      // Writing data/jobs.json is correct and required — the translate steps
      // later in the same run read the artefact. It just must not be the ONLY
      // write.
      expect(source).toMatch(/persistMarksToSlices\(/);
    });
  }
});