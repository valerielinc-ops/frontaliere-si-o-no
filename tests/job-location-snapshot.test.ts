import { describe, expect, it } from 'vitest';
import { deriveJobPostalCode, getJobLocationSnapshot } from '@/services/jobLocationSnapshot';

describe('jobLocationSnapshot', () => {
  it('returns postal code and commuter-friendly nearest crossings for Riazzino', () => {
    const snapshot = getJobLocationSnapshot({ location: 'Riazzino' });

    expect(snapshot?.postalCode).toBe('6595');
    expect(snapshot?.crossings.map((item) => item.name)).toEqual([
      'Luino-Fornasette',
      'Ponte Tresa',
      'San Pietro (Clivio-Stabio)',
    ]);
  });

  it('derives postal codes from centralized aliases and target cities', () => {
    expect(deriveJobPostalCode({ addressLocality: 'Bedano, CH, 6930' })).toBe('6930');
    expect(deriveJobPostalCode({ location: 'Coira, Switzerland' })).toBe('7000');
    expect(deriveJobPostalCode({ location: 'Canton Ticino' })).toBe('6900');
  });
});
