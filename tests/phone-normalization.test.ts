import { describe, expect, it } from 'vitest';
import { countryCodeOfLabel, formatInternationalPhone, formatPhoneForField, normalizePhone, phoneCountryLabel } from '../functions/src/lib/phoneNormalization.js';

describe('canonical phone normalisation', () => {
  it('normalises and formats an Italian number without changing its country', () => {
    expect(normalizePhone('+39 324 0753275')).toBe('+393240753275');
    expect(formatInternationalPhone('+39 324 0753275')).toBe('+39 324 0753275');
    expect(formatPhoneForField('+39 324 0753275', { countryPrefix: '+39', separateCountryCode: true })).toBe('324 0753275');
    expect(phoneCountryLabel('+39 324 0753275', 'de')).toBe('Italien');
  });

  it('recognises translated country options and does not guess a country for a national number', () => {
    expect(countryCodeOfLabel('Schweiz (CH)')).toBe('CH');
    expect(countryCodeOfLabel('Land/Region des Wohnorts: Italien')).toBe('IT');
    expect(countryCodeOfLabel('324 0753275')).toBe('');
  });
});
