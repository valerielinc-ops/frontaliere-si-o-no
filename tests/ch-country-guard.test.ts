import { describe, it, expect } from 'vitest';
import {
  coerceCountryField,
  isChCountry,
  CH_COUNTRY_RX,
} from '../scripts/lib/ch-country-guard.mjs';
import { isDebiopharmSwissJob } from '../scripts/lib/debiopharm-job-parser.mjs';
import { isGuessTicinoWidgetJob } from '../scripts/lib/guess-job-parser.mjs';

describe('ch-country-guard', () => {
  describe('coerceCountryField', () => {
    it('returns "" for absent values (so "absent" ≠ "present non-CH")', () => {
      expect(coerceCountryField(null)).toBe('');
      expect(coerceCountryField(undefined)).toBe('');
      expect(coerceCountryField('')).toBe('');
      expect(coerceCountryField('  ')).toBe('');
    });

    it('coerces numeric ISO-3166 codes to strings', () => {
      expect(coerceCountryField(756)).toBe('756');
    });

    it('extracts a scalar from an object instead of "[object Object]"', () => {
      expect(coerceCountryField({ code: 'CH', name: 'Switzerland' })).toBe('CH');
      expect(coerceCountryField({ name: 'Switzerland' })).toBe('Switzerland');
      expect(coerceCountryField({ id: 756 })).toBe('756');
      // The regression this guards against: naive String(obj).
      expect(coerceCountryField({})).not.toBe('[object Object]');
    });
  });

  describe('isChCountry — keeps valid CH rows across alias formats', () => {
    it.each([
      'CH', 'che', 'CHE', 'Switzerland', 'Suisse', 'Schweiz', 'Svizzera',
      'Switzerland (CH)', 'CH - Suisse', '756', 756,
      { code: 'CH' }, { name: 'Switzerland' }, { id: 756 },
    ])('accepts %o', (value) => {
      expect(isChCountry(value)).toBe(true);
    });
  });

  describe('isChCountry — still rejects non-CH and absent', () => {
    it.each([
      'France', 'DE', 'Germany', 'Italy', 'Liechtenstein',
      'China', 'CHN', 'Chile', 'CHL', 'Czech Republic',
      { code: 'FR' }, null, undefined, '',
    ])('rejects %o', (value) => {
      expect(isChCountry(value)).toBe(false);
    });
  });

  it('CH_COUNTRY_RX is exported for callers that match a pre-coerced token', () => {
    expect(CH_COUNTRY_RX.test('switzerland (ch)')).toBe(true);
    expect(CH_COUNTRY_RX.test('france')).toBe(false);
  });
});

describe('sibling CH guards use the shared alias matcher (#2419)', () => {
  it('isDebiopharmSwissJob accepts CHE / 756 / object countryCode', () => {
    expect(isDebiopharmSwissJob({ location: { countryCode: 'CH' } })).toBe(true);
    expect(isDebiopharmSwissJob({ location: { countryCode: 'CHE' } })).toBe(true);
    expect(isDebiopharmSwissJob({ location: { countryCode: 756 } })).toBe(true);
    expect(isDebiopharmSwissJob({ location: { countryCode: { code: 'CH' } } })).toBe(true);
    expect(isDebiopharmSwissJob({ locations: [{ countryCode: 'FR' }, { countryCode: 'CHE' }] })).toBe(true);
    expect(isDebiopharmSwissJob({ location: { countryCode: 'FR' } })).toBe(false);
    expect(isDebiopharmSwissJob({})).toBe(false);
  });

  it('isGuessTicinoWidgetJob accepts CH alias formats with a Ticino signal', () => {
    const base = { city: 'Bioggio', state: 'Ticino' };
    expect(isGuessTicinoWidgetJob({ ...base, country: 'Switzerland' })).toBe(true);
    expect(isGuessTicinoWidgetJob({ ...base, country: 'CH' })).toBe(true);
    expect(isGuessTicinoWidgetJob({ ...base, country: 756 })).toBe(true);
    // Non-CH country still rejected even with a Swiss-looking signal.
    expect(isGuessTicinoWidgetJob({ ...base, country: 'Italy' })).toBe(false);
    // CH country but no Swiss target signal → still rejected (AND guard intact).
    expect(isGuessTicinoWidgetJob({ city: 'Milano', state: 'Lombardia', country: 'CH' })).toBe(false);
  });
});
