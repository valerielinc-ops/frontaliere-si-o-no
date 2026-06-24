import { describe, it, expect } from 'vitest';
import {
  scoreSubscriberForAd,
  matchSubscribersForAd,
} from '../services/publisherBlastMatch.mjs';

const fisioAd = {
  title: 'Fisioterapista diplomato/a',
  category: 'health',
  sector: 'sanità',
  locations: [{ label: 'Lugano' }],
};

describe('scoreSubscriberForAd', () => {
  it('scores high for a matching job_search_query', () => {
    const s = scoreSubscriberForAd(fisioAd, { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' });
    expect(s).toBeGreaterThanOrEqual(8);
  });

  it('scores category/sector alignment', () => {
    const s = scoreSubscriberForAd(fisioAd, { sector_interest: 'health' });
    expect(s).toBeGreaterThanOrEqual(3);
  });

  it('returns 0 for an unrelated subscriber', () => {
    expect(scoreSubscriberForAd(fisioAd, { job_search_query: 'muratore edile', sector_interest: 'construction' })).toBe(0);
  });

  it('handles malformed input', () => {
    expect(scoreSubscriberForAd(null, {})).toBe(0);
    expect(scoreSubscriberForAd(fisioAd, null)).toBe(0);
    expect(scoreSubscriberForAd({ title: '' }, { job_search_query: 'x' })).toBe(0);
  });
});

describe('matchSubscribersForAd', () => {
  const subs = [
    { email: 'a@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health', locale: 'it' },
    { email: 'b@x.ch', sector_interest: 'health', locale: 'de' },
    { email: 'c@x.ch', job_search_query: 'muratore', sector_interest: 'construction' },
    { email: 'd@x.ch', job_search_query: 'Fisioterapista', status: 'unsubscribed' },
    { email: '', job_search_query: 'Fisioterapista' },
  ];

  it('returns matching subscribers sorted by score, excluding unsubscribed/blank', () => {
    const res = matchSubscribersForAd(fisioAd, subs, { minScore: 3 });
    const emails = res.map((r: { email: string }) => r.email);
    expect(emails).toContain('a@x.ch');
    expect(emails).toContain('b@x.ch');
    expect(emails).not.toContain('c@x.ch'); // construction
    expect(emails).not.toContain('d@x.ch'); // unsubscribed
    expect(emails).not.toContain(''); // blank
    // a (direct query) ranks above b (sector only)
    expect(res[0].email).toBe('a@x.ch');
  });

  it('respects the max cap', () => {
    expect(matchSubscribersForAd(fisioAd, subs, { minScore: 3, max: 1 })).toHaveLength(1);
  });

  it('minScore filters weak matches', () => {
    expect(matchSubscribersForAd(fisioAd, subs, { minScore: 9 }).every((r: { score: number }) => r.score >= 9)).toBe(true);
  });

  // Regression: the old filter checked the literal 'complaint' (an event-type
  // name, never a subscriber status value) and omitted 'suppressed', so
  // complained/suppressed recipients were still blasted. They must be excluded.
  it('excludes hard-suppressed statuses (bounced/complained/suppressed)', () => {
    const hard = [
      { email: 'match@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' },
      { email: 'bounced@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'bounced' },
      { email: 'complained@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'complained' },
      { email: 'suppressed@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'SUPPRESSED' },
    ];
    const emails = matchSubscribersForAd(fisioAd, hard, { minScore: 3 }).map((r: { email: string }) => r.email);
    expect(emails).toEqual(['match@x.ch']);
  });
});
