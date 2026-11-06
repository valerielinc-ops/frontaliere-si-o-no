import { describe, it, expect } from 'vitest';
import { sourcePostingDateFields, withLegacyPostingDay, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';

describe('explicit legacy calendar-day projection', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('preserves timezone and microseconds in the canonical evidence through subsequent merging', () => {
    const raw = '2026-07-10T00:12:10.733560+02:00';
    const result = withLegacyPostingDay(sourcePostingDateFields(raw, now), now);
    expect(result).toEqual({ datePosted: raw, postedDate: '2026-07-10', postingDateSource: 'reported' });
    expect(mergeSourcePostingDates({}, result, now)).toEqual(sourcePostingDateFields(raw, now));
  });
  it.each([{ postedDate: '2026-07-10' }, { postingDateSource: 'unknown', datePosted: '2026-07-10' }, { postingDateSource: 'reported', datePosted: 'invalid' }])('does not promote unverified aliases: %j', input => {
    expect(withLegacyPostingDay(input, now)).toEqual({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
});
