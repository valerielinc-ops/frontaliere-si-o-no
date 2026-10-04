import { describe, expect, it } from 'vitest';
import { normalizeSourceExpiryDate } from '../scripts/lib/source-expiry-date.mjs';

describe('source expiry date independent of publication', () => {
  it('normalizes the slash date without rejecting a future deadline', () => {
    expect(normalizeSourceExpiryDate('2099/12/31')).toBe('2099-12-31');
  });
  it('preserves a complete ISO deadline including its offset', () => {
    expect(normalizeSourceExpiryDate('2099-12-31T23:30:00+02:00')).toBe('2099-12-31T23:30:00+02:00');
  });
  it.each(['', '2026/02/30', '2026-12-31T99:00:00Z', '2026-12-31T23:00:00', 'not a date'])('rejects invalid or ambiguous expiry %j', (raw) => {
    expect(normalizeSourceExpiryDate(raw)).toBe('');
  });
});
