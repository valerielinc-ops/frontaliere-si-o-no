import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadArticleReviewOverrides,
  resolveArticleReviewerSlug,
} from '../packages/articles/engine/shared/articleReviewOverrides';

// Issue #6337 (follow-up to PR #6326): `reviewedBy` E-E-A-T signal for
// fiscal/legal (YMYL) articles. The map defaults to `{}` — no article is
// marked reviewed until an editor adds a real entry — so an unset entry
// must never fabricate a review that didn't happen (VISION.md ordine di
// valore #4).

describe('data/article-reviewed-by.json ships empty by default', () => {
  it('is checked in and starts as {} — no fabricated review signal', () => {
    const path = resolve(__dirname, '..', 'packages', 'articles', 'engine', 'shared', 'article-reviewed-by.json');
    const overrides = loadArticleReviewOverrides({ readFileSync }, path);
    expect(overrides).toEqual({});
  });
});

describe('loadArticleReviewOverrides (safe defaults)', () => {
  it('returns {} when the file is missing (never throws, never blocks the build)', () => {
    const overrides = loadArticleReviewOverrides({ readFileSync }, resolve(__dirname, 'does-not-exist.json'));
    expect(overrides).toEqual({});
  });

  it('keeps only string -> string entries', () => {
    const fakeReadFileSync = (() => JSON.stringify({
      'good-article': 'marco-ferrari',
      'number-value': 12345,
      'null-value': null,
    })) as unknown as typeof readFileSync;
    const overrides = loadArticleReviewOverrides({ readFileSync: fakeReadFileSync }, 'irrelevant-path.json');
    expect(overrides).toEqual({ 'good-article': 'marco-ferrari' });
  });
});

describe('resolveArticleReviewerSlug', () => {
  const overrides = { 'reviewed-article': 'marco-ferrari' };

  it('returns the reviewer slug for an article with an entry', () => {
    expect(resolveArticleReviewerSlug('reviewed-article', overrides)).toBe('marco-ferrari');
  });

  it('returns undefined for any article with no override entry (not reviewed by default)', () => {
    expect(resolveArticleReviewerSlug('unreviewed-article', overrides)).toBeUndefined();
  });
});
