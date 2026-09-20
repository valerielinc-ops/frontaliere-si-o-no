import { describe, expect, it } from 'vitest';
import { buildPharmacyPath, parsePharmacyPath } from '../services/pharmacies/paths';
import italy from '../data/pharmacies-italy-border.json';
import ticino from '../data/pharmacies-ticino-complete.json';
import { pharmacyCitySlug, provinceSlugForPharmacy } from '../services/pharmacies/data';
import type { Pharmacy } from '../services/pharmacies/types';
import { SKIP_LIVE_DATA } from './helpers/live-data';

describe('pharmacy canonical paths', () => {
  it('round-trips hub, canton, city and duty paths in all locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const path of [
        { kind: 'hub' as const, locale },
        { kind: 'canton' as const, locale },
        { kind: 'city' as const, citySlug: 'lugano', locale },
        { kind: 'duty-hub' as const, locale },
        { kind: 'duty-city' as const, citySlug: 'lugano', locale },
        { kind: 'duty-week' as const, weekStart: '2026-09-14', locale },
        { kind: 'italy-duty-hub' as const, country: 'IT' as const, locale },
        { kind: 'italy-duty-week' as const, country: 'IT' as const, weekStart: '2026-09-14', locale },
      ]) {
        expect(parsePharmacyPath(buildPharmacyPath(path, locale))).toEqual(path);
      }
    }
  });

  it('rejects a non-Ticino city slug', () => {
    expect(parsePharmacyPath('/farmacie/ticino/zurigo/')).toBeNull();
  });

  it('rejects invalid weekly dates and keeps them on the duty hub', () => {
    expect(parsePharmacyPath('/farmacie-di-turno/settimana/2026-09-15/')).toBeNull();
    expect(buildPharmacyPath({ kind: 'duty-week', locale: 'it', weekStart: '2026-09-15' })).toBe('/farmacie-di-turno/');
  });

  // prende il primo record reale di data/pharmacies-*.json (city/slug rigenerati dal sync): rosso possibile senza cambi di codice
  it.skipIf(SKIP_LIVE_DATA)('round-trips Swiss and Italian pharmacy detail URLs', () => {
    const samples = [ticino.pharmacies[0], italy.pharmacies[0]] as unknown as Pharmacy[];
    for (const pharmacy of samples) {
      const path = pharmacy.country === 'IT'
        ? { kind: 'pharmacy' as const, locale: 'it' as const, country: 'IT' as const, areaSlug: provinceSlugForPharmacy(pharmacy), citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug }
        : { kind: 'pharmacy' as const, locale: 'it' as const, country: 'CH' as const, citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug };
      expect(parsePharmacyPath(buildPharmacyPath(path))).toEqual(path);
    }
  });

  it('round-trips Italian country, province and city paths', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const path of [
        { kind: 'country' as const, country: 'IT' as const, locale },
        { kind: 'area' as const, country: 'IT' as const, areaSlug: 'como', locale },
        { kind: 'city' as const, country: 'IT' as const, areaSlug: 'como', citySlug: 'como', locale },
      ]) {
        expect(parsePharmacyPath(buildPharmacyPath(path))).toEqual(path);
      }
    }
  });

  it('keeps Italian duty routes distinct from the directory and Ticino duty routes', () => {
    expect(buildPharmacyPath({ kind: 'italy-duty-hub', country: 'IT', locale: 'it' })).toBe('/farmacie/italia/di-turno/');
    expect(buildPharmacyPath({ kind: 'italy-duty-week', country: 'IT', locale: 'it', weekStart: '2026-09-14' })).toBe('/farmacie/italia/di-turno/settimana/2026-09-14/');
    expect(parsePharmacyPath('/farmacie/italia/di-turno/settimana/2026-09-15/')).toBeNull();
  });
});
