import { describe, expect, it } from 'vitest';
import {
  discoverFacebookCandidates,
  extractFacebookPublicFacts,
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

  it('reports candidate page URLs for later public identity verification', async () => {
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
      status: 'candidate_needs_identity_verification',
      urls: ['https://www.facebook.com/farmacia-internazionale-casciago'],
    })]);
  });

  it('extracts only identity-matched facts from an accessible public page', async () => {
    const searchHtml = '<a href="https://www.facebook.com/farmacia-internazionale-casciago?ref=search">page</a>';
    const pageHtml = `
      <html><head>
        <meta property="og:title" content="Farmacia Internazionale di Casciago">
        <meta property="og:description" content="Farmacia Internazionale di Casciago, Casciago">
      </head><body>
        <h1>Farmacia Internazionale di Casciago</h1>
        <p>Casciago</p>
        <a href="tel:+39 0332 227362">chiama</a>
        <p>Orari: lunedì: 08:30-20:00; domenica chiuso</p>
        <p>Rating 5/5 e 99 recensioni</p>
      </body></html>`;
    expect(extractFacebookPublicFacts(pageHtml, pharmacy, 'https://www.facebook.com/farmacia-internazionale-casciago')).toMatchObject({
      matched: true,
      facts: {
        phone: '+39 0332 227362',
        openingHours: expect.arrayContaining([
          { dayOfWeek: 'monday', opens: '08:30', closes: '20:00' },
          { dayOfWeek: 'sunday', opens: '', closes: '', isClosed: true },
        ]),
      },
    });

    const result = await discoverFacebookCandidates({
      config: { providers: { facebook: { discoveryPharmacyIds: [pharmacy.id] } } },
      pharmacies: [pharmacy],
      checkedAt,
      fetchDocument: async (url) => url.includes('/public/') ? searchHtml : pageHtml,
    });

    expect(result.candidates).toEqual([expect.objectContaining({
      pharmacyId: pharmacy.id,
      status: 'candidate_publicly_verified',
      urls: ['https://www.facebook.com/farmacia-internazionale-casciago'],
      verified: expect.objectContaining({
        matched: true,
        facts: expect.objectContaining({ phone: '+39 0332 227362' }),
      }),
    })]);
    expect(JSON.stringify(result)).not.toContain('recensioni');
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
