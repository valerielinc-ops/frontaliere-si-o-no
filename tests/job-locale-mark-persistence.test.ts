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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyMarks,
  carryForwardMarks,
  dedupeByIdentityPreservingMarks,
  persistMarksToSlices,
} from '../scripts/lib/job-mark-persistence.mjs';

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
/**
 * ── #5645: the mark has to survive the OTHER writers ────────────────────────
 *
 * `writeJsonAtomic` makes one file's write indivisible. It says nothing about
 * two processes, and the two shapes below are how a mark that was written
 * correctly stops existing anyway.
 *
 * REACHABILITY IS MEASURED, not assumed. `translate-pending.yml` (which runs
 * the marker) and the 23 `crawler-group-NN.yml` workflows sit in DIFFERENT
 * concurrency groups — `jobs-data-pipeline` vs `jobs-crawler-group-NN` — so
 * nothing serialises them. Over the 7 days to 2026-08-14 their run windows
 * overlapped 400 times, for 227.1 hours in total.
 */
describe('#5645 — a duplicated slug is marked in every slice, never first-match', () => {
  it('marks BOTH copies when the same slug lives in two slices, and reports the duplicate', () => {
    const root = makeRoot({
      'alpha.json': { crawlerKey: 'alpha', assembledAt: '2026-08-13T01:00:00.000Z', jobs: [{ slug: 'dup', url: 'https://x/1' }] },
      'beta.json': { crawlerKey: 'beta', assembledAt: '2026-08-13T04:00:00.000Z', jobs: [{ slug: 'dup', url: 'https://x/1' }] },
    });

    const result = persistMarksToSlices(new Set(['dup']), { root });

    // The assertion that matters: BOTH files on disk, not just the first one
    // the directory listing happened to hand over. A copy left unmarked is the
    // copy assembly may keep.
    expect(readSlice(root, 'alpha.json').jobs[0].needsRetranslation).toBe(true);
    expect(readSlice(root, 'beta.json').jobs[0].needsRetranslation).toBe(true);
    expect(result.totalMarked).toBe(2);
    expect(result.slicesChanged).toBe(2);
    expect(result.duplicated).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it('still marks the second copy when the first one already carries the flag', () => {
    const root = makeRoot({
      'alpha.json': [{ slug: 'dup', needsRetranslation: true }],
      'beta.json': [{ slug: 'dup' }],
    });

    const result = persistMarksToSlices(new Set(['dup']), { root });

    expect(readSlice(root, 'beta.json')[0].needsRetranslation).toBe(true);
    expect(result.duplicated).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it('counts a slug living in one slice as not duplicated', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'solo' }], 'beta.json': [{ slug: 'other' }] });
    expect(persistMarksToSlices(new Set(['solo']), { root }).duplicated).toBe(0);
  });
});

describe('#5645 — collapsing duplicates merges the mark instead of taking one side', () => {
  const identityOf = (job: any) => (job.url ? `url:${job.url}` : `slug:${job.slug}`);

  it('carries the mark onto the copy that wins the assembledAt race', () => {
    // The measured production shape: the marker flagged every copy, then a
    // crawler re-crawled ONE slice and rebuilt its record from scratch — no
    // flag, fresher timestamp. On b10e8eed this state held for 223 slugs, 25 of
    // which lost the mark entirely at assembly.
    const stale = { url: 'https://x/1', slug: 'a', title: 'old', needsRetranslation: true };
    const fresh = { url: 'https://x/1', slug: 'a', title: 'new' };

    const { winners, marksCarried, collapsed } = dedupeByIdentityPreservingMarks(
      [
        { job: stale, assembledAt: '2026-08-13T01:00:00.000Z' },
        { job: fresh, assembledAt: '2026-08-13T04:00:00.000Z' },
      ],
      identityOf
    );

    expect(winners).toHaveLength(1);
    // Last-write-wins is UNCHANGED for the record itself…
    expect(winners[0].title).toBe('new');
    // …and the mark is merged rather than deleted with the losing copy.
    expect(winners[0].needsRetranslation).toBe(true);
    expect(marksCarried).toBe(1);
    expect(collapsed).toBe(1);
  });

  it('carries the mark in the other direction too (marked copy arrives second, older)', () => {
    const fresh = { url: 'https://x/1', slug: 'a', title: 'new' };
    const stale = { url: 'https://x/1', slug: 'a', title: 'old', needsRetranslation: true };

    const { winners, marksCarried } = dedupeByIdentityPreservingMarks(
      [
        { job: fresh, assembledAt: '2026-08-13T04:00:00.000Z' },
        { job: stale, assembledAt: '2026-08-13T01:00:00.000Z' },
      ],
      identityOf
    );

    expect(winners[0].title).toBe('new');
    expect(winners[0].needsRetranslation).toBe(true);
    expect(marksCarried).toBe(1);
  });

  it('keeps the pre-existing tie-break: equal timestamps, later slice still wins', () => {
    const first = { url: 'https://x/1', slug: 'a', title: 'first' };
    const second = { url: 'https://x/1', slug: 'a', title: 'second' };
    const { winners } = dedupeByIdentityPreservingMarks(
      [
        { job: first, assembledAt: '2026-08-13T01:00:00.000Z' },
        { job: second, assembledAt: '2026-08-13T01:00:00.000Z' },
      ],
      identityOf
    );
    expect(winners[0].title).toBe('second');
  });

  it('skips records with no identity, exactly as the assembler did', () => {
    const { winners } = dedupeByIdentityPreservingMarks(
      [{ job: { url: '', slug: '' }, assembledAt: '' }],
      (job: any) => (job.url || job.slug ? 'x' : '')
    );
    expect(winners).toHaveLength(0);
  });

  it('carryForwardMarks is monotone — it never clears and never double-counts', () => {
    const winner: any = { slug: 'a', needsRetranslation: true };
    expect(carryForwardMarks(winner, { slug: 'a' })).toBe(0);
    expect(winner.needsRetranslation).toBe(true);
    const plain: any = { slug: 'a' };
    expect(carryForwardMarks(plain, { slug: 'a' })).toBe(0);
    expect(plain.needsRetranslation).toBeUndefined();
  });

  it('assemble-jobs-dataset routes its dedup through the mark-preserving helper', () => {
    // Source-level guard: the runtime behaviour is covered above, but the
    // regression to prevent is someone re-inlining the old
    // `if (!existing || tagged.assembledAt >= existing.assembledAt)` loop,
    // which reads as a perfectly working dedup and silently deletes marks.
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'assemble-jobs-dataset.mjs'), 'utf8');
    expect(source).toContain('dedupeByIdentityPreservingMarks(');
    expect(source).toContain('carryForwardMarks(');
    expect(source).not.toMatch(/byIdentity\.set\(identity,\s*tagged\)/);
  });
});

describe('#5645 — a concurrent writer must not be clobbered, and must not eat the mark', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rebuilds the write on fresher bytes when another process commits mid-pass', () => {
    const root = makeRoot({
      'alpha.json': { crawlerKey: 'alpha', jobs: [{ slug: 'job-1', url: 'https://x/1' }] },
    });
    const filePath = path.join(root, 'data', 'jobs', 'by-crawler', 'alpha.json');
    const original = fs.readFileSync(filePath, 'utf8');

    // Simulate the other writer landing between OUR read and OUR write: the
    // first read hands back the pre-crawl bytes, and the crawler's fresh slice
    // (a new posting, and a rewritten title) hits the disk immediately after.
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((p: any, enc: any) => {
      const content = realRead(p, enc);
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          { crawlerKey: 'alpha', jobs: [{ slug: 'job-1', url: 'https://x/1', title: 'crawled' }, { slug: 'job-2', url: 'https://x/2' }] },
          null,
          2
        )
      );
      return content;
    }) as any);

    const result = persistMarksToSlices(new Set(['job-1']), { root });

    const onDisk = readSlice(root, 'alpha.json');
    // 1. The other writer's work survived — a stale parse was NOT shipped.
    expect(onDisk.jobs).toHaveLength(2);
    expect(onDisk.jobs[0].title).toBe('crawled');
    // 2. And our mark is on the fresh document, not on the discarded one.
    expect(onDisk.jobs[0].needsRetranslation).toBe(true);
    expect(result.racesResolved).toBe(1);
    expect(result.racesLost).toBe(0);
    expect(result.totalMarked).toBe(1);
    expect(original).not.toBe(fs.readFileSync(filePath, 'utf8'));
  });

  it('gives up loudly rather than clobbering when a writer keeps winning the race', () => {
    const root = makeRoot({ 'alpha.json': [{ slug: 'job-1' }] });
    const filePath = path.join(root, 'data', 'jobs', 'by-crawler', 'alpha.json');

    // A writer that rewrites the slice on every single read: every attempt
    // fails its compare-and-swap.
    const realRead = fs.readFileSync;
    let bump = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, enc: any) => {
      const content = realRead(p, enc);
      if (String(p) === filePath) {
        bump += 1;
        fs.writeFileSync(filePath, JSON.stringify([{ slug: 'job-1', rev: bump }], null, 2));
      }
      return content;
    }) as any);

    const result = persistMarksToSlices(new Set(['job-1']), { root });
    vi.restoreAllMocks();

    expect(result.racesLost).toBe(1);
    expect(result.totalMarked).toBe(0);
    expect(result.slicesChanged).toBe(0);
    // The concurrent writer's last version is intact: we never wrote over it.
    expect(readSlice(root, 'alpha.json')[0].rev).toBeGreaterThan(0);
  });
});

describe('#5645 — the cross-runner path: git-commit-data.sh must not drop the mark', () => {
  // The marker and the crawlers do not share a filesystem: they share `main`.
  // A crawler group that pushes AFTER translate-pending marked a slice resolves
  // the file through `merge_json_3way` inside scripts/lib/git-commit-data.sh
  // (base = its checkout, remote = origin/main, local = its fresh crawl). That
  // merge is embedded in a `.sh` heredoc, so NO test in this repo can see it —
  // the file's own comment says as much about tests/slug-write-encapsulation.
  // It is also the only place where the 400 measured workflow overlaps can turn
  // into a lost mark, so the property gets pinned here, against the real code.
  const SH = path.resolve(__dirname, '..', 'scripts', 'lib', 'git-commit-data.sh');

  function extractMergeScript(): string {
    const source = fs.readFileSync(SH, 'utf8');
    const match = source.match(/<<'NODE'\n([\s\S]*?)\nNODE\n/);
    // A failed extraction is a real signal (the heredoc was renamed or
    // restructured), not a reason to skip: the guard would go quietly vacuous.
    expect(match, 'merge_json_3way heredoc not found in git-commit-data.sh').toBeTruthy();
    return (match as RegExpMatchArray)[1];
  }

  function merge3(base: unknown, remote: unknown, local: unknown): any {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge3-'));
    const script = path.join(dir, 'merge.cjs');
    fs.writeFileSync(script, extractMergeScript());
    const files = { base: path.join(dir, 'b.json'), remote: path.join(dir, 'r.json'), local: path.join(dir, 'l.json') };
    fs.writeFileSync(files.base, JSON.stringify(base, null, 2));
    fs.writeFileSync(files.remote, JSON.stringify(remote, null, 2));
    fs.writeFileSync(files.local, JSON.stringify(local, null, 2));
    const out = path.join(dir, 'o.json');
    execFileSync(process.execPath, [script, files.base, files.remote, files.local, out, 'url', 'data/jobs/by-crawler/alpha.json'], {
      encoding: 'utf8',
    });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  }

  it('keeps a mark the remote gained while a crawler was re-crawling the same job', () => {
    const base = { crawlerKey: 'alpha', assembledAt: '2026-08-13T01:00:00.000Z', jobs: [{ url: 'https://x/1', slug: 'a', title: 'old' }] };
    const remote = { ...base, jobs: [{ ...base.jobs[0], needsRetranslation: true }] };   // translate-pending pushed the mark
    const local = { crawlerKey: 'alpha', assembledAt: '2026-08-13T04:00:00.000Z', jobs: [{ url: 'https://x/1', slug: 'a', title: 'new' }] };

    const merged = merge3(base, remote, local);

    expect(merged.jobs).toHaveLength(1);
    expect(merged.jobs[0].title).toBe('new');            // the crawl still wins the record
    expect(merged.jobs[0].needsRetranslation).toBe(true); // and the mark is not collateral damage
  });

  it('keeps it for records the identity key cannot see — no url, only a slug', () => {
    const base = { crawlerKey: 'alpha', assembledAt: '2026-08-13T01:00:00.000Z', jobs: [{ slug: 'a', title: 'old' }] };
    const remote = { ...base, jobs: [{ slug: 'a', title: 'old', needsRetranslation: true }] };
    const local = { crawlerKey: 'alpha', assembledAt: '2026-08-13T04:00:00.000Z', jobs: [{ slug: 'a', title: 'new' }] };

    const merged = merge3(base, remote, local);

    expect(merged.jobs).toHaveLength(1);
    expect(merged.jobs[0].needsRetranslation).toBe(true);
  });

  it('respects a DELIBERATE clear — a crawler that repaired the translation', () => {
    // The counterweight to the two above: `repair-translations.mjs` and
    // dedicated-crawler-common.mjs `delete job.needsRetranslation` on purpose.
    // If the merge made the flag sticky, the backlog could never drain.
    const base = { crawlerKey: 'alpha', assembledAt: '2026-08-13T01:00:00.000Z', jobs: [{ url: 'https://x/1', slug: 'a', needsRetranslation: true }] };
    const remote = base;
    const local = { crawlerKey: 'alpha', assembledAt: '2026-08-13T04:00:00.000Z', jobs: [{ url: 'https://x/1', slug: 'a' }] };

    const merged = merge3(base, remote, local);

    expect(merged.jobs[0].needsRetranslation).toBeUndefined();
  });
});

describe('#5645 — the whole class of writers, not just the one in the issue', () => {
  // AGENTS.md #6: a fix for a pattern is a fix for the pattern's siblings. The
  // two below share the exact antipattern, each in one half of it.
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', 'scripts', rel), 'utf8');

  it('reconcile-duplicate-stable-id-jobs carries the mark off the record it drops', () => {
    // It collapses same-`id` duplicates INSIDE one slice and keeps one whole —
    // and it already knew that dropping a record must not drop its slugs. The
    // monotone flag needed the same treatment, or the collapse deletes it.
    const source = read('reconcile-duplicate-stable-id-jobs.mjs');
    expect(source).toContain('carryForwardMarks(winner, dropped)');
  });

  it('backfill-needs-retranslation writes its slices through the compare-and-swap', () => {
    const source = read('backfill-needs-retranslation.mjs');
    expect(source).toContain('updateSliceCompareAndSwap(');
    // The direct atomic write is what made it clobberable: atomic per file,
    // blind to anything another writer committed since the read.
    expect(source).not.toContain('writeJsonAtomic(');
  });
});
