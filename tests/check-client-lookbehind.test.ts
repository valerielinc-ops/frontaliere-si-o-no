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
import { clientImportClosure, lineHasClientLookbehind, findViolations, stripComments } from '../scripts/ci/check-client-lookbehind.mjs';

describe('check-client-lookbehind — predicate', () => {
  it('flags a real client regex lookbehind in code', () => {
    expect(lineHasClientLookbehind('const re = /(?<=\\s)x/;')).toBe(true);
    expect(lineHasClientLookbehind('s.split(/(?<![.!?])\\s/)')).toBe(true);
    expect(lineHasClientLookbehind('const re = /(?<=x)/; // trailing comment')).toBe(true);
  });

  it('does NOT flag comments describing the old removed lookbehind (#1996)', () => {
    expect(lineHasClientLookbehind('  // each token exactly like the old /(?<=\\s)/ split did.')).toBe(false);
    expect(lineHasClientLookbehind('  // ...crash on (?<=…) and the')).toBe(false);
    expect(stripComments('/*\n   * equivalent to the old /(?<=[.!?])\\s+/ split.\n*/')).not.toContain('(?<=');
  });

  it('does NOT flag ordinary code or non-capturing groups', () => {
    expect(lineHasClientLookbehind('const re = /(?:abc)+/;')).toBe(false);
    expect(lineHasClientLookbehind('const x = a < b ? 1 : 2;')).toBe(false);
    expect(lineHasClientLookbehind('')).toBe(false);
  });

  it('keeps code after URL and string literals visible', () => {
    expect(lineHasClientLookbehind('const url = "https://example.test"; const re = /(?<=x)/;')).toBe(true);
    expect(lineHasClientLookbehind("const text = '// not a comment'; const re = /(?<!x)/;")).toBe(true);
  });

  it('does not treat a code line beginning with * as a comment', () => {
    expect(lineHasClientLookbehind('*value = /(?<=x)/;')).toBe(true);
  });

  it('keeps regex literals opaque to comment detection', () => {
    const masked = stripComments('const url = /https?:\\/\\/example.test/; // (?<=x)');
    expect(masked).toContain('https?:\\/\\/example.test');
    expect(masked).not.toContain('(?<=x)');
    expect(lineHasClientLookbehind('const url = /https?:\\/\\/example.test/; // (?<=x)')).toBe(false);
  });

  it('carries block-comment state across lines', () => {
    const source = '/* hidden (?<=x)\n * still hidden (?<!x)\n */ const re = /(?<=x)/;';
    expect(stripComments(source)).not.toContain('hidden');
    expect(stripComments(source).split('\n')[2]).toContain('(?<=x)');
  });

  it('scans template interpolations, including nested templates, as code', () => {
    const source = 'const value = `${ok ? /(?<=x)/.test(input) : `nested ${/(?<!y)/}`}`;';
    const masked = stripComments(source);
    expect(masked).toContain('(?<=x)');
    expect(masked).toContain('(?<!y)');
  });

  it('does not report lookbehind text inside interpolation comments', () => {
    const source = 'const value = `${input /* hidden (?<=comment) */} ${/(?<=x)/}`;';
    const masked = stripComments(source);
    expect(masked).not.toContain('(?<=comment)');
    expect(masked).toContain('(?<=x)');
  });
});

describe('check-client-lookbehind — tree invariant', () => {
  it('follows browser imports into shared build modules', () => {
    const closure = clientImportClosure();
    expect(closure).toContain('build-plugins/shared/jobPostingSchema.ts');
    expect(closure).toContain('build-plugins/shared/safeTruncate.ts');
    expect(closure).not.toContain('scripts/lib/job-title-normalization.mjs');
  });

  it('the current client-bundled tree has no regex lookbehind', () => {
    expect(findViolations()).toEqual([]);
  });
});
