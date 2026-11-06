import { describe, expect, it } from 'vitest';
import {
  computeTokenPostings,
  intersectedCandidatesForToken,
  wantedGramsForTokens,
} from '../build-plugins/relatedSearchPostingsCore.mjs';

// Deterministic pseudo-random corpus: the sparse path must return exactly the
// dense entries (same tokens, same job indexes, same order) on any input.
function makeCorpus(seed: number, size: number) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const words = [
    'infermiere', 'infermieristica', 'magazziniere', 'logistica', 'lugano', 'mendrisio',
    'bellinzona', 'cuoco', 'cameriere', 'elettricista', 'meccanico', 'ingegnere',
    'software', 'developer', 'vendita', 'contabile', 'pulizie', 'autista', 'oss', 'it',
    'ai', 'crèche', 'éducatrice', 'Zürich', 'straße', 'ﬁnance', '42', 'b2b', 'x',
  ];
  const pick = (n: number) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
  return Array.from({ length: size }, (_, i) => ({
    title: pick(3),
    titleByLocale: i % 3 === 0 ? { de: pick(3) } : undefined,
    description: pick(40),
    descriptionByLocale: i % 4 === 0 ? { en: pick(30) } : undefined,
    company: pick(1),
    location: pick(1),
    cantonSearch: i % 2 === 0 ? 'ticino tessin' : '',
  }));
}

const TOKENS = [
  'infermier', 'magazzin', 'lugan', 'oss', 'it', 'ai', 'b2', '42', 'zzz', 'q', 'ticin',
  'developer', 'softw', 'nonexistent', 'aaa', 'eleel', 'crech', 'educatric', 'strass', 'financ',
];

describe('related-search postings pre-pass: sparse path', () => {
  for (const locale of ['it', 'de', 'en', 'fr']) {
    it(`returns entries identical to the dense path (${locale})`, () => {
      const jobs = makeCorpus(locale.charCodeAt(0) * 7919, 400);
      const dense = computeTokenPostings({ jobs, locale, tokens: TOKENS, sparse: false });
      const sparse = computeTokenPostings({ jobs, locale, tokens: TOKENS, sparse: true });
      expect(sparse).toEqual(dense);
      // Guard against a vacuous pass: the corpus must actually produce hits.
      expect(dense.filter((e) => e.list.length > 0).length).toBeGreaterThan(5);
    });
  }

  it('indexes only the grams a token can read', () => {
    const { wanted2, wanted3 } = wantedGramsForTokens(['oss', 'it', 'q', 'lugan']);
    expect([...wanted2].sort()).toEqual(['it']);
    expect([...wanted3].sort()).toEqual(['uga', 'gan', 'lug', 'oss'].sort());
  });

  it('intersects every 3-gram list and keeps ascending order', () => {
    const grams = new Map<string, number[]>([
      ['abc', [1, 2, 3, 5, 8]],
      ['bcd', [2, 3, 8, 9]],
      ['cde', [0, 3, 8]],
    ]);
    expect(intersectedCandidatesForToken('abcde', grams)).toEqual([3, 8]);
    expect(intersectedCandidatesForToken('abcx', grams)).toEqual([]);
    expect(intersectedCandidatesForToken('ab', new Map([['ab', [4, 6]]]))).toEqual([4, 6]);
  });
});
