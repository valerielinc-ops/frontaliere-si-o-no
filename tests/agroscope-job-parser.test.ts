import { describe, expect, it } from 'vitest';

import {
  cleanAgroscopeCity,
  resolveAgroscopeCanton,
} from '../scripts/lib/agroscope-job-parser.mjs';

describe('agroscope job parser location normalization', () => {
  it('accepts one PLZ-city hyphen but keeps separator-only input fail-closed', () => {
    expect(cleanAgroscopeCity('6593 Cadenazzo')).toBe('Cadenazzo');
    expect(cleanAgroscopeCity('6593-Cadenazzo')).toBe('Cadenazzo');
    expect(resolveAgroscopeCanton({ city: '6593-Cadenazzo' })).toBe('TI');

    expect(cleanAgroscopeCity('6593--')).toBe('6593--');
    expect(cleanAgroscopeCity('6593--Cadenazzo')).toBe('6593--Cadenazzo');
    expect(resolveAgroscopeCanton({ city: '6593--' })).toBe('');
  });
});
