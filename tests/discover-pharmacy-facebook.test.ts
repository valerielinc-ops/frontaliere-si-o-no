import { describe, expect, it } from 'vitest';
import {
  discoverFacebookCandidates,
  extractFacebookCandidateUrls,
  facebookSearchUrl,
} from '../scripts/discover-pharmacy-facebook.mjs';
import { pharmacyById } from '../services/pharmacies/data';

const pharmacy = pharmacyById('it-msal-3907')!;
const checkedAt = '2026-10-07T06:00:00.000Z';

describe('Facebook pharmacy discovery', () => {
  it('builds a public search URL without publishing any facts', () => {
    expect(facebookSearchUrl(pharmacy)).toBe(
      'https://www.facebook.com/public/FARMACIA%20INTERNAZIONALE%20DI%20CASCIAGO%20DEL%20DOTT.%20MASSIMO%20DE%20BERNARDI%20%26%20C.%20S.A.S.%20Casciago',
    );
  });

  it('fails closed when Facebook serves a login or checkpoint page', async () => {
    const result = await discoverFacebookCandidates({
      config: { providers: { facebook: { discoveryPharmacyIds: [pharmacy.id] } } },
      pharmacies: [pharmacy],
      checkedAt,
      fetchDocument: async () => '<html><body>Log in to Facebook or create a new account <a href="https://facebook.com/recover/initiate">recover</a></body></html>',
    });

    expect(result.candidates).toEqual([expect.objectContaining({
      pharmacyId: pharmacy.id,
      status: 'public_search_blocked',
      urls: [],
      checkedAt,
    })]);
  });

  it('reports candidate page URLs for later Graph API identity verification', async () => {
    const html = '<a href="https://www.facebook.com/farmacia-internazionale-casciago?ref=search">page</a>';
    expect(extractFacebookCandidateUrls(html)).toEqual([
      'https://www.facebook.com/farmacia-internazionale-casciago',
    ]);

    const result = await discoverFacebookCandidates({
      config: { providers: { facebook: { discoveryPharmacyIds: [pharmacy.id] } } },
      pharmacies: [pharmacy],
      checkedAt,
      fetchDocument: async () => html,
    });

    expect(result.candidates).toEqual([expect.objectContaining({
      pharmacyId: pharmacy.id,
      status: 'candidate_needs_graph_verification',
      urls: ['https://www.facebook.com/farmacia-internazionale-casciago'],
    })]);
  });

  it('does not silently search pharmacies outside the explicit discovery allow-list', async () => {
    let calls = 0;
    const result = await discoverFacebookCandidates({
      config: { providers: { facebook: { discoveryPharmacyIds: ['not-in-catalogue'] } } },
      pharmacies: [pharmacy],
      checkedAt,
      fetchDocument: async () => {
        calls += 1;
        return '';
      },
    });

    expect(calls).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual(['not-in-catalogue: pharmacy is not in the catalogue']);
  });
});
