import { describe, expect, it } from 'vitest';
import { sourcePostingDateCandidatesFields } from '../scripts/lib/source-posting-date.mjs';

const now = new Date();
const earlier = new Date(now.getTime() - 14 * 86400000).toISOString();
const later = new Date(now.getTime() - 7 * 86400000).toISOString();

describe('source publication candidate priority', () => {
  it.each(['', 'not-a-date', '2025-02-30', new Date(now.getTime() + 86400000).toISOString()])('skips invalid primary %s', (primary) => {
    expect(sourcePostingDateCandidatesFields([primary, later], now)).toEqual({
      datePosted: later, postedDate: later, postingDateSource: 'reported',
    });
  });
  it('preserves source priority rather than selecting the oldest candidate', () => {
    expect(sourcePostingDateCandidatesFields([later, earlier], now).datePosted).toBe(later);
  });
  it('leaves all-invalid and empty candidate sets unknown', () => {
    for (const candidates of [[], ['bad', null, undefined]]) {
      expect(sourcePostingDateCandidatesFields(candidates, now)).toEqual({
        datePosted: '', postedDate: '', postingDateSource: 'unknown',
      });
    }
  });
});
