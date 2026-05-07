// tests/scripts/lib/discovery/sources/googleNewsRssSource.test.ts

import { describe, expect, it } from 'vitest';

import {
  fetchNewsRssDiscoveryCandidates,
  ageHoursFromPubDate,
} from '../../../../../scripts/lib/discovery/sources/googleNewsRssSource.mjs';

describe('ageHoursFromPubDate', () => {
  it('returns 48 (fallback) for missing/invalid input', () => {
    expect(ageHoursFromPubDate(null as any)).toBe(48);
    expect(ageHoursFromPubDate('not a date')).toBe(48);
  });

  it('returns 0 when pubDate is in the future (clock skew)', () => {
    const now = new Date('2026-05-07T10:00:00Z').getTime();
    const future = new Date('2026-05-07T11:00:00Z').toUTCString();
    expect(ageHoursFromPubDate(future, now)).toBe(0);
  });

  it('computes age in hours correctly', () => {
    const now = new Date('2026-05-07T10:00:00Z').getTime();
    const sixHoursAgo = new Date('2026-05-07T04:00:00Z').toUTCString();
    expect(ageHoursFromPubDate(sixHoursAgo, now)).toBeCloseTo(6, 5);
  });
});

describe('fetchNewsRssDiscoveryCandidates', () => {
  const stubNewsFn = (candidates: any[]) => async (_opts: any) => ({
    ok: candidates.length > 0,
    perSeed: {},
    candidates,
  });

  it('returns [] when fetcher yields no candidates', async () => {
    const out = await fetchNewsRssDiscoveryCandidates({}, { newsFn: stubNewsFn([]) });
    expect(out).toEqual([]);
  });

  it('maps RSS items to candidates with ageHours metadata', async () => {
    const now = new Date('2026-05-07T10:00:00Z').getTime();
    const pubDate = new Date('2026-05-07T08:00:00Z').toUTCString();
    const candidates = [
      {
        keyword: 'Frontalieri Ticino in calo nel 2026',
        demandSignals: {
          googleNewsRssSeed: 'frontalieri',
          googleNewsRssLink: 'https://example.com/article',
          googleNewsRssPubDate: pubDate,
          googleNewsRssSource: 'tio.ch',
        },
      },
    ];
    const out = await fetchNewsRssDiscoveryCandidates({}, { newsFn: stubNewsFn(candidates), nowMs: now });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('news');
    expect(out[0].headline).toBe('Frontalieri Ticino in calo nel 2026');
    expect(out[0].url).toBe('https://example.com/article');
    expect(out[0].meta.ageHours).toBeCloseTo(2, 5);
    expect(out[0].meta.sourceName).toBe('tio.ch');
  });

  it('dedupes by lowercased headline', async () => {
    const candidates = [
      { keyword: 'Frontalieri Ticino' , demandSignals: { googleNewsRssLink: 'https://a.example' } },
      { keyword: 'frontalieri ticino', demandSignals: { googleNewsRssLink: 'https://b.example' } },
    ];
    const out = await fetchNewsRssDiscoveryCandidates({}, { newsFn: stubNewsFn(candidates) });
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://a.example');
  });

  it('returns [] when fetcher throws', async () => {
    const throwingFn = async () => {
      throw new Error('network down');
    };
    const out = await fetchNewsRssDiscoveryCandidates({}, { newsFn: throwingFn });
    expect(out).toEqual([]);
  });
});
