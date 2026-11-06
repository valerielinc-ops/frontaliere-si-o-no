// tests/scripts/lib/scoring/dedupTextSync.test.ts
//
// Guard: the semantic-dedup gate (`buildDedupText`) and the corpus embedding
// builder (`articleText`) MUST format an article's text identically. They are
// two separate functions in two files with a "must stay in sync" comment but
// no assertion — if they drift, the candidate embedding and the published
// corpus embeddings stop being comparable, the cosine gate silently emits
// false-negatives, and near-duplicate articles get published (duplicate-content
// SEO penalty, no alert). This test fails loudly the moment they diverge.

import { describe, expect, it } from 'vitest';

import { buildDedupText } from '../../../../scripts/lib/scoring/semanticDedup.mjs';
import { articleText } from '../../../../scripts/build-article-embeddings.mjs';

describe('buildDedupText / articleText sync', () => {
  const cases: Array<{ name: string; title: string; excerpt: string }> = [
    {
      name: 'typical title + excerpt',
      title: 'Aumenti salariali Ticino fino al 2% nel 2025',
      excerpt: 'Gli stipendi dei frontalieri crescono: ecco i settori e le cifre.',
    },
    { name: 'empty title and excerpt', title: '', excerpt: '' },
    { name: 'title only', title: 'Stipendi neolaureati a confronto', excerpt: '' },
    {
      name: 'excerpt exceeding the 4000-char cap',
      title: 'T',
      excerpt: 'x'.repeat(5000),
    },
    {
      name: 'newlines and unicode in body',
      title: 'LAMal vs CMI — quale conviene',
      excerpt: 'Confronto 2026:\nfranchigia, premi, prestazioni. €/CHF, à è ì ò ù.',
    },
  ];

  for (const c of cases) {
    it(`produces byte-identical text: ${c.name}`, () => {
      const fromGate = buildDedupText(c.title, c.excerpt);
      const fromBuilder = articleText({ title: c.title, excerpt: c.excerpt });
      expect(fromGate).toBe(fromBuilder);
    });
  }
});
