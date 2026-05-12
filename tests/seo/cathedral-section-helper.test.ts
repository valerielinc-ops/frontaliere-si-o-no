import { describe, it, expect } from 'vitest';
import { resolveCantonSection, resolveJobCanton } from '../../build-plugins/shared/cantonSection';
import { getCantonCities, getCityCanton, normalizeCitySlug } from '../../build-plugins/shared/cantonCities';

describe('resolveCantonSection — TI legacy invariance', () => {
  it.each(['it','en','de','fr'] as const)('TI returns frozen legacy slug for %s', (locale) => {
    const legacy = { it: 'cerca-lavoro-ticino', en: 'find-jobs-ticino', de: 'jobs-im-tessin', fr: 'trouver-emploi-tessin' } as const;
    expect(resolveCantonSection(locale, 'TI')).toBe(legacy[locale]);
  });
});

describe('resolveCantonSection — canton-aware emission', () => {
  it('ZH IT → cerca-lavoro-zurigo', () => {
    expect(resolveCantonSection('it', 'ZH')).toBe('cerca-lavoro-zurigo');
  });
  it('AG DE → jobs-im-aargau (definite article preserved)', () => {
    expect(resolveCantonSection('de', 'AG')).toBe('jobs-im-aargau');
  });
  it('VD DE → jobs-in-der-waadt', () => {
    expect(resolveCantonSection('de', 'VD')).toBe('jobs-in-der-waadt');
  });
  it('AGGREGATE_KEY → cerca-lavoro-svizzera', () => {
    expect(resolveCantonSection('it', '_AGGREGATE_')).toBe('cerca-lavoro-svizzera');
  });
  it('Half-canton AI/AR collapses to APPENZELLO group', () => {
    expect(resolveCantonSection('it', 'AI')).toBe('cerca-lavoro-appenzello');
    expect(resolveCantonSection('it', 'AR')).toBe('cerca-lavoro-appenzello');
  });
  it('BL/BS collapses to BASILEA group', () => {
    expect(resolveCantonSection('it', 'BL')).toBe('cerca-lavoro-basilea');
    expect(resolveCantonSection('it', 'BS')).toBe('cerca-lavoro-basilea');
  });
});

describe('resolveJobCanton', () => {
  it('returns job.canton when present', () => {
    expect(resolveJobCanton({ canton: 'ZH', location: 'Zurich' })).toBe('ZH');
  });
  it('falls back to city → canton lookup', () => {
    expect(resolveJobCanton({ canton: '', location: 'Zurich' })).toBe('ZH');
  });
  it('defaults to TI when canton unresolved', () => {
    expect(resolveJobCanton({ canton: '', location: '' })).toBe('TI');
  });
  it('tokenises multi-word locations (Davos Klosters → GR)', () => {
    expect(resolveJobCanton({ canton: '', location: 'Davos Klosters' })).toBe('GR');
  });
  it('strips airport-style suffix (Zürich Flughafen → ZH)', () => {
    expect(resolveJobCanton({ canton: '', location: 'Zürich Flughafen' })).toBe('ZH');
  });
  it('honours embedded canton code (Aesch ZH → ZH, not BL)', () => {
    expect(resolveJobCanton({ canton: '', location: 'Aesch ZH' })).toBe('ZH');
  });
  it('resolves canonical St-prefixed form (St. Gallen → SG)', () => {
    expect(resolveJobCanton({ canton: '', location: 'St. Gallen' })).toBe('SG');
  });
  it('resolves German long form (Sankt Gallen → SG)', () => {
    // Resolver normalises "Sankt X" → "St. X" before the bare-city
    // lookup, so the official municipality entry ("st. gallen") matches.
    expect(resolveJobCanton({ canton: '', location: 'Sankt Gallen' })).toBe('SG');
  });
});

describe('cantonCities', () => {
  it('ZH municipalities include Zurich', () => {
    const cities = getCantonCities('ZH');
    expect(cities).toContain('Zurich');
  });
  it('city → canton lookup is case-insensitive', () => {
    expect(getCityCanton('lugano')).toBe('TI');
    expect(getCityCanton('LUGANO')).toBe('TI');
    expect(getCityCanton('Lugano')).toBe('TI');
  });
  it('normalizeCitySlug produces URL-safe slug', () => {
    expect(normalizeCitySlug('St. Gallen')).toBe('st-gallen');
    expect(normalizeCitySlug('La Chaux-de-Fonds')).toBe('la-chaux-de-fonds');
    expect(normalizeCitySlug('Sankt Margrethen')).toBe('sankt-margrethen');
  });
});

describe('cantonCities — disambiguator collision (P1-D)', () => {
  it('disambiguated Aesch (ZH) → ZH (not BL)', () => {
    expect(getCityCanton('Aesch (ZH)')).toBe('ZH');
  });
  it('disambiguated Aesch (BL) → BL', () => {
    expect(getCityCanton('Aesch (BL)')).toBe('BL');
  });
  it('bare "Aesch" → null (ambiguous across BL/LU/ZH)', () => {
    expect(getCityCanton('Aesch')).toBeNull();
  });
  it('unambiguous bare city resolves directly', () => {
    expect(getCityCanton('Lugano')).toBe('TI');
    expect(getCityCanton('Zurich')).toBe('ZH');
  });
});
