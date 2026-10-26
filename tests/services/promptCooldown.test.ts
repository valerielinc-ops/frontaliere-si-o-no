import { describe, expect, it } from 'vitest';
import { isFutureEpochMillis } from '@/services/promptCooldown';

describe('isFutureEpochMillis', () => {
 const now = 1_700_000_000_000;

 it('accepts only a safe decimal deadline in the future', () => {
  expect(isFutureEpochMillis(String(now + 60_000), now)).toBe(true);
  expect(isFutureEpochMillis(String(now - 60_000), now)).toBe(false);
 });

 it('fails open for corrupted, non-decimal, infinite, or unsafe values', () => {
  for (const raw of [null, '', ' ', '123abc', '1e20', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1)]) {
   expect(isFutureEpochMillis(raw, now)).toBe(false);
  }
 });
});
