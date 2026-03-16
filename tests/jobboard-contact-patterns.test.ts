import { describe, expect, it } from 'vitest';

import { isLikelyPhone } from '@/components/community/JobBoard.tsx';

describe('jobboard contact patterns', () => {
  it('does not treat school-year ranges as phone numbers', () => {
    expect(isLikelyPhone('2026/2027')).toBe(false);
    expect(isLikelyPhone('anno scolastico 2026/2027')).toBe(false);
  });

  it('does not treat ISO dates as phone numbers', () => {
    expect(isLikelyPhone('2026-03-27')).toBe(false);
  });

  it('still recognizes actual phone numbers', () => {
    expect(isLikelyPhone('+41 91 123 45 67')).toBe(true);
    expect(isLikelyPhone('091 123 45 67')).toBe(true);
  });
});
