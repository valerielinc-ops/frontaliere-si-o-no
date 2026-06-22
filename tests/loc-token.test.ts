import { describe, it, expect } from 'vitest';
import { locTokenHit } from '../services/locToken.mjs';

describe('locTokenHit — whole-token geo match (#2630)', () => {
  it('does not match a substring city collision', () => {
    expect(locTokenHit('bernex geneva ge', 'bern')).toBe(false);
    expect(locTokenHit('berna italia', 'bern')).toBe(false);
  });

  it('matches a delimited whole token', () => {
    expect(locTokenHit('bern be switzerland', 'bern')).toBe(true);
    expect(locTokenHit('lugano-paradiso ti', 'lugano')).toBe(true);
    expect(locTokenHit('6900 lugano, ti', 'lugano')).toBe(true);
  });

  it('matches a multi-word phrase as a token sequence', () => {
    expect(locTokenHit('san gallo sg', 'san gallo')).toBe(true);
    expect(locTokenHit('sankt gallen', 'san gallo')).toBe(false);
  });

  it('is unicode-boundary aware', () => {
    expect(locTokenHit('zürich zh', 'zürich')).toBe(true);
  });

  it('empty needle never matches', () => {
    expect(locTokenHit('lugano', '')).toBe(false);
  });
});
