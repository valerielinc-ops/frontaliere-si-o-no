import { describe, expect, it } from 'vitest';
import { incrementSessionPageViews } from '@/services/sessionPageViewCounter';

describe('incrementSessionPageViews', () => {
 it('increments valid decimal counters and resets malformed or unsafe values', () => {
  expect(incrementSessionPageViews(null)).toBe(1);
  expect(incrementSessionPageViews('0')).toBe(1);
  expect(incrementSessionPageViews('1')).toBe(2);
  expect(incrementSessionPageViews('not-a-number')).toBe(1);
  expect(incrementSessionPageViews('2junk')).toBe(1);
  expect(incrementSessionPageViews('-1')).toBe(1);
  expect(incrementSessionPageViews(String(Number.MAX_SAFE_INTEGER))).toBe(1);
 });
});
