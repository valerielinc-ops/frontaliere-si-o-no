import { describe, expect, it } from 'vitest';
import { locationMatchPoints } from '../functions/src/applicationConciergeGeography.js';
import manifest from '../data/residence-localities/manifest.json';
import { SWISS_CANTONS } from '../services/pharmacies/swissCantons';

describe('concierge geographic ranking', () => {
  it.each([
    ['Como (Lombardy), Italia', 'Como', 'IT'],
    ['Lugano (Ticino), Svizzera', 'Lugano', 'CH'],
    ['Baden (Aargau), Schweiz', 'Baden', 'CH'],
    ['Baden (Lower Austria), Österreich', 'Baden', 'AT'],
    ['München (Bavaria), Deutschland', 'Munchen', 'DE'],
    ['L’Haÿ-les-Roses (Île-de-France), France', 'L Hay-les-Roses', 'FR'],
    ['Tiranë (Tirana), Albanie', 'Tirane', 'AL'],
  ])('recognizes catalogue locality %s without treating its region as the town', (candidate, town, country) => {
    expect(locationMatchPoints(candidate, { addressLocality: town, addressCountry: country })).toBe(8);
  });

  it.each(['Italia', 'Italy', 'Italien', 'Italie'])('uses the explicit %s suffix', country => {
    expect(locationMatchPoints(`Como (Lombardy), ${country}`, { location: 'Como', addressCountry: 'IT' })).toBe(8);
  });

  it('does not equate homonyms or postcodes across different countries', () => {
    expect(locationMatchPoints('5400 Baden, Österreich', { location: 'Baden', postalCode: '5400', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Baden, Deutschland', { location: 'Baden', addressCountry: 'AT' })).toBe(0);
    expect(locationMatchPoints('1000 Town, Italia', { location: 'Other town', postalCode: '1000', addressCountry: 'CH' })).toBe(0);
  });

  it('keeps a missing country neutral rather than inferring one from a town, language or postcode', () => {
    expect(locationMatchPoints('Baden', { location: 'Baden', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Baden, Österreich', { location: 'Baden' })).toBe(0);
    expect(locationMatchPoints('6850 Mendrisio', { location: 'Mendrisio', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Atlanta, Georgia', { location: 'Atlanta', addressCountry: 'GE' })).toBe(0);
    expect(locationMatchPoints('Vasto, CH', { location: 'Vasto', addressCountry: 'CH' })).toBe(0);
  });

  it('retains bounded locality and postcode hints for two legacy country-less values', () => {
    expect(locationMatchPoints('6850 Mendrisio', { location: 'Mendrisio' })).toBe(8);
    expect(locationMatchPoints('6850 Mendrisio', { location: 'Chiasso', postalCode: '6830' })).toBe(4);
    expect(locationMatchPoints('6850 Mendrisio', { location: 'Zurich', postalCode: '8000' })).toBe(0);
  });

  it('does not discard conflicting disambiguators or conflicting posting countries', () => {
    expect(locationMatchPoints('Frankfurt (Oder), Deutschland', { location: 'Frankfurt (Main)', addressCountry: 'DE' })).toBe(0);
    expect(locationMatchPoints('Baden (Aargau), Schweiz', { location: 'Baden (Lower Austria), Österreich', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Lugano (Ticino), Svizzera', { location: 'Lugano (TI)', addressCountry: 'CH' })).toBe(8);
    expect(locationMatchPoints('Baden (Aargau), Schweiz', { location: 'Baden (AG)', addressCountry: 'CH' })).toBe(8);
    expect(locationMatchPoints('Baden (AG), Schweiz', { location: 'Baden (ZH)', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Baden (Aargau), Schweiz', { location: 'Baden (ZH)', addressCountry: 'CH' })).toBe(0);
    expect(locationMatchPoints('Lugano (TI), Schweiz', { location: 'Lugano (GR)', addressCountry: 'CH' })).toBe(0);
  });

  it('accepts explicit structured countries and preserves the Georgia marker', () => {
    expect(locationMatchPoints('Como, Italia', { location: 'Como', addressCountry: { name: 'Italy' } })).toBe(8);
    expect(locationMatchPoints('Tbilisi, Georgia (GE)', { location: 'Tbilisi', addressCountry: 'GE' })).toBe(8);
    expect(locationMatchPoints('Jamestown, Saint Helena, Ascension and Tristan da Cunha', { location: 'Jamestown', addressCountry: 'SH' })).toBe(8);
  });

  it('honours a structured Swiss canton without inferring the posting country from it', () => {
    expect(locationMatchPoints('Buchs (Aargau), Schweiz', { location: 'Buchs', addressCountry: 'CH', canton: 'SG' })).toBe(0);
    expect(locationMatchPoints('Buchs (Aargau), Schweiz', { location: 'Buchs', addressCountry: 'CH', canton: 'AG' })).toBe(8);
    expect(locationMatchPoints('Buchs (Aargau), Schweiz', { location: 'Buchs (AG)', addressCountry: 'CH', canton: 'SG' })).toBe(0);
    expect(locationMatchPoints('Buchs (Aargau), Schweiz', { location: 'Buchs', canton: 'AG' })).toBe(0);
    expect(locationMatchPoints('Baden (Lower Austria), Österreich', { location: 'Baden', addressCountry: 'AT', canton: 'AG' })).toBe(8);
  });

  it('supports every country emitted by the current residence catalogue in all four locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const names = new Intl.DisplayNames([locale], { type: 'region' });
      for (const country of Object.keys(manifest.countries)) {
        const suffix = names.of(country) + (country === 'GE' ? ' (GE)' : '');
        expect(locationMatchPoints(`Town (Region), ${suffix}`, { location: 'Town', addressCountry: country })).toBe(8);
      }
    }
  });

  it('preserves each canton identity across all existing presentation labels', () => {
    for (const canton of SWISS_CANTONS) for (const name of Object.values(canton.names)) {
      expect(locationMatchPoints(`Town (${name}), Schweiz`, { location: `Town (${canton.code})`, addressCountry: 'CH' })).toBe(8);
    }
  });

  it('treats unknown country codes as unknown rather than legacy absence', () => {
    expect(locationMatchPoints('Baden', { location: 'Baden', addressCountry: 'ZZ' })).toBe(0);
    expect(locationMatchPoints('Baden, Unknown Region', { location: 'Baden', addressCountry: 'ZZ' })).toBe(0);
  });
});
