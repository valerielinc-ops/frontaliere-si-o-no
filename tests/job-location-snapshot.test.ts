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

  it('does not let a stray HQ postal code override an explicit out-of-canton city', () => {
    // A Zurich job carrying a Ticino seat CAP (6500) must show Zurich, not
    // Bellinzona, and must surface no Ticino border crossings.
    const snapshot = getJobLocationSnapshot({
      location: 'Zurich',
      addressLocality: 'Zurich',
      postalCode: '6500',
    });
    expect(snapshot?.locality).toBe('Zurich');
    expect(snapshot?.crossings).toEqual([]);
  });

  it('still trusts a postal code consistent with the locality', () => {
    // Same-city (Bellinzona/6500) keeps the seed + crossings.
    const bellinzona = getJobLocationSnapshot({ addressLocality: 'Bellinzona', postalCode: '6500' });
    expect(bellinzona?.locality).toBe('Bellinzona');
    expect(bellinzona?.crossings.length).toBeGreaterThan(0);
    // A comune sharing the Lugano CAP (Massagno/6900) still resolves to the hub.
    const massagno = getJobLocationSnapshot({ addressLocality: 'Massagno', postalCode: '6900' });
    expect(massagno?.locality).toBe('Lugano');
  });
});
