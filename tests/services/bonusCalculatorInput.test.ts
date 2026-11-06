import { describe, expect, it } from 'vitest';
import { clampBonusInteger, clampBonusNumber, parseBonusProfileChildren } from '@/services/bonusCalculatorInput';

describe('bonus calculator input normalization', () => {
  it('accepts only complete child counts in the UI range', () => {
    expect(parseBonusProfileChildren('2')).toBe(2);
    expect(parseBonusProfileChildren('10')).toBe(10);
    expect(parseBonusProfileChildren('4+')).toBe(4);
    expect(parseBonusProfileChildren('2abc')).toBeNull();
    expect(parseBonusProfileChildren('3.5')).toBeNull();
    expect(parseBonusProfileChildren(' 10 ')).toBeNull();
    expect(parseBonusProfileChildren('11')).toBeNull();
  });

  it('keeps numeric fields finite and inside their limits', () => {
    expect(clampBonusNumber('-2', 5)).toBe(0);
    expect(clampBonusNumber('not-a-number', 5)).toBe(5);
    expect(clampBonusNumber(Infinity, 5)).toBe(5);
    expect(clampBonusNumber(2_000_000, 5)).toBe(1_000_000);
    expect(clampBonusInteger('2.9', 5, 0, 10)).toBe(2);
    expect(clampBonusInteger('bad', 5, 0, 10)).toBe(5);
  });
});
