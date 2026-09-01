import { describe, expect, it } from 'vitest';

import { anchorEvidence, matchedAnchors } from '../scripts/lib/article-factuality-gates.mjs';

describe('anchorNeedle — valori sorgente con metacaratteri regex', () => {
  it('localizza un valore org con un punto letterale', () => {
    const source = 'La societa S.p.A svizzera ha risposto alla richiesta.';
    expect(anchorEvidence(source, 'org:S.p.A')).toBe(source);
    expect(matchedAnchors(source, new Set(['org:S.p.A'])).has('org:S.p.A')).toBe(true);
  });

  it('non interpreta C++ come sintassi regex', () => {
    const source = 'Il gruppo C++ Foundation ha pubblicato lo standard.';
    expect(() => anchorEvidence(source, 'org:C++ Foundation')).not.toThrow();
    expect(anchorEvidence(source, 'org:C++ Foundation')).toBe(source);
  });

  it.each(['1.2.3%', '1,2,3%'])(
    'copre ogni separatore di una percentuale malformata: %s',
    (written) => {
      const source = `Il tasso applicato e del ${written} secondo la fonte.`;
      expect(anchorEvidence(source, 'pct:1.2.3')).toBe(source);
    },
  );
});
