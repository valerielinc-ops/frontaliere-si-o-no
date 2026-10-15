import { describe, it, expect } from 'vitest';
import { isLocationMatch } from '../services/textUtils';

describe('isLocationMatch — whole-token, not substring (#2630)', () => {
  it('does not match a substring city collision', () => {
    expect(isLocationMatch('Bern', 'Bernex')).toBe(false);
    expect(isLocationMatch('Bernex', 'Bern')).toBe(false);
  });

  it('matches exact and accent/case-insensitive', () => {
    expect(isLocationMatch('Zürich', 'zurich')).toBe(true);
    expect(isLocationMatch('Lugano', 'LUGANO')).toBe(true);
  });

  it('matches a token inside a multi-token location (either direction)', () => {
    expect(isLocationMatch('Lugano', 'Lugano-Paradiso')).toBe(true);
    expect(isLocationMatch('Lugano-Paradiso', 'Lugano')).toBe(true);
  });

  it('returns false for empty inputs', () => {
    expect(isLocationMatch('', 'Lugano')).toBe(false);
    expect(isLocationMatch('Lugano', '')).toBe(false);
  });
});
