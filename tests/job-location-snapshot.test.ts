import { describe, expect, it } from 'vitest';
import { deriveJobPostalCode, getJobLocationSnapshot, resolveJobPostingPostalCode } from '@/services/jobLocationSnapshot';
import { postalCodeBelongsToLocality } from '@/build-plugins/shared/postalCodes';

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
    // …and must not print that CAP next to Zurich either (#9841).
    expect(snapshot?.postalCode).toBeUndefined();
  });

  it('omits an HQ postal code that belongs to another locality (#9841)', () => {
    // Helsana stamps 8600 (Dübendorf) on every vacancy: the SPA sidebar must
    // not print "Chur · CAP 8600" or "Lausanne · CAP 8600".
    for (const city of ['Chur', 'Lausanne', 'Worblaufen']) {
      const snapshot = getJobLocationSnapshot({ location: city, addressLocality: city, postalCode: '8600' });
      expect(snapshot?.locality).toBe(city);
      expect(snapshot?.postalCode, city).toBeUndefined();
    }
    // Mentioning Bern later in the name does not inherit Bern's CAP.
    expect(getJobLocationSnapshot({ addressLocality: 'Muri bei Bern', postalCode: '3001' })?.postalCode).toBeUndefined();
  });

  it('keeps an explicit postal code of the job locality, decorated or unknown to the snapshot', () => {
    const stettbach = { location: 'Dübendorf-Stettbach', addressLocality: 'Dübendorf-Stettbach', postalCode: '8600' };
    expect(getJobLocationSnapshot(stettbach)?.postalCode).toBe('8600');
    expect(getJobLocationSnapshot({ addressLocality: 'Gossau SG', postalCode: '9200' })?.postalCode).toBe('9200');
    // 8005 is not in the postal snapshot: no contradiction can be proven.
    expect(getJobLocationSnapshot({ addressLocality: 'Zürich', postalCode: '8005' })?.postalCode).toBe('8005');
  });

  it('pairs the client-side JobPosting CAP with its own locality, like the static builder (#9841)', () => {
    // HQ CAP on a Chur vacancy: replaced by Chur's own, and the caller is told
    // to drop the source street that travels with the HQ CAP.
    expect(resolveJobPostingPostalCode({ location: 'Chur', addressLocality: 'Chur', postalCode: '8600' }, 'Chur', 'GR'))
      .toEqual({ postalCode: '7000', sourcePostalCoherent: false });
    // No source CAP and a locality the seeds do not know: never publish the
    // canton-capital CAP next to a different locality when the same guard can
    // prove the pairing is false.
    expect(resolveJobPostingPostalCode({ location: 'Worblaufen', addressLocality: 'Worblaufen' }, 'Worblaufen', 'BE'))
      .toEqual({ postalCode: '', sourcePostalCoherent: true });
    // A coherent source CAP, plain or decorated, stays with its street.
    expect(resolveJobPostingPostalCode({ addressLocality: 'Lugano', postalCode: '6900' }, 'Lugano', 'TI'))
      .toEqual({ postalCode: '6900', sourcePostalCoherent: true });
    expect(resolveJobPostingPostalCode({ addressLocality: 'Dübendorf-Stettbach', postalCode: '8600' }, 'Dübendorf-Stettbach', 'ZH'))
      .toEqual({ postalCode: '8600', sourcePostalCoherent: true });
    const guardedFallback = resolveJobPostingPostalCode(
      { addressLocality: 'Dübendorf-Stettbach', postalCode: '3001' },
      'Dübendorf-Stettbach',
      'ZH',
    );
    expect(postalCodeBelongsToLocality('Dübendorf-Stettbach', guardedFallback.postalCode)).toBe(true);
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
