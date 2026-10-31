import { describe, expect, it } from 'vitest';
import {
  demandCandidate,
  shouldAdmitCandidate,
  toStoredCandidate,
} from '../scripts/lib/related-search-admission.mjs';

const absent = { known: false, jobCount: 1, gscMatch: false, requestedOn404: false };

describe('related-search candidate admission', () => {
  it('rejects a new singleton without any evidence', () => {
    expect(shouldAdmitCandidate(absent)).toBe(false);
    expect(shouldAdmitCandidate({ ...absent, jobCount: 2 })).toBe(false);
  });

  it.each([
    ['an entry already published', { known: true }],
    ['three postings', { jobCount: 3 }],
    ['Search Console demand', { gscMatch: true }],
    ['requests that hit a 404', { requestedOn404: true }],
  ])('admits %s', (_, change) => {
    expect(shouldAdmitCandidate({ ...absent, ...change })).toBe(true);
  });

  it('drops the field nobody reads and keeps the rest', () => {
    const entry = { slug: 'ricerca-a', locale: 'it', jobCount: 3, sampleJobIds: ['x'], sampleTerms: ['a'] };
    expect(toStoredCandidate(entry)).toEqual({ slug: 'ricerca-a', locale: 'it', jobCount: 3, sampleTerms: ['a'] });
  });

  it('derives the search term of a demanded slug', () => {
    const entry = demandCandidate({ slug: 'recherche-soudage-bulach-zurich', locale: 'fr' });
    expect([...entry.sampleTerms]).toEqual(['soudage bulach zurich']);
    expect(entry.requestedOn404).toBe(true);
  });
});
