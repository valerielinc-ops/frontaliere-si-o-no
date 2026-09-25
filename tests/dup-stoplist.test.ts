/**
 * Tests for scripts/lib/dup-stoplist.mjs — the domain-token stoplist that
 * makes preFlightHeadlineCheck discriminate on distinctive content
 * instead of saturated structural vocabulary.
 *
 * Regression anchor: 2026-05-11 run 25690785422 dropped 92/249
 * headlines at the topic-similarity gate; 81 of those drops were
 * at the exact 0.75 threshold because the corpus had so many IDs
 * containing the structural tokens `frontaliere/svizzera/ticino`
 * that any new headline overlapped ≥75% with something.
 */

import { describe, expect, it } from 'vitest';
import { DOMAIN_DUP_STOPLIST, filterDistinctive } from '../scripts/lib/dup-stoplist.mjs';
import { tokenizeIt } from '../scripts/lib/it-text-similarity.mjs';

describe('DOMAIN_DUP_STOPLIST', () => {
  it('contains the canonical synonym forms that recur in most IDs', () => {
    for (const word of ['frontaliere', 'svizzera', 'italia', 'ticino', 'lavoro', 'permesso', 'imposta', 'pensione']) {
      expect(DOMAIN_DUP_STOPLIST.has(word)).toBe(true);
    }
  });

  it('does NOT contain distinctive content words', () => {
    for (const word of ['disoccupa', 'apprend', 'riform', 'tassa', 'salute', 'maternita', 'asilo', 'sciopero']) {
      expect(DOMAIN_DUP_STOPLIST.has(word)).toBe(false);
    }
  });
});

describe('filterDistinctive', () => {
  it('strips the structural tokens from a headline tokenization', () => {
    const headline = 'Frontalieri Svizzera-Italia: nuove regole sulla disoccupazione';
    const distinctive = filterDistinctive(tokenizeIt(headline));
    expect(distinctive).not.toContain('frontaliere');
    expect(distinctive).not.toContain('svizzera');
    expect(distinctive).not.toContain('italia');
    expect(distinctive).not.toContain('nuovo');
    // 'regola' and 'disoccupa' stems should survive
    expect(distinctive.some(t => t.startsWith('regol'))).toBe(true);
    expect(distinctive.some(t => t.startsWith('disoccup'))).toBe(true);
  });

  it('returns empty for a headline made of nothing but structural tokens', () => {
    expect(filterDistinctive(tokenizeIt('Frontaliere svizzera italia ticino lavoro'))).toEqual([]);
  });

  it('passes through a headline with all-distinctive vocabulary', () => {
    const input = ['sciopero', 'cantiere', 'autostrada'];
    expect(filterDistinctive(input)).toEqual(input);
  });

  it('removes the 18:56 false-positive structural overlap', () => {
    // 2026-05-11 run 25690785422: this headline was dropped at
    // id_containment=0.75 against svizzera-disoccupazione-frontalieri-quadri.
    // After filterDistinctive, neither side has enough structural-token
    // overlap to trigger the gate at 0.75 of the *distinctive* tokens.
    const headline = 'Frontalieri, la disoccupazione la pagherà lo Stato dove lavorano';
    const id = 'svizzera-disoccupazione-frontalieri-quadri';

    const hd = new Set(filterDistinctive(tokenizeIt(headline)));
    const idd = new Set(filterDistinctive(tokenizeIt(id)));

    const idArr = [...idd];
    // distinctive ID tokens are ['disoccup', 'quadr'] (or similar after stemming) —
    // less than the 3-token minimum, so ID containment is SKIPPED at the call site
    // and the gate falls through to title Jaccard (with a stricter denominator).
    expect(idArr.length).toBeLessThan(3);
  });
});
