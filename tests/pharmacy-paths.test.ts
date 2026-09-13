import { describe, expect, it } from 'vitest';
import { buildPharmacyPath, parsePharmacyPath } from '../services/pharmacies/paths';
import italy from '../data/pharmacies-italy-border.json';
import ticino from '../data/pharmacies-ticino-complete.json';
import { pharmacyCitySlug, provinceSlugForPharmacy } from '../services/pharmacies/data';
import type { Pharmacy } from '../services/pharmacies/types';

describe('pharmacy canonical paths', () => {
  it('round-trips hub, canton, city and duty paths in all locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const path of [
        { kind: 'hub' as const, locale },
        { kind: 'canton' as const, locale },
        { kind: 'city' as const, citySlug: 'lugano', locale },
        { kind: 'duty-hub' as const, locale },
        { kind: 'duty-city' as const, citySlug: 'lugano', locale },
      ]) {
        expect(parsePharmacyPath(buildPharmacyPath(path, locale))).toEqual(path);
      }
    }
  });

  it('rejects a non-Ticino city slug', () => {
    expect(parsePharmacyPath('/farmacie/ticino/zurigo/')).toBeNull();
  });

  it('round-trips Swiss and Italian pharmacy detail URLs', () => {
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
});
