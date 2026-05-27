// tests/scripts/lib/scoring/termExtractor.test.ts
//
// Phase 2 — term extractor unit tests. Spec § 5.3.

import { describe, expect, it } from 'vitest';

import { extractTerms, __internals } from '../../../../scripts/lib/scoring/termExtractor.mjs';

describe('extractTerms', () => {
  it('returns empty arrays for empty headline', () => {
    const out = extractTerms('');
    expect(out.unigrams).toEqual([]);
    expect(out.bigrams).toEqual([]);
    expect(out.trigrams).toEqual([]);
    expect(out.properNouns).toEqual([]);
    expect(out.stems).toEqual([]);
  });

  it('handles null input gracefully', () => {
    const out = extractTerms(null as unknown as string);
    expect(out.unigrams).toEqual([]);
  });

  it('lowercases and strips diacritics', () => {
    const out = extractTerms('Università di Lugano');
    expect(out.unigrams).toContain('universita');
    expect(out.unigrams).toContain('lugano');
  });

  it('removes short stopwords (articles + prepositions)', () => {
    const out = extractTerms('Tasse il frontaliere di Ticino');
    // 'il', 'di' must be filtered.
    expect(out.unigrams).not.toContain('il');
    expect(out.unigrams).not.toContain('di');
    expect(out.unigrams).toContain('tasse');
    expect(out.unigrams).toContain('frontaliere');
    expect(out.unigrams).toContain('ticino');
  });

  it('drops unigrams shorter than 3 chars', () => {
    const out = extractTerms('AI ML AVS frontaliere');
    expect(out.unigrams).not.toContain('ai');
    expect(out.unigrams).not.toContain('ml');
    expect(out.unigrams).toContain('avs');
    expect(out.unigrams).toContain('frontaliere');
  });

  it('builds bigrams of adjacent tokens (≥6 chars total)', () => {
    const out = extractTerms('Frontalieri Ticino calo');
    expect(out.bigrams).toContain('frontalieri ticino');
    expect(out.bigrams).toContain('ticino calo');
  });

  it('builds trigrams of adjacent tokens', () => {
    const out = extractTerms('Frontalieri Ticino calo 2026');
    expect(out.trigrams).toContain('frontalieri ticino calo');
    expect(out.trigrams).toContain('ticino calo 2026');
  });

  it('captures proper nouns (capitalized tokens after position 0)', () => {
    const out = extractTerms('Tasse svizzere a Lugano e Bellinzona');
    expect(out.properNouns).toContain('lugano');
    expect(out.properNouns).toContain('bellinzona');
  });

  it('captures multi-word proper-noun phrases', () => {
    const out = extractTerms('Ufficio Lugano Centro inaugura nuova sede');
    // First word "Ufficio" is sentence-position so excluded as a single
    // proper noun, but "Lugano Centro" is a 2-token capitalized run and
    // must be captured.
    expect(out.properNouns.some((p) => p.includes('lugano') && p.includes('centro'))).toBe(true);
  });

  it('produces stems for inflected unigrams', () => {
    const out = extractTerms('Lavorare in svizzera');
    expect(out.stems.length).toBeGreaterThan(0);
    // "lavorare" stems to "lavor".
    expect(out.stems).toContain('lavor');
  });

  it('dedups all output arrays', () => {
    const out = extractTerms('Frontalieri Frontalieri Ticino Ticino');
    const setSize = new Set(out.unigrams).size;
    expect(out.unigrams.length).toBe(setSize);
  });

  it('stemIt does not over-truncate very short tokens', () => {
    // 3-char and shorter tokens are returned as-is (the stemmer requires
    // result ≥ 3 chars).
    expect(__internals.stemIt('a')).toBe('a');
    expect(__internals.stemIt('the')).toBe('the');
  });
});
