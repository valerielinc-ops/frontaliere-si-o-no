import { afterEach, describe, expect, it, vi } from 'vitest';
import { articleSchemaDates, articleSourceDate, compareArticleSourceDates } from '../services/articleSourceDates';

afterEach(() => vi.useRealTimers());

describe('article dates retain source precision without inventing freshness', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('preserves a calendar date and accepts a complete source timestamp without appending another time', () => {
    expect(articleSchemaDates({ date: '2026-02-18' }, now)).toEqual({
      datePublished: '2026-02-18',
    });
    expect(articleSchemaDates({ date: '2026-02-18T11:45:01.224Z' }, now)).toEqual({
      datePublished: '2026-02-18T11:45:01.224Z',
    });
    expect(articleSourceDate('2026-02-18T12:45:01+01:00', now)).toBe('2026-02-18T11:45:01.000Z');
  });

  it.each(['', undefined, 'unknown', '2026-02-30', '2026-02', '2027-01-01', '2026-02-18T11:45:01ZT00:00:00+01:00'])(
    'omits undocumented, invalid or future date %s', (date) => {
      expect(articleSourceDate(date, now)).toBeUndefined();
      expect(articleSchemaDates({ date, updatedAt: date }, now)).toEqual({});
    },
  );

  it('does not infer an update from a known publication when the update is invalid', () => {
    expect(articleSchemaDates({ date: '2026-02-18', updatedAt: 'invalid' }, now)).toEqual({ datePublished: '2026-02-18' });
  });

  it('preserves an independently documented update when publication is unknown', () => {
    expect(articleSchemaDates({ date: '', updatedAt: '2026-09-20' }, now)).toEqual({ dateModified: '2026-09-20' });
  });

  it('does not create dates when the same undated article is rendered on another day', () => {
    const unknown = { date: '' };
    expect(articleSchemaDates(unknown, new Date('2026-09-20'))).toEqual({});
    expect(articleSchemaDates(unknown, now)).toEqual({});
    const known = { date: '2026-02-18', updatedAt: '2026-09-01' };
    expect(articleSchemaDates(known, new Date('2026-09-20'))).toEqual(articleSchemaDates(known, now));
  });

  it('keeps dated articles chronological and puts unknown dates last without NaN ordering', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const articles = [
      { id: 'unknown-z', date: '' }, { id: 'older', date: '2026-02-18' },
      { id: 'unknown-a', date: 'invalid' }, { id: 'newer', date: '2026-09-20' },
    ];
    expect(articles.sort(compareArticleSourceDates).map((article) => article.id)).toEqual([
      'newer', 'older', 'unknown-a', 'unknown-z',
    ]);
  });
});
