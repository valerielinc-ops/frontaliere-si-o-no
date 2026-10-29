import { describe, expect, it } from 'vitest';
import { enrichPharmacyRecords } from '../scripts/lib/pharmacy-enrichment.mjs';

const checkedAt = '2026-10-29T12:00:00.000Z';
const pharmacies = [
  {
    id: 'it-msal-3907',
    name: 'Farmacia prima',
    address: 'Via Roma 1',
    city: 'Casciago',
  },
  {
    id: 'it-msal-3908',
    name: 'Farmacia seconda',
    address: 'Via Milano 2',
    city: 'Varese',
  },
];

describe('pharmacy enrichment credential guards', () => {
  it('stops the Google lane after a credential/project 403', async () => {
    let requestCount = 0;
    const result = await enrichPharmacyRecords(pharmacies, {
      schemaVersion: 1,
      sources: [],
      providers: {
        googlePlaces: {
          enabled: true,
          pharmacyIds: pharmacies.map((pharmacy) => pharmacy.id),
        },
        facebook: { enabled: false, pharmacyIds: [] },
      },
    }, {
      checkedAt,
      googleApiKey: 'owner-kept-key',
      fetchJson: async () => {
        requestCount += 1;
        throw Object.assign(new Error('HTTP 403 for restricted API key'), { status: 403 });
      },
    });

    expect(requestCount).toBe(1);
    expect(result.providerUsage.googlePlaces.requests).toBe(1);
    expect(result.warnings).toEqual([
      'googlePlaces: disabled for this run after HTTP 403; API key/project restriction requires owner action',
    ]);
  });
});
