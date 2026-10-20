import { describe, expect, it } from 'vitest';
import { shouldAdvanceLastKnownGood } from '../scripts/lib/last-known-good-order.mjs';

describe('last_known_good ordering', () => {
  it('accepts the first candidate and newer run IDs', () => {
    expect(shouldAdvanceLastKnownGood(null, '36706643053')).toBe(true);
    expect(shouldAdvanceLastKnownGood('36706643053', '36706643054')).toBe(true);
  });

  it('keeps the current rollback target when an older tail finishes late', () => {
    expect(shouldAdvanceLastKnownGood('36706643054', '36706643053')).toBe(false);
    expect(shouldAdvanceLastKnownGood(36706643054, 36706643054)).toBe(true);
  });

  it('rejects malformed or unsafe candidate run IDs', () => {
    expect(shouldAdvanceLastKnownGood(null, '')).toBe(false);
    expect(shouldAdvanceLastKnownGood(null, 'not-a-run')).toBe(false);
    expect(shouldAdvanceLastKnownGood(null, '9007199254740992')).toBe(false);
  });
});
