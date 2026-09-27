import { describe, expect, it } from 'vitest';
import { isCurrentPublishSource } from '../../scripts/lib/article-chunk-publish-freshness.mjs';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

describe('article chunk publish freshness fence', () => {
  it('allows the checkout at the current main tip', () => {
    expect(isCurrentPublishSource(NEW_SHA, NEW_SHA)).toBe(true);
    expect(isCurrentPublishSource(NEW_SHA.toUpperCase(), NEW_SHA)).toBe(true);
  });

  it('flags an older checkout for refresh after main moves', () => {
    // This is the ordering the section lease alone cannot prevent: the new run
    // wins the lease first, then the old queued run acquires it afterwards.
    // The workflows use false as a signal to re-render origin/main, not to
    // silently skip the publish.
    expect(isCurrentPublishSource(OLD_SHA, NEW_SHA)).toBe(false);
  });

  it('fails closed for malformed source or main SHAs', () => {
    expect(() => isCurrentPublishSource('old', NEW_SHA)).toThrow(/source SHA/);
    expect(() => isCurrentPublishSource(OLD_SHA, 'new')).toThrow(/main SHA/);
  });
});
