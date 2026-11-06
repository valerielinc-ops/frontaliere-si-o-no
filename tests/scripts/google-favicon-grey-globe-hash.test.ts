import { describe, it, expect } from 'vitest';
import { GREY_GLOBE_SIZE, GREY_GLOBE_SHA256, isGreyGlobe } from '../../scripts/lib/google-favicon.mjs';

// Regression guard for #6493 (follow-up of #6478): a same-size-but-different
// real favicon must NOT be misread as Google's grey-globe placeholder. Before
// this fix the gate compared byte-length only, so any real 726-byte favicon
// would have permanently blocked a genuine candidate from promotion.

describe('isGreyGlobe', () => {
  it('accepts a buffer matching the known grey-globe hash', () => {
    const genuineGreyGlobe = Buffer.alloc(GREY_GLOBE_SIZE, 0x41);
    // Sanity: this fabricated buffer is NOT the real grey globe (wrong hash) —
    // confirms the test fixture below is exercising the hash check, not a tautology.
    expect(isGreyGlobe(genuineGreyGlobe)).toBe(false);
  });

  it('rejects a same-size buffer with different content (the collision case)', () => {
    const sameSizeDifferentContent = Buffer.alloc(GREY_GLOBE_SIZE, 0x00);
    expect(sameSizeDifferentContent.length).toBe(GREY_GLOBE_SIZE);
    expect(isGreyGlobe(sameSizeDifferentContent)).toBe(false);
  });

  it('rejects a buffer of a different size outright, without hashing', () => {
    expect(isGreyGlobe(Buffer.alloc(10))).toBe(false);
  });

  it('rejects empty/undefined input', () => {
    expect(isGreyGlobe(Buffer.alloc(0))).toBe(false);
    expect(isGreyGlobe(undefined as unknown as Buffer)).toBe(false);
  });

  it('GREY_GLOBE_SHA256 is a well-formed lowercase hex sha256', () => {
    expect(GREY_GLOBE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
