import { describe, it, expect } from 'vitest';
import { suggestSimilarTerms } from '../services/search/fuzzySearchSuggestions';

describe('suggestSimilarTerms', () => {
  const candidates = ['Infermiere', 'Infermiere pediatrico', 'Ingegnere civile', 'Autista bus', 'Lugano'];

  it('returns [] for queries shorter than 2 chars', () => {
    expect(suggestSimilarTerms('i', candidates)).toEqual([]);
    expect(suggestSimilarTerms('', candidates)).toEqual([]);
  });

  it('returns [] when nothing scores above zero', () => {
    expect(suggestSimilarTerms('zzzzz', candidates)).toEqual([]);
  });

  it('ranks prefix/substring matches above unrelated candidates', () => {
    const result = suggestSimilarTerms('inferm', candidates);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].toLowerCase()).toContain('inferm');
  });

  it('excludes an exact (case-insensitive) match to the query', () => {
    const result = suggestSimilarTerms('lugano', candidates);
    expect(result).not.toContain('Lugano');
  });

  it('dedupes case-insensitively', () => {
    const dupCandidates = ['Autista', 'autista', 'AUTISTA bus'];
    const result = suggestSimilarTerms('autist', dupCandidates);
    const lowerSet = new Set(result.map((r) => r.toLowerCase()));
    expect(lowerSet.size).toBe(result.length);
  });

  it('respects the limit parameter', () => {
    const many = Array.from({ length: 20 }, (_, i) => `infermiere-${i}`);
    const result = suggestSimilarTerms('infermiere', many, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
