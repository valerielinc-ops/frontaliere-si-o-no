import { describe, it, expect } from 'vitest';

import { mergeRelatedSearchSummaryPartials } from '../build-plugins/relatedSearchClustersPlugin';

/**
 * Il summary parallelo (un processo per locale) deve ricomporsi byte per byte
 * come quello sequenziale: stesso ordine delle `entries` e degli `skippedKeys`
 * (ordine dei candidati), stesse chiavi.
 */
describe('mergeRelatedSearchSummaryPartials', () => {
  const entry = (key: string, n: number) => ({ key, keyword: `kw-${key}`, city: n % 2 ? 'Lugano' : null, matchingJobCount: n, legacyCantonGroup: 'TI' });
  // candidati nell'ordine globale: it::a, en::a, it::b, de::a, en::b, fr::a, it::c
  const keys = ['it::a', 'en::a', 'it::b', 'de::a', 'en::b', 'fr::a', 'it::c'];
  const skip = new Set(['it::b', 'de::a']);

  const sequential = {
    version: 1 as const,
    candidateCount: keys.length,
    jobCount: 99,
    entries: keys.filter((k) => !skip.has(k)).map((k, i) => entry(k, i)),
    skippedKeys: keys.filter((k) => skip.has(k)),
  };
  const index = (k: string) => keys.indexOf(k);
  const partialFor = (locale: string) => ({
    version: 1 as const,
    candidateCount: keys.length,
    jobCount: 99,
    entries: sequential.entries.filter((e) => e.key.startsWith(`${locale}::`)).map((e) => ({ index: index(e.key), entry: e })),
    skipped: sequential.skippedKeys.filter((k) => k.startsWith(`${locale}::`)).map((k) => ({ index: index(k), key: k })),
  });

  it('recomposes the sequential file in any child completion order', () => {
    const forward = mergeRelatedSearchSummaryPartials(['it', 'en', 'de', 'fr'].map(partialFor));
    const reversed = mergeRelatedSearchSummaryPartials(['fr', 'de', 'en', 'it'].map(partialFor));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(sequential));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(sequential));
  });

  it('refuses partials computed on different inputs', () => {
    const a = partialFor('it');
    const b = { ...partialFor('en'), jobCount: 100 };
    expect(() => mergeRelatedSearchSummaryPartials([a, b])).toThrow(/different inputs/);
    expect(() => mergeRelatedSearchSummaryPartials([])).toThrow();
  });
});
