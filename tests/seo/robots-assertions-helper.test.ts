// @vitest-environment node
/**
 * Self-test for `tests/helpers/robotsAssertions.ts` (issue #5001).
 *
 * A shared assertion helper that cannot fail is worse than the string match it
 * replaced: it would let every caller pass while the property silently rots.
 * These tests pin that it rejects each way the property can be violated —
 * including the OLD plain `index,follow` directive, which is exactly the state
 * this PR moved the site away from.
 */
import { describe, expect, it } from 'vitest';

import {
  expectIndexableWithLargePreview,
  expectNoindex,
  robotsDirectiveOf,
} from '../helpers/robotsAssertions';

describe('expectIndexableWithLargePreview', () => {
  it('rejects the OLD plain indexable directive', () => {
    expect(() =>
      expectIndexableWithLargePreview('<meta name="robots" content="index,follow">'),
    ).toThrow();
  });

  it('rejects a noindex page', () => {
    expect(() =>
      expectIndexableWithLargePreview('<meta name="robots" content="noindex,follow">'),
    ).toThrow();
  });

  it('rejects a page with no robots meta at all', () => {
    expect(() => expectIndexableWithLargePreview('<html><head></head></html>')).toThrow();
  });

  it('rejects a directive that keeps indexing but drops large previews', () => {
    expect(() =>
      expectIndexableWithLargePreview(
        '<meta name="robots" content="index, follow, max-image-preview:standard">',
      ),
    ).toThrow();
  });

  it('accepts the canonical directive, minified attribute quoting included', () => {
    // dist/ is minified: single-token attribute values lose their quotes.
    expect(() =>
      expectIndexableWithLargePreview(
        '<meta name=robots content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">',
      ),
    ).not.toThrow();
  });
});

describe('expectNoindex', () => {
  it('accepts a noindex page and rejects an indexable one', () => {
    expect(() => expectNoindex('<meta name="robots" content="noindex,follow">')).not.toThrow();
    expect(() =>
      expectNoindex('<meta name="robots" content="index, follow, max-image-preview:large">'),
    ).toThrow();
  });
});

describe('robotsDirectiveOf', () => {
  it('extracts the directive whatever the quoting', () => {
    expect(robotsDirectiveOf('<meta name=robots content="noindex,follow">')).toBe('noindex,follow');
    expect(robotsDirectiveOf("<meta name='robots' content='index,follow'>")).toBe('index,follow');
    expect(robotsDirectiveOf('<html><head></head></html>')).toBeNull();
  });
});
