import { describe, expect, it } from 'vitest';
import ticino from '../data/pharmacies-ticino-complete.json';
import italy from '../data/pharmacies-italy-border.json';
import duties from '../data/pharmacy-duties-ticino.json';
import sources from '../data/pharmacy-border-sources.json';
import { validateBorderSources, validateBorderSnapshot } from '../scripts/check-pharmacy-border-data.mjs';
import { validatePharmacyList } from '../services/pharmacies/types';
import { buildItalianBorderRecords, parseOsmOpeningHours } from '../scripts/lib/pharmacy-border-parser.mjs';

const swiss = ticino.pharmacies;
const italian = italy.pharmacies;

describe('cross-border pharmacy datasets', () => {
  it('keeps the official and ODbL source registry complete', () => {
    expect(validateBorderSources(sources)).toEqual([]);
  });

  it('contains valid official records for Ticino and the three border provinces', () => {
    expect(ticino._pharmacyCount).toBe(swiss.length);
    expect(italy._pharmacyCount).toBe(italian.length);
    expect(validatePharmacyList(swiss)).toEqual([]);
    expect(validatePharmacyList(italian)).toEqual([]);
    expect(swiss.length).toBeGreaterThanOrEqual(200);
    expect(italian.length).toBeGreaterThanOrEqual(400);
    expect(new Set(italian.map((pharmacy) => pharmacy.province))).toEqual(new Set(['CO', 'VA', 'VB']));
    expect(italian.filter((pharmacy) => pharmacy.province === 'CO').length).toBeGreaterThan(100);
    expect(italian.filter((pharmacy) => pharmacy.province === 'VA').length).toBeGreaterThan(100);
    expect(italian.filter((pharmacy) => pharmacy.province === 'VB').length).toBeGreaterThan(50);
    expect(swiss.every((pharmacy) => pharmacy.country === 'CH' && pharmacy.canton === 'Ticino')).toBe(true);
    expect(italian.every((pharmacy) => pharmacy.country === 'IT' && ['CO', 'VA', 'VB'].includes(pharmacy.province || ''))).toBe(true);
    expect(JSON.stringify([...swiss, ...italian])).not.toMatch(/[ÃÂ`¿\u0096]/);
    expect(validateBorderSnapshot({ ticino, italy, duties })).toEqual([]);
  });

  it('keeps global identity unique and preserves every published duty reference', () => {
    const all = [...swiss, ...italian];
    expect(new Set(all.map((pharmacy) => pharmacy.id)).size).toBe(all.length);
    expect(new Set(all.map((pharmacy) => pharmacy.slug)).size).toBe(all.length);
    const ids = new Set(swiss.map((pharmacy) => pharmacy.id));
    expect(duties.duties.every((duty) => ids.has(duty.pharmacyId))).toBe(true);
  });

  it('publishes optional OSM fields only with field-level ODbL provenance', () => {
    for (const pharmacy of [...swiss, ...italian]) {
      for (const field of ['phone', 'website', 'coordinates', 'openingHours', 'services'] as const) {
        const source = pharmacy.fieldSources?.[field];
        if (source) expect(source.license).toMatch(/ODbL/i);
      }
      expect(JSON.stringify(pharmacy)).not.toMatch(/farmacia-aperta|federfarma/i);
    }
  });

  it('splits an overnight OSM interval at midnight instead of publishing an invalid same-day range', () => {
    expect(parseOsmOpeningHours('Mo 18:00-02:00')).toEqual([
      { dayOfWeek: 'monday', opens: '18:00', closes: '24:00' },
      { dayOfWeek: 'tuesday', opens: '00:00', closes: '02:00' },
    ]);
  });

  it('keeps an Italian Ministry id on its old slug and records a moved-city alias', () => {
    const [record] = buildItalianBorderRecords([
      {
        cod_farmacia: '42',
        descrizione_farmacia: 'Farmacia Nuova',
        indirizzo: 'Via Roma 1',
        cap: '22012',
        comune: 'Cernobbio',
        sigla_provincia: 'CO',
        regione: 'Lombardia',
        latitudine: '',
        longitudine: '',
        data_inizio_validita: '01/01/2020',
        data_fine_validita: '-',
      },
    ], {
      fetchedAt: '2026-09-13T00:00:00.000Z',
      asOf: '2026-09-13',
      previous: [{
        id: 'it-msal-42',
        ministryId: '42',
        name: 'Farmacia Vecchia',
        slug: 'farmacia-vecchia-como-42',
        address: 'Via Roma 1',
        postalCode: '22100',
        city: 'Como',
        country: 'IT',
        province: 'CO',
      }],
    });

    expect(record.slug).toBe('farmacia-vecchia-como-42');
    expect(record.urlAliases).toEqual([{
      country: 'IT',
      province: 'CO',
      city: 'Como',
      slug: 'farmacia-vecchia-como-42',
    }]);
  });
});
