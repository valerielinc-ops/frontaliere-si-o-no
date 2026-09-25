import { describe, it, expect } from 'vitest';
import { shouldSkipFullSuiteFallback } from '../../scripts/ci/lib/orphan-fallback.mjs';

describe('shouldSkipFullSuiteFallback', () => {
  it('skips the full-suite fallback when every changed file has zero importers anywhere', () => {
    const reverse = new Map();
    expect(shouldSkipFullSuiteFallback(['scripts/prospect-validate.mjs'], reverse)).toBe(true);
  });

  it('keeps the full-suite fallback when a changed file has a non-test importer', () => {
    const reverse = new Map([['scripts/lib/foo.mjs', ['scripts/other-cli.mjs']]]);
    expect(shouldSkipFullSuiteFallback(['scripts/lib/foo.mjs'], reverse)).toBe(false);
  });

  it('keeps the fallback when only SOME of several changed files are orphans', () => {
    const reverse = new Map([['scripts/lib/foo.mjs', ['scripts/other-cli.mjs']]]);
    expect(
      shouldSkipFullSuiteFallback(['scripts/prospect-validate.mjs', 'scripts/lib/foo.mjs'], reverse),
    ).toBe(false);
  });

  it('returns false for an empty candidate list (no-op, never reached in practice)', () => {
    expect(shouldSkipFullSuiteFallback([], new Map())).toBe(false);
  });

  it('treats a reverse entry with an empty importer array the same as no entry', () => {
    const reverse = new Map([['scripts/prospect-validate.mjs', []]]);
    expect(shouldSkipFullSuiteFallback(['scripts/prospect-validate.mjs'], reverse)).toBe(true);
  });
});
