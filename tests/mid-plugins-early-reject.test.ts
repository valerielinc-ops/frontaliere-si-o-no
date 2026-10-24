import { describe, it, expect } from 'vitest';

import { makeStartsWithAnyPrefix } from '../build-plugins/shared/prefixMatcher';

describe('makeStartsWithAnyPrefix', () => {
  const prefixes = [
    '/cerca-lavoro-ticino/',
    '/cerca-lavoro-zurigo/',
    '/en/find-jobs-ticino/',
    '/de/jobs-im-tessin/',
    '/fr/emplois-tessin/',
    '/de/stellenangebote-tessin/',
  ];
  const linear = (p: string): boolean => prefixes.some((prefix) => p.startsWith(prefix));
  const fast = makeStartsWithAnyPrefix(prefixes);

  it('agrees with the linear startsWith on a grid of shapes', () => {
    const heads = ['', '/', '/cerca-lavoro-ticino', '/cerca-lavoro-ticino/', '/en', '/en/', '/en/find-jobs-ticino',
      '/en/find-jobs-ticino/', '/de/jobs-im-tessin/', '/de/jobs-im-tessinx/', '/fr/emplois-tessin/', '/de/', '/it/',
      '/cerca-lavoro-svizzera/', '/cerca-lavoro-ticino-x/', 'cerca-lavoro-ticino/', '//cerca-lavoro-ticino/'];
    const tails = ['', 'a', 'a/', 'a/b/', 'ricerca-x/', '.html'];
    for (const h of heads) for (const t of tails) {
      const p = h + t;
      expect(fast(p), JSON.stringify(p)).toBe(linear(p));
    }
  });

  it('falls back to the linear scan for prefixes of another shape', () => {
    const odd = ['/a/b/c/', 'x/'];
    const m = makeStartsWithAnyPrefix(odd);
    for (const p of ['/a/b/c/d', '/a/b/', 'x/y', '/x/']) {
      expect(m(p)).toBe(odd.some((prefix) => p.startsWith(prefix)));
    }
  });
});
