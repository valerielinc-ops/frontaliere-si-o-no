/**
 * Tests for scripts/lib/fact-check-consensus.mjs — cross-model dedup
 * and weighted-severity blocking for llmFactCheck.
 *
 * Regression anchor: 2026-05-11 runs 25690785422 / 25688066828 blocked
 * 26 articles at `allMajor.length >= 3`. Of those, ~16 were borderline
 * 3-5 majors driven mainly by `statistiche` (specific numbers an LLM
 * cannot verify without web search) — false-positive density.
 *
 * Quality bar that must NOT regress:
 *   - Critical issues continue to hard-block in the caller (not tested
 *     here — that lives in llmFactCheck consensus logic which is
 *     covered by integration tests).
 *   - 3 high-trust majors (leggi/persone/istituzioni/fatti_inventati/
 *     date/aliquote/eu_svizzera/rilevanza_topica/geografia) still
 *     produce a blocking score.
 *   - Mixed high+low trust majors still block at ≥3.0 sum.
 */

import { describe, expect, it } from 'vitest';
import {
  factCheckFingerprint,
  factCheckMajorWeight,
  totalMajorWeight,
  LOW_TRUST_MAJOR_CATEGORIES,
  MAJOR_BLOCK_WEIGHT_THRESHOLD,
} from '../scripts/lib/fact-check-consensus.mjs';

describe('factCheckFingerprint — cross-model dedup', () => {
  it('collapses two phrasings of the same numeric claim', () => {
    const a = factCheckFingerprint({
      category: 'statistiche',
      claim: 'Il prezzo medio del carburante in Ticino è di circa 1.80 CHF al litro',
    });
    const b = factCheckFingerprint({
      category: 'statistiche',
      claim: '1.80 CHF/litro carburante medio Ticino non verificabile',
    });
    expect(a).toBe(b);
    expect(a).toBe('statistiche:num:1.80');
  });

  it('normalizes 1,80 / 1.80 / 1.80 CHF to the same fingerprint', () => {
    const a = factCheckFingerprint({ category: 'aliquote', claim: 'Aliquota del 1,80%' });
    const b = factCheckFingerprint({ category: 'aliquote', claim: 'Aliquota 1.80 percento' });
    expect(a).toBe(b);
  });

  it('keeps different numbers distinct (same category)', () => {
    const a = factCheckFingerprint({ category: 'statistiche', claim: 'Premio LAMal 350 CHF' });
    const b = factCheckFingerprint({ category: 'statistiche', claim: 'Premio CMI 400 CHF' });
    expect(a).not.toBe(b);
  });

  it('keeps the same number under different categories distinct', () => {
    const a = factCheckFingerprint({ category: 'statistiche', claim: 'X dato 350' });
    const b = factCheckFingerprint({ category: 'aliquote', claim: 'Y aliquota 350' });
    expect(a).not.toBe(b);
  });

  it('collapses two phrasings of the same entity claim (no number)', () => {
    // Both flag the same fabricated person claim — different wording.
    const a = factCheckFingerprint({
      category: 'persone',
      claim: 'Andreoli non è un funzionario svizzero o italiano verificabile',
    });
    const b = factCheckFingerprint({
      category: 'persone',
      claim: 'Andreoli non è verificabile come funzionario noto',
    });
    // Words fingerprints are sorted-3-tokens — these share andreol/funzion/verific
    // after stoplist+stem. They should collapse to the same key.
    expect(a).toBe(b);
  });

  it('keeps different entity claims distinct', () => {
    const a = factCheckFingerprint({
      category: 'istituzioni',
      claim: 'San Marino RTV non esiste come istituzione fiscale',
    });
    const b = factCheckFingerprint({
      category: 'istituzioni',
      claim: 'UFAS non gestisce le pensioni AVS in questo modo',
    });
    expect(a).not.toBe(b);
  });

  it('handles empty / missing claim safely', () => {
    const fp = factCheckFingerprint({ category: 'statistiche', claim: '' });
    expect(fp).toMatch(/^statistiche:empty:/);
  });

  it('handles missing category', () => {
    const fp = factCheckFingerprint({ claim: 'Some claim 42' });
    expect(fp).toBe('?:num:42');
  });
});

describe('factCheckMajorWeight', () => {
  it('weights low-trust LLM-unverifiable categories at 0.5', () => {
    expect(factCheckMajorWeight({ category: 'statistiche' })).toBe(0.5);
    expect(factCheckMajorWeight({ category: 'coerenza' })).toBe(0.5);
  });

  it('weights high-trust falsifiable categories at 1.0', () => {
    for (const cat of [
      'leggi', 'persone', 'istituzioni', 'fatti_inventati',
      'date', 'aliquote', 'eu_svizzera', 'rilevanza_topica',
      'geografia', 'procedure',
    ]) {
      expect(factCheckMajorWeight({ category: cat })).toBe(1.0);
    }
  });

  it('defaults unknown categories to 1.0 (conservative)', () => {
    expect(factCheckMajorWeight({ category: 'mystery-future-category' })).toBe(1.0);
    expect(factCheckMajorWeight({})).toBe(1.0);
  });

  it('exposes the low-trust set for inspection', () => {
    expect(LOW_TRUST_MAJOR_CATEGORIES.has('statistiche')).toBe(true);
    expect(LOW_TRUST_MAJOR_CATEGORIES.has('coerenza')).toBe(true);
    expect(LOW_TRUST_MAJOR_CATEGORIES.has('leggi')).toBe(false);
  });
});

describe('totalMajorWeight — blocking threshold scenarios', () => {
  const stat = { category: 'statistiche' };
  const coh = { category: 'coerenza' };
  const law = { category: 'leggi' };
  const fab = { category: 'fatti_inventati' };
  const inst = { category: 'istituzioni' };

  it('5 statistiche-only majors → 2.5 (NOT blocked) — fixes the 2026-05-11 false positives', () => {
    const score = totalMajorWeight([stat, stat, stat, stat, stat]);
    expect(score).toBe(2.5);
    expect(score < MAJOR_BLOCK_WEIGHT_THRESHOLD).toBe(true);
  });

  it('6 statistiche majors → 3.0 (blocked) — extreme noise still trips', () => {
    expect(totalMajorWeight([stat, stat, stat, stat, stat, stat])).toBe(3.0);
  });

  it('3 leggi majors → 3.0 (blocked) — quality bar preserved', () => {
    expect(totalMajorWeight([law, law, law])).toBe(3.0);
  });

  it('3 fatti_inventati majors → 3.0 (blocked)', () => {
    expect(totalMajorWeight([fab, fab, fab])).toBe(3.0);
  });

  it('2 statistiche + 2 fatti_inventati → 3.0 (blocked) — mixed but high-trust dominant', () => {
    expect(totalMajorWeight([stat, stat, fab, fab])).toBe(3.0);
  });

  it('2 statistiche + 1 leggi → 2.0 (passes with warning)', () => {
    expect(totalMajorWeight([stat, stat, law])).toBe(2.0);
  });

  it('1 statistiche + 1 coerenza → 1.0 (passes with warning)', () => {
    expect(totalMajorWeight([stat, coh])).toBe(1.0);
  });

  it('empty array → 0.0 (no concerns)', () => {
    expect(totalMajorWeight([])).toBe(0);
  });

  it('threshold constant matches the documented value', () => {
    expect(MAJOR_BLOCK_WEIGHT_THRESHOLD).toBe(3.0);
  });

  it('1 istituzioni + 1 leggi + 1 statistiche → 2.5 (passes — only 2 high-trust + 0.5)', () => {
    // Edge: this is BELOW threshold. Acceptable: 2 verifiable concerns is
    // not enough to block on its own under the new rules, and the
    // statistiche concern is noise. If they were truly false they'd be
    // critical, which still hard-blocks unchanged.
    expect(totalMajorWeight([inst, law, stat])).toBe(2.5);
    expect(totalMajorWeight([inst, law, stat]) < MAJOR_BLOCK_WEIGHT_THRESHOLD).toBe(true);
  });
});
