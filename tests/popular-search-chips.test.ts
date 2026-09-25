import { describe, it, expect } from 'vitest';
import { getPopularSearchChipTerms } from '../components/community/PopularSearchChips';

describe('getPopularSearchChipTerms', () => {
  it('dedupes prefix fragments in favor of the already-ranked-higher full term', () => {
    const raw = [
      { rank: 1, term: 'lugano', count: 669 },
      { rank: 2, term: 'infermiere', count: 595 },
      { rank: 11, term: 'inf', count: 140 },
      { rank: 13, term: 'infermier', count: 136 },
      { rank: 14, term: 'infer', count: 124 },
    ];
    const result = getPopularSearchChipTerms(raw, 10);
    expect(result).toEqual(['lugano', 'infermiere']);
  });

  it('drops terms shorter than the minimum chip length', () => {
    const raw = [
      { rank: 1, term: 'ti', count: 50 },
      { rank: 2, term: 'ticino', count: 40 },
    ];
    const result = getPopularSearchChipTerms(raw, 10);
    expect(result).toEqual(['ticino']);
  });

  it('respects the limit and preserves mined-rank order', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      term: `term-${i}-unique-word`,
      count: 100 - i,
    }));
    const result = getPopularSearchChipTerms(raw, 5);
    expect(result).toEqual(['term-0-unique-word', 'term-1-unique-word', 'term-2-unique-word', 'term-3-unique-word', 'term-4-unique-word']);
  });

  it('returns [] for empty input', () => {
    expect(getPopularSearchChipTerms([], 10)).toEqual([]);
  });
});
