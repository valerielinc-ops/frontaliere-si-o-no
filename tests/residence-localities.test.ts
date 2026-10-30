import { describe, expect, it } from 'vitest';
import manifest from '../data/residence-localities/manifest.json';
import { formatResidenceLocation, loadResidenceLocalities, parseResidenceLocation, residenceCountries } from '../services/residenceLocalities';

describe('international concierge residence', () => {
  it('recognizes explicit country names in all site languages without inferring from town names', () => {
    for (const country of ['Italia', 'Italy', 'Italien', 'Italie', 'IT']) expect(parseResidenceLocation(`Como, ${country}`)).toEqual({ town: 'Como', country: 'IT' });
    for (const value of ['Como', '6900', 'Albania', 'Paris, Texas', 'Lugano Switzerland']) expect(parseResidenceLocation(value)).toEqual({ town: value, country: '' });
    expect(parseResidenceLocation('Tiranë, Albanie')).toEqual({ town: 'Tiranë', country: 'AL' });
  });
  it('preserves explicit country provenance on a round trip and supports manual entries', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const value = formatResidenceLocation('Unlisted village', 'AL', locale);
      expect(parseResidenceLocation(value)).toEqual({ town: 'Unlisted village', country: 'AL' });
    }
    expect(formatResidenceLocation('Como', '', 'it')).toBe('Como');
    expect(formatResidenceLocation('', 'IT', 'it')).toBe('');
  });
  it('keeps all current countries selectable, including ones with no catalogue entries', () => {
    expect(residenceCountries('it').some(c => c.code === 'AL' && c.label === 'Albania')).toBe(true);
    expect(residenceCountries('de').some(c => c.code === 'AT' && c.label === 'Österreich')).toBe(true);
    expect(residenceCountries('it').some(c => ['AN', 'CS'].includes(c.code))).toBe(false);
    expect(Object.keys(manifest.countries).length).toBeGreaterThanOrEqual(249);
    expect(manifest.total).toBe(Object.values(manifest.counts).reduce((a, b) => a + b, 0));
  });
  it('loads country-specific suggestions with original accents and blocks invalid country paths', async () => {
    const [italy, albania, invalid] = await Promise.all([loadResidenceLocalities('IT'), loadResidenceLocalities('AL'), loadResidenceLocalities('../')]);
    expect(italy.some(name => name.startsWith('Como ('))).toBe(true);
    expect(albania.some(name => /Tiran/i.test(name))).toBe(true);
    expect(invalid).toEqual([]);
    expect(italy.length).toBe(manifest.counts.IT);
  });
});
