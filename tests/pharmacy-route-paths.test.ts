import { describe, expect, it } from 'vitest';
import { buildPharmacyPath, parsePharmacyRoute } from '../services/pharmacies/routePaths';

describe('generic pharmacy route grammar', () => {
  it('recognises route shapes without loading the pharmacy catalogue', () => {
    expect(parsePharmacyRoute('/farmacie/')).toEqual({ kind: 'hub', locale: 'it' });
    expect(parsePharmacyRoute('/farmacie/ticino/lugano/')).toEqual({
      kind: 'city',
      citySlug: 'lugano',
      locale: 'it',
    });
    expect(parsePharmacyRoute('/farmacie/ticino/lugano/example-pharmacy/')).toEqual({
      kind: 'pharmacy',
      country: 'CH',
      citySlug: 'lugano',
      pharmacySlug: 'example-pharmacy',
      locale: 'it',
    });
  });

  it('keeps week grammar strict and canonical path generation stable', () => {
    expect(parsePharmacyRoute('/farmacie-di-turno/settimana/2026-09-14/')).toEqual({
      kind: 'duty-week',
      weekStart: '2026-09-14',
      locale: 'it',
    });
    expect(parsePharmacyRoute('/farmacie-di-turno/settimana/2026-09-15/')).toBeNull();
    expect(buildPharmacyPath({ kind: 'duty-week', locale: 'it', weekStart: '2026-09-14' })).toBe('/farmacie-di-turno/settimana/2026-09-14/');
  });

  it.each([
    ['it', '/farmacie/italia/di-turno/', '/farmacie/italia/di-turno/settimana/2026-09-14/'],
    ['en', '/en/pharmacies/italy/on-duty/', '/en/pharmacies/italy/on-duty/week/2026-09-14/'],
    ['de', '/de/apotheken/italien/notdienst/', '/de/apotheken/italien/notdienst/woche/2026-09-14/'],
    ['fr', '/fr/pharmacies/italie/de-garde/', '/fr/pharmacies/italie/de-garde/semaine/2026-09-14/'],
  ] as const)('recognises the Italian duty hub and week in %s', (locale, hubPath, weekPath) => {
    expect(parsePharmacyRoute(hubPath)).toEqual({ kind: 'italy-duty-hub', country: 'IT', locale });
    expect(parsePharmacyRoute(weekPath)).toEqual({ kind: 'italy-duty-week', country: 'IT', locale, weekStart: '2026-09-14' });
  });
});
