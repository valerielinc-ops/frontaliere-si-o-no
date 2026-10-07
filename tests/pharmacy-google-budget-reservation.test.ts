import { describe, expect, it } from 'vitest';
import { planGooglePlacesReservation } from '../scripts/ci/reserve-pharmacy-google-budget.mjs';
import { enrichPharmacyRecords } from '../scripts/lib/pharmacy-enrichment.mjs';

const checkedAt = '2026-10-07T12:00:00.000Z';
const pharmacyIds = Array.from({ length: 11 }, (_, index) => `it-msal-${3907 + index}`);
const config = {
  providers: {
    googlePlaces: {
      enabled: true,
      pharmacyIds,
      maxAgeDays: 30,
      monthlyRequestLimit: 10_000,
    },
  },
};
const catalogues = [{ pharmacies: pharmacyIds.map((id) => ({ id })) }];

describe('serialized Google Places budget reservation', () => {
  it('allows one branch to reserve the remaining quota and blocks a second branch from the same base', async () => {
    const baseSnapshot = {
      records: {},
      providerUsage: { month: '2026-10', googlePlaces: { requests: 9_990 } },
    };
    const first = planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: baseSnapshot,
      checkedAt,
    });

    expect(first).toMatchObject({
      allowGoogle: true,
      reason: 'reserved',
      requestCount: 10,
      reservedRequests: 10_000,
    });
    expect(first.pharmacyIds).toHaveLength(10);

    let requestCount = 0;
    const enrichment = await enrichPharmacyRecords(
      first.pharmacyIds!.map((id) => ({ id, name: id, address: 'Via Roma 1', city: 'Varese' })),
      {
        sources: [],
        providers: {
          googlePlaces: { ...config.providers.googlePlaces, pharmacyIds: first.pharmacyIds },
          facebook: { enabled: false, pharmacyIds: [] },
        },
      },
      {
        checkedAt,
        googleApiKey: 'test-google-key',
        previous: { records: {}, providerUsage: baseSnapshot.providerUsage },
        fetchJson: async () => {
          requestCount += 1;
          return { places: [] };
        },
      },
    );
    expect(requestCount).toBe(10);
    expect(enrichment.providerUsage.googlePlaces.requests).toBe(10_000);

    const second = planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: baseSnapshot,
      reservation: { month: '2026-10', googlePlaces: { requests: 10_000 } },
      checkedAt,
    });

    expect(second).toMatchObject({
      allowGoogle: false,
      reason: 'pending_reservation',
      requestCount: 0,
      reservedRequests: 10_000,
    });
  });

  it('resets an older month but never permits an exhausted current month', () => {
    const nextMonth = planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: {
        records: {},
        providerUsage: { month: '2026-09', googlePlaces: { requests: 10_000 } },
      },
      reservation: { month: '2026-09', googlePlaces: { requests: 10_000 } },
      checkedAt,
    });
    expect(nextMonth).toMatchObject({ allowGoogle: true, reservedRequests: 10 });

    const exhausted = planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: {
        records: {},
        providerUsage: { month: '2026-10', googlePlaces: { requests: 10_000 } },
      },
      reservation: { month: '2026-10', googlePlaces: { requests: 10_000 } },
      checkedAt,
    });
    expect(exhausted).toMatchObject({ allowGoogle: false, reason: 'budget_exhausted' });
  });

  it('fails closed when the reservation or current ledger is malformed', () => {
    expect(() => planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: {
        records: {},
        providerUsage: { month: '2026-10', googlePlaces: { requests: 10_001 } },
      },
      checkedAt,
    })).toThrow('current providerUsage Google Places requests are invalid');

    expect(() => planGooglePlacesReservation({
      catalogues,
      config,
      snapshot: { records: {} },
      reservation: { month: '2026-10', googlePlaces: { requests: 10_001 } },
      checkedAt,
    })).toThrow('reservation Google Places requests are invalid');
  });
});
