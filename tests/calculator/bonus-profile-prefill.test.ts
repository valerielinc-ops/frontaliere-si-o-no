import { describe, expect, it } from 'vitest';
import { parseProfileChildren } from '@/components/calculator/BonusCalculator';

describe('BonusCalculator profile children prefill', () => {
 it.each([
  ['0', 0],
  ['2', 2],
  ['10', 10],
 ])('accepts the valid profile value %s', (value, expected) => {
  expect(parseProfileChildren(value)).toBe(expected);
 });

 it.each(['2abc', '3.5', '-1', '11', '', ' 2 '])('ignores malformed or out-of-range value %s', value => {
  expect(parseProfileChildren(value)).toBeNull();
 });
});
