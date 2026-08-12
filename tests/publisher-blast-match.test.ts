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
  // Every fixture below carries the double-opt-in stamp, because since #5686 a
  // row without one is not a recipient at all — see the consent-gate block at
  // the bottom of this file.
  const STAMP = '2026-01-01T00:00:00.000Z';
  const subs = [
    { email: 'a@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health', locale: 'it', confirmed_at: STAMP },
    { email: 'b@x.ch', sector_interest: 'health', locale: 'de', confirmed_at: STAMP },
    { email: 'c@x.ch', job_search_query: 'muratore', sector_interest: 'construction', confirmed_at: STAMP },
    { email: 'd@x.ch', job_search_query: 'Fisioterapista', status: 'unsubscribed', confirmed_at: STAMP },
    { email: '', job_search_query: 'Fisioterapista', confirmed_at: STAMP },
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
      { email: 'match@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health', confirmed_at: STAMP },
      { email: 'bounced@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'bounced', confirmed_at: STAMP },
      { email: 'complained@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'complained', confirmed_at: STAMP },
      { email: 'suppressed@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'SUPPRESSED', confirmed_at: STAMP },
    ];
    const emails = matchSubscribersForAd(fisioAd, hard, { minScore: 3 }).map((r: { email: string }) => r.email);
    expect(emails).toEqual(['match@x.ch']);
  });

  /**
   * The consent half (#5686). A paid-ad blast is ordinary marketing whose
   * audience is the whole newsletter_subscribers collection, so it was reached
   * by exactly the defect the weekly newsletter had: the suppression Set above
   * says who opted OUT and says nothing about who ever opted IN.
   */
  describe('the consent gate', () => {
    const strongMatch = { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' };

    it('drops a perfect match that carries no confirmation stamp', () => {
      const rows = [
        { email: 'stamped@example.com', ...strongMatch, confirmed_at: STAMP },
        { email: 'never-confirmed@example.com', ...strongMatch, status: 'pending' },
        { email: 'claims-confirmed@example.com', ...strongMatch, status: 'confirmed' },
      ];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['stamped@example.com']);
    });

    it('keeps a `pending` row that DOES carry the stamp — the deliverability re-probe', () => {
      // scripts/mailtrap-suppression-retry.mjs writes status:'pending' on a
      // previously-confirmed address to make the cascade retry the mailbox.
      // Keying on the word instead of the stamp would drop those people.
      const rows = [{ email: 'reprobe@example.com', ...strongMatch, status: 'pending', confirmedAt: STAMP }];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['reprobe@example.com']);
    });
  });
});
