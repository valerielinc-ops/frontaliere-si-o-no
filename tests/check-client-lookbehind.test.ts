/**
 * Lock test for the zero-Claude gate `scripts/ci/check-client-lookbehind.mjs`
 * (#1996 → follow-up #1999, monetization-critical).
 *
 * A client-shipped regex lookbehind ((?<=/(?<!) crashes older Safari/WebKit at
 * parse time ("invalid group specifier name"), which broke job-detail render for
 * Google Jobs traffic. The gate forbids lookbehind in client-bundled source while
 * allowing it in build-time (Node) paths, and must NOT flag the comments the
 * #1996 fix left describing the old removed regex.
 */
import { describe, it, expect } from 'vitest';
import { lineHasClientLookbehind, findViolations } from '../scripts/ci/check-client-lookbehind.mjs';

describe('check-client-lookbehind — predicate', () => {
  it('flags a real client regex lookbehind in code', () => {
    expect(lineHasClientLookbehind('const re = /(?<=\\s)x/;')).toBe(true);
    expect(lineHasClientLookbehind('s.split(/(?<![.!?])\\s/)')).toBe(true);
    expect(lineHasClientLookbehind('const re = /(?<=x)/; // trailing comment')).toBe(true);
  });

  it('does NOT flag comments describing the old removed lookbehind (#1996)', () => {
    expect(lineHasClientLookbehind('  // each token exactly like the old /(?<=\\s)/ split did.')).toBe(false);
    expect(lineHasClientLookbehind('  // ...crash on (?<=…) and the')).toBe(false);
    expect(lineHasClientLookbehind('   * equivalent to the old /(?<=[.!?])\\s+/ split.')).toBe(false);
  });

  it('does NOT flag ordinary code or non-capturing groups', () => {
    expect(lineHasClientLookbehind('const re = /(?:abc)+/;')).toBe(false);
    expect(lineHasClientLookbehind('const x = a < b ? 1 : 2;')).toBe(false);
    expect(lineHasClientLookbehind('')).toBe(false);
  });
});

describe('check-client-lookbehind — tree invariant', () => {
  it('the current client-bundled tree has no regex lookbehind', () => {
    expect(findViolations()).toEqual([]);
  });
});
