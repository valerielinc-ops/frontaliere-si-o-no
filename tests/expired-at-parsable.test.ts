import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  archiveRemovedJobsToSlice,
  deterministicExpiredAt,
  isParsableExpiredAt,
  normalizeExpiredAtEntries,
  // @ts-expect-error — .mjs module without type declarations
} from '../scripts/lib/expired-jobs-archive.mjs';
import { normalizeAndPersistExpiredSlice } from '../scripts/assemble-jobs-dataset.mjs';
// @ts-expect-error — .mjs module without type declarations
import { compareExpiredAt } from '../scripts/lib/compare-expired-at.mjs';

/**
 * Issue #7736. Both archive writers sort by `expiredAt` and then cut at
 * EXPIRED_JOBS_CAP. `compareExpiredAt` sends an unparseable value to the tail
 * by construction, so past the cut an entry that sat INSIDE the cap in the
 * input is pushed out of it and the soft landing for a still-indexed URL
 * turns back into a 404. The fix normalizes at the ingress; these are the
 * observers that keep both halves of that claim honest.
 */
describe('expiredAt parsability — normalization at ingress', () => {
  it('uses code-unit order when both expiredAt values are unparseable', () => {
    expect(compareExpiredAt('ä', 'z')).toBeGreaterThan(0);
    expect(compareExpiredAt('z', 'ä')).toBeLessThan(0);
  });

  it('classifies the values the sort cannot order', () => {
    expect(isParsableExpiredAt('2026-09-06T10:00:00.000Z')).toBe(true);
    expect(isParsableExpiredAt(undefined)).toBe(false);
    expect(isParsableExpiredAt(null)).toBe(false);
    expect(isParsableExpiredAt('')).toBe(false);
    expect(isParsableExpiredAt('not-a-date')).toBe(false);
    expect(isParsableExpiredAt(1_759_000_000_000 as unknown as string)).toBe(false);
  });

  it('stamps a parsable timestamp on every entry that lacks one', () => {
    const now = '2026-09-06T12:00:00.000Z';
    const entries = [
      { slug: 'a', expiredAt: '2026-09-01T00:00:00.000Z' },
      { slug: 'b', expiredAt: undefined },
      { slug: 'c', expiredAt: '' },
      { slug: 'd', expiredAt: 'boh' },
    ];
    expect(normalizeExpiredAtEntries(entries, { now, source: 'test' })).toBe(3);
    for (const entry of entries) expect(isParsableExpiredAt(entry.expiredAt)).toBe(true);
    expect(entries[0].expiredAt).toBe('2026-09-01T00:00:00.000Z');
    expect(entries[1].expiredAt).toBe(now);
  });

  it('is idempotent — a second pass repairs nothing and moves nothing', () => {
    const entries = [{ slug: 'a', expiredAt: undefined }, { slug: 'b', expiredAt: 'nope' }];
    normalizeExpiredAtEntries(entries, { now: '2026-09-06T12:00:00.000Z', source: 'test' });
    const order = [...entries].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)).map((e) => e.slug);
    expect(normalizeExpiredAtEntries(entries, { now: '2027-01-01T00:00:00.000Z', source: 'test' })).toBe(0);
    const reordered = [...entries].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)).map((e) => e.slug);
    expect(reordered).toEqual(order);
  });

  it('derives the fallback from entry identity, not the wall clock', () => {
    const first = [{ slug: 'a', expiredAt: 'not-a-date' }, { slug: 'b' }];
    const second = structuredClone(first);
    normalizeExpiredAtEntries(first, { source: 'test' });
    normalizeExpiredAtEntries(second, { source: 'test' });
    expect(first).toEqual(second);
    expect(deterministicExpiredAt({ slug: 'a' })).toBe(first[0].expiredAt);
    expect(deterministicExpiredAt({ slug: 'b' })).toBe(second[1].expiredAt);
  });

  it('tolerates a non-array and non-object members', () => {
    expect(normalizeExpiredAtEntries(null as never)).toBe(0);
    expect(normalizeExpiredAtEntries([null, 'x', 42] as never[])).toBe(0);
  });
});

describe('archiveRemovedJobsToSlice — repairs the slice it reads back', () => {
  const withTmpDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-parsable-'));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('writes a parsable expiredAt for a legacy entry already on disk', () => {
    withTmpDir((dir) => {
      const slicePath = path.join(dir, 'acme.json');
      fs.writeFileSync(
        slicePath,
        JSON.stringify([{ slug: 'legacy', companyKey: 'acme', title: 'Legacy' }]),
      );
      const added = archiveRemovedJobsToSlice(
        [{ slug: 'fresh', companyKey: 'acme', title: 'Fresh' }],
        'acme',
        { dir },
      );
      expect(added).toBe(1);
      const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
      expect(written).toHaveLength(2);
      for (const entry of written) expect(isParsableExpiredAt(entry.expiredAt)).toBe(true);
    });
  });

  it('rewrites the slice even when nothing new is archived', () => {
    withTmpDir((dir) => {
      const slicePath = path.join(dir, 'acme.json');
      const job = { slug: 'legacy', companyKey: 'acme', title: 'Legacy' };
      fs.writeFileSync(slicePath, JSON.stringify([{ ...job, expiredAt: 'not-a-date' }]));
      // The one removed job is already in the slice, so `added` stays 0: the
      // repair alone must still reach disk, otherwise the bad value survives
      // until the next unrelated add and rides into the cap-cut meanwhile.
      archiveRemovedJobsToSlice([job], 'acme', { dir });
      const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
      expect(written).toHaveLength(1);
      expect(isParsableExpiredAt(written[0].expiredAt)).toBe(true);
    });
  });
});

describe('assemble ingress repair — persists the repaired source slice', () => {
  it('keeps the source-slice repair wired to the atomic writer', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'assemble-jobs-dataset.mjs'),
      'utf8',
    );
    expect(source).toContain("writeJsonAtomic as writeJson");
    expect(source).toContain('if (repaired > 0) writeJson(slicePath, entries);');
  });

  it('writes the normalized value back before the aggregate cap can cut it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-expired-repair-'));
    const slicePath = path.join(dir, 'acme.json');
    const entries = [{ slug: 'legacy', expiredAt: 'not-a-date' }];
    try {
      expect(normalizeAndPersistExpiredSlice(slicePath, entries, {
        now: '2026-09-06T12:00:00.000Z',
        source: 'test/assemble',
      })).toBe(1);
      const persisted = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
      expect(persisted[0].expiredAt).toBe('2026-09-06T12:00:00.000Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('audit-expired-at-parsable — the gate on a corrupt archive', () => {
  const runGate = (cwd: string) =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, '..', 'scripts', 'audit-expired-at-parsable.mjs')],
      { cwd, encoding: 'utf8' },
    );

  const withArchive = (files: Record<string, string>, fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-audit-'));
    const slices = path.join(dir, 'data', 'jobs', 'expired', 'by-crawler');
    fs.mkdirSync(slices, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(slices, name), body);
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('fails on a non-array archive file even when no entry could be counted', () => {
    // Every file corrupt → `total === 0`. The empty-archive exit must not run
    // first, or a zero-tolerance gate green-lights a corrupt archive.
    withArchive({ 'acme.json': '{"jobs":[]}', 'other.json': 'not json at all' }, (dir) => {
      const res = runGate(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('not a JSON array');
    });
  });

  it('passes on a genuinely empty archive', () => {
    withArchive({}, (dir) => {
      const res = runGate(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('nothing to audit');
    });
  });

  it('fails when the cwd has neither the slice directory nor an aggregate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-audit-missing-'));
    try {
      const res = runGate(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('expired archive not found');
      expect(res.stderr).toContain(`cwd=${fs.realpathSync(dir)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enumerates every workflow caller and requires the full archive checkout', () => {
    const workflowsDir = path.resolve(__dirname, '..', '.github', 'workflows');
    const callers = fs.readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => ({
        file,
        source: fs.readFileSync(path.join(workflowsDir, file), 'utf8'),
      }))
      .filter(({ source }) => source.split('\n').some((line) => (
        !line.trim().startsWith('#')
        && /audit:expired-at-parsable|scripts\/audit-expired-at-parsable\.mjs/.test(line)
      )));

    expect(callers.map(({ file }) => file)).toEqual(['reconcile-expired-route-duplicates.yml']);
    for (const { source } of callers) {
      const checkoutStart = source.indexOf('- name: Checkout');
      const setupStart = source.indexOf('- name: Setup Node.js', checkoutStart);
      expect(checkoutStart).toBeGreaterThanOrEqual(0);
      expect(setupStart).toBeGreaterThan(checkoutStart);
      const checkout = source.slice(checkoutStart, setupStart);
      const auditAt = source.indexOf('scripts/audit-expired-at-parsable.mjs');
      expect(checkout).toContain('uses: actions/checkout@v5');
      expect(checkout).not.toMatch(/sparse-checkout/);
      expect(checkout).not.toMatch(/filter\s*:/);
      expect(source).toContain('data/jobs/expired/by-crawler');
      expect(auditAt).toBeGreaterThan(setupStart);
    }
  });
});

describe('committed expired archive — the corpus observer', () => {
  const slicesDir = path.resolve(__dirname, '..', 'data', 'jobs', 'expired', 'by-crawler');
  const aggregate = path.resolve(__dirname, '..', 'public', 'data', 'expired-jobs.json');

  it('carries a parsable expiredAt on every committed entry', () => {
    const files = fs.existsSync(slicesDir)
      ? fs.readdirSync(slicesDir).filter((f) => f.endsWith('.json'))
      : [];
    if (fs.existsSync(aggregate)) files.push(aggregate);
    const offenders: string[] = [];
    let total = 0;
    for (const file of files) {
      const full = path.isAbsolute(file) ? file : path.join(slicesDir, file);
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!Array.isArray(parsed)) continue;
      total += parsed.length;
      for (const entry of parsed) {
        if (!isParsableExpiredAt(entry?.expiredAt)) {
          offenders.push(`${path.basename(full)} :: ${entry?.slug} :: ${JSON.stringify(entry?.expiredAt)}`);
        }
      }
    }
    // The rate is the measurement; the assertion is only its threshold.
    console.log(`[expired-at-parsable] ${offenders.length}/${total} committed entries unorderable`);
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});
