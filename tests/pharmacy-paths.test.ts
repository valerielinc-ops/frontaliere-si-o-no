import { describe, expect, it } from 'vitest';
import { buildPharmacyPath, parsePharmacyPath } from '../services/pharmacies/paths';

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
});
