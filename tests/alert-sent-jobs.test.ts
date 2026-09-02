import { describe, expect, it } from 'vitest';
import {
  jobDedupKey,
  normalizeSentMap,
  filterUnsentJobs,
  mergeSentJobs,
  DEDUP_WINDOW_MS,
  SENT_JOBS_CAP,
} from '../scripts/lib/alert-sent-jobs.mjs';

const NOW = 1_700_000_000_000;

describe('jobDedupKey', () => {
  it('prefers the crawler id', () => {
    expect(jobDedupKey({ id: 'eoc-123', url: 'https://x/y', slug: 's' })).toBe('eoc-123');
    expect(jobDedupKey({ id: 0, url: 'https://x/y', slug: 's' })).toBe('0');
  });

  it('falls back to the URL-derived stable id, then the slug', () => {
    // A long numeric id in the URL is the stable token mergeUrlKey extracts.
    expect(jobDedupKey({ url: 'https://co.example/job/60419000/role' })).toContain('60419000');
    expect(jobDedupKey({ slug: 'only-slug' })).toBe('only-slug');
  });

  it('returns empty string for an id-less job', () => {
    expect(jobDedupKey({})).toBe('');
    expect(jobDedupKey(null as never)).toBe('');
  });
});

describe('normalizeSentMap', () => {
  it('passes through a plain { key: ms } object', () => {
    expect(normalizeSentMap({ a: 100, b: 200 })).toEqual({ a: 100, b: 200 });
  });

  it('coerces Firestore Timestamp-like + date-string values, drops junk', () => {
    const ts = { toMillis: () => 500 };
    const out = normalizeSentMap({ a: ts, b: '2023-01-01T00:00:00Z', c: {} });
    expect(out.a).toBe(500);
    expect(out.b).toBe(new Date('2023-01-01T00:00:00Z').getTime());
    expect('c' in out).toBe(false);
  });

  it('tolerates undefined / array / null', () => {
    expect(normalizeSentMap(undefined)).toEqual({});
    expect(normalizeSentMap([1, 2] as never)).toEqual({});
    expect(normalizeSentMap(null)).toEqual({});
  });
});

describe('filterUnsentJobs', () => {
  const jobs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('drops jobs sent within the window, keeps the rest', () => {
    const sent = { a: NOW - 1000, b: NOW - DEDUP_WINDOW_MS - 1 }; // a recent, b expired
    const out = filterUnsentJobs(jobs, sent, NOW);
    expect(out.map((j) => j.id)).toEqual(['b', 'c']);
  });

  it('keeps everything when nothing was sent', () => {
    expect(filterUnsentJobs(jobs, {}, NOW)).toHaveLength(3);
  });

  it('lets an id-less job through (cannot dedup it)', () => {
    expect(filterUnsentJobs([{ slug: '' } as never], {}, NOW)).toHaveLength(1);
  });
});

describe('mergeSentJobs', () => {
  it('adds newly-sent keys stamped at now', () => {
    const out = mergeSentJobs({ old: NOW - 1000 }, [{ id: 'a' }, { id: 'b' }], NOW);
    expect(out).toMatchObject({ old: NOW - 1000, a: NOW, b: NOW });
  });

  it('prunes entries older than the window', () => {
    const out = mergeSentJobs({ stale: NOW - DEDUP_WINDOW_MS - 1 }, [{ id: 'fresh' }], NOW);
    expect('stale' in out).toBe(false);
    expect(out.fresh).toBe(NOW);
  });

  it('caps to the most-recent SENT_JOBS_CAP entries', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < SENT_JOBS_CAP + 50; i++) big[`k${i}`] = NOW - i; // newer = lower i
    const out = mergeSentJobs(big, [], NOW);
    expect(Object.keys(out)).toHaveLength(SENT_JOBS_CAP);
    expect(out.k0).toBe(NOW); // newest retained
    expect('k' + (SENT_JOBS_CAP + 49) in out).toBe(false); // oldest dropped
  });

  it('round-trips with filterUnsentJobs: a sent job is excluded next run', () => {
    const day = 24 * 60 * 60 * 1000;
    const ranked = [{ id: 'x' }, { id: 'y' }];
    const map1 = mergeSentJobs({}, ranked.slice(0, 1), NOW); // sent x today
    const fresh = filterUnsentJobs(ranked, map1, NOW + day); // tomorrow
    expect(fresh.map((j) => j.id)).toEqual(['y']);
  });
});
