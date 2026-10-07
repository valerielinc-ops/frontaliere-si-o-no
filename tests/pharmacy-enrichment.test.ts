import { describe, expect, it } from 'vitest';
import enrichmentConfig from '../data/pharmacy-enrichment-sources.json';
import enrichmentSnapshot from '../data/pharmacy-enrichment.json';
import { applyPublicFacebookDiscovery, buildPharmacyEnrichmentSnapshot, enrichPharmacyRecords, extractPdfFacts, parseItalianHours, validatePharmacyEnrichmentConfig, validatePharmacyEnrichmentSnapshot } from '../scripts/lib/pharmacy-enrichment.mjs';
import { validatePharmacyEnrichmentConfig as validateDependencyFreeConfig, validatePharmacyEnrichmentSnapshot as validateDependencyFreeSnapshot } from '../scripts/lib/pharmacy-enrichment-validation.mjs';
import { mergePharmacyEnrichment } from '../services/pharmacies/enrichment';
import { pharmacyById } from '../services/pharmacies/data';
import { buildPharmacyTitle, pharmacyNameForSeo } from '../services/pharmacies/title';
import type { Pharmacy } from '../services/pharmacies/types';

const pharmacy = pharmacyById('it-msal-3907')!;
const checkedAt = '2026-10-05T12:00:00.000Z';
const municipalityHtml = `
  <html>
    <head><meta property="article:modified_time" content="2024-05-27T11:04:52+00:00"></head>
    <body>
      <h1>Farmacia internazionale di Casciago</h1>
      <p>Via Giacomo Matteotti, 43 — Casciago (VA)</p>
      <a href="tel:+390332227362">+39 0332 227362</a>
      <a href="mailto:farmaciadicasciago@enterpoint.it">farmaciadicasciago@enterpoint.it</a>
      <section><h2>Orario per il pubblico</h2><p>Orario continuato da lunedì a sabato: 8.30-20.00</p></section>
      <p>Consegna a domicilio.</p>
      <p>Ingresso e parcheggio accessibile in sedia a rotelle.</p>
    </body>
  </html>
`;

const atsPdfText = `
  SEDE TERRITORIALE DI VARESE
  ed. luglio 2025
  COMUNE RAGIONE SOCIALE INDIRIZZO TELEFONO DESCRIZIONE DISTRETTO
  CASCIAGO FARMACIA INTERNAZIONALE DI CASCIAGO DEL DOTT. MASSIMO DE BERNARDI & C. S.A.S.
  VIA MATTEOTTI, 43 0332227362 VARESE
`;

const pnrrPdfText = `
  Decreto di erogazione FR25 — domanda FR-2025-0218
  FARMACIA INTERNAZIONALE DI CASCIAGO DEL DOTT. MASSIMO DE BERNARDI & C. S.A.S.
  Via Giacomo Matteotti, 43 — 21020 Casciago (VA)
  P.IVA 04109170128
`;

const atokaLegalEntityHtml = `
  <html><body>
    <h1>Farmacia Internazionale Di Casciago Del Dott. Massimo De Bernardi &amp; C. S.a.s.</h1>
    <p>Sede legale: Via Matteotti, 43, 21020, Casciago (VA)</p>
    <p>P.IVA: 04109170128 47.73.10: Commercio al dettaglio di medicinali</p>
  </body></html>
`;

function localConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sources: [],
    providers: {
      googlePlaces: { enabled: false, pharmacyIds: [] },
      facebook: { enabled: false, pharmacyIds: [] },
    },
    ...overrides,
  };
}

describe('pharmacy enrichment', () => {
  it('validates the checked-in registry and snapshot', () => {
    expect(validatePharmacyEnrichmentConfig(enrichmentConfig)).toEqual([]);
    expect(validatePharmacyEnrichmentSnapshot(enrichmentSnapshot)).toEqual([]);
    expect(validateDependencyFreeConfig(enrichmentConfig)).toEqual([]);
    expect(validateDependencyFreeSnapshot(enrichmentSnapshot)).toEqual([]);
    expect(enrichmentSnapshot.records['it-msal-3907']).toMatchObject({
      phone: '+39 0332 227362',
      contactEmail: 'farmaciadicasciago@enterpoint.it',
      services: ['Consegna a domicilio', 'Accesso senza barriere'],
      vatNumber: '04109170128',
    });
  });

  it('parses the official municipal page with field-level provenance', async () => {
    expect(parseItalianHours('Orario continuato da lunedì a sabato: 8.30-20.00; domenica chiuso')).toEqual(expect.arrayContaining([
      { dayOfWeek: 'monday', opens: '08:30', closes: '20:00' },
      { dayOfWeek: 'sunday', opens: '', closes: '', isClosed: true },
    ]));
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      sources: [{ ...enrichmentConfig.sources[0] }],
    }), {
      checkedAt,
      fetchDocument: async () => municipalityHtml,
    });
    const record = result.records[pharmacy.id];

    expect(result.warnings).toEqual([]);
    expect(record).toMatchObject({
      checkedAt,
      phone: '+39 0332 227362',
      contactEmail: 'farmaciadicasciago@enterpoint.it',
      openingHours: expect.arrayContaining([
        { dayOfWeek: 'monday', opens: '08:30', closes: '20:00' },
        { dayOfWeek: 'saturday', opens: '08:30', closes: '20:00' },
      ]),
      services: ['Consegna a domicilio', 'Accesso senza barriere'],
    });
    expect(record.externalSources).toEqual([expect.objectContaining({
      label: 'Comune di Casciago',
      sourceType: 'official',
      sourceUpdatedAt: '2024-05-27T11:04:52.000Z',
      status: 'verified',
    })]);
    expect(record.fieldSources?.openingHours).toMatchObject({ sourceType: 'official', checkedAt });
  });

  it('does not publish facts when an allow-listed page fails identity matching', async () => {
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      sources: [{ ...enrichmentConfig.sources[0] }],
    }), {
      checkedAt,
      fetchDocument: async () => '<html><body><h1>Altra farmacia</h1><p>Varese</p></body></html>',
    });

    expect(result.records[pharmacy.id]).toEqual({ checkedAt });
    expect(result.warnings).toEqual([expect.stringContaining('page did not match it-msal-3907')]);
  });

  it('extracts only the matched phone from an allow-listed official PDF row', async () => {
    const source = {
      id: 'casciago-ats-insubria-2025',
      pharmacyId: pharmacy.id,
      kind: 'pdf',
      url: 'https://www.ats-insubria.it/documentazione?catid=1048&id=3760&m=0&task=download.send',
      label: 'ATS Insubria',
      sourceType: 'official',
      fields: ['phone'],
      status: 'active',
    } as const;
    expect(extractPdfFacts(atsPdfText, pharmacy, source)).toMatchObject({
      matched: true,
      facts: { phone: '0332227362' },
      sourceUpdatedAt: '2025-07-01T00:00:00.000Z',
    });

    const result = await enrichPharmacyRecords([pharmacy], localConfig({ sources: [source] }), {
      checkedAt,
      fetchPdfText: async () => atsPdfText,
    });
    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id]).toMatchObject({ phone: '0332227362' });
    expect(result.records[pharmacy.id].externalSources).toEqual([expect.objectContaining({
      label: 'ATS Insubria',
      sourceType: 'official',
      fields: ['phone'],
      sourceUpdatedAt: '2025-07-01T00:00:00.000Z',
    })]);
  });

  it('rejects an official PDF row that lacks the pharmacy identity anchors', async () => {
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      sources: [{
        id: 'wrong-pdf',
        pharmacyId: pharmacy.id,
        kind: 'pdf',
        url: 'https://example.com/pharmacies.pdf',
        label: 'Unrelated PDF',
        sourceType: 'official',
        fields: ['phone'],
        status: 'active',
      }],
    }), {
      checkedAt,
      fetchPdfText: async () => 'CASCIAGO FARMACIA DEL BORGO VIA MATTEOTTI, 43 0332111222 VARESE',
    });
    expect(result.records[pharmacy.id]).toEqual({ checkedAt });
    expect(result.warnings).toEqual([expect.stringContaining('PDF did not match it-msal-3907')]);
  });

  it('extracts a matched VAT number from a public legal-entity document', async () => {
    const source = {
      id: 'casciago-pnrr-2026-0218',
      pharmacyId: pharmacy.id,
      kind: 'pdf',
      url: 'https://www.strutturapnrr.gov.it/media/2ilmk4mv/260310-decreto-n-32-2026-di-erogazione-fr25-ddg-40-n-01-signed.pdf',
      label: 'Struttura di missione PNRR',
      sourceType: 'official',
      fields: ['vatNumber'],
      status: 'active',
    } as const;
    expect(extractPdfFacts(pnrrPdfText, pharmacy, source)).toMatchObject({
      matched: true,
      facts: { vatNumber: '04109170128' },
    });

    const result = await enrichPharmacyRecords([pharmacy], localConfig({ sources: [source] }), {
      checkedAt,
      fetchPdfText: async () => pnrrPdfText,
    });
    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id]).toMatchObject({ vatNumber: '04109170128' });
    expect(result.records[pharmacy.id].fieldSources?.vatNumber).toMatchObject({ sourceType: 'official' });
  });

  it('does not copy one PDF row VAT number to a different matched pharmacy row', () => {
    const alpha = { ...pharmacy, name: 'Farmacia Alfa', city: 'Roma', address: 'Via Alfa 1', phone: '' };
    const beta = { ...pharmacy, name: 'Farmacia Beta', city: 'Milano', address: 'Via Beta 2', phone: '' };
    const source = { fields: ['vatNumber'] } as const;
    const pdf = 'Farmacia Alfa Via Alfa 1 Roma P. IVA 12345678901; Farmacia Beta Via Beta 2 Milano';

    expect(extractPdfFacts(pdf, alpha, source).facts.vatNumber).toBe('12345678901');
    expect(extractPdfFacts(pdf, beta, source).facts.vatNumber).toBeUndefined();
  });

  it('accepts a public directory address that abbreviates the official street name', async () => {
    const source = {
      id: 'casciago-atoka-legal-entity',
      pharmacyId: pharmacy.id,
      kind: 'html',
      url: 'https://atoka.io/public/it/azienda/farmacia-internazionale-di-casciago-del-dott-massimo-de-bernardi-c-sas/7601ad2f09a8',
      label: 'Atoka — scheda impresa pubblica',
      sourceType: 'directory',
      fields: ['vatNumber'],
      status: 'active',
    } as const;
    const result = await enrichPharmacyRecords([pharmacy], localConfig({ sources: [source] }), {
      checkedAt,
      fetchDocument: async () => atokaLegalEntityHtml,
    });
    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id]).toMatchObject({ vatNumber: '04109170128' });
    expect(result.records[pharmacy.id].externalSources).toEqual([expect.objectContaining({
      sourceType: 'directory',
      fields: ['vatNumber'],
    })]);
  });

  it('does not accept a city-only street token as an HTML identity match', async () => {
    const cityStreetPharmacy = { ...pharmacy, id: 'it-test-roma', name: 'Farmacia Roma', city: 'Roma', address: 'Via Roma 1', phone: '' };
    const source = {
      pharmacyId: cityStreetPharmacy.id,
      kind: 'html',
      url: 'https://example.com/farmacia-roma',
      label: 'Public directory',
      sourceType: 'directory',
      fields: ['phone'],
      status: 'active',
    } as const;
    const result = await enrichPharmacyRecords([cityStreetPharmacy], localConfig({ sources: [source] }), {
      checkedAt,
      fetchDocument: async () => '<html><body><h1>Farmacia Roma</h1><p>Roma 1</p><a href="tel:+39000000000">+39 000 000000</a></body></html>',
    });

    expect(result.records[cityStreetPharmacy.id]).toEqual({ checkedAt });
    expect(result.warnings).toEqual([expect.stringContaining('page did not match it-test-roma')]);
  });

  it('uses Google Places only through the authorised API adapter and excludes ratings', async () => {
    let request: { url: string; init: Record<string, any> } | undefined;
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      providers: {
        googlePlaces: { enabled: true, pharmacyIds: [pharmacy.id] },
        facebook: { enabled: false, pharmacyIds: [] },
      },
    }), {
      checkedAt,
      googleApiKey: 'test-google-key',
      fetchJson: async (url: string, init: Record<string, any>) => {
        request = { url, init };
        return {
          places: [{
            id: 'ChIJ3907',
            displayName: { text: pharmacy.name },
            formattedAddress: `${pharmacy.address}, ${pharmacy.city}`,
            internationalPhoneNumber: '+39 0332 227362',
            websiteUri: 'https://farmacia.example/',
            googleMapsUri: 'https://maps.google.com/?cid=3907',
            regularOpeningHours: { periods: [{ open: { day: 1, hour: 8, minute: 30 }, close: { day: 1, hour: 20, minute: 0 } }] },
            rating: 5,
            userRatingCount: 99,
          }] as any,
        };
      },
    });

    expect(request?.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(request?.init.method).toBe('POST');
    expect(request?.init.headers['X-Goog-Api-Key']).toBe('test-google-key');
    expect(request?.init.headers['X-Goog-FieldMask']).toBe('places.id,places.displayName,places.formattedAddress');
    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id]).toMatchObject({
      googlePlaceId: 'ChIJ3907',
    });
    expect(result.records[pharmacy.id]).not.toHaveProperty('phone');
    expect(result.records[pharmacy.id]).not.toHaveProperty('website');
    expect(result.records[pharmacy.id]).not.toHaveProperty('openingHours');
    expect(JSON.stringify(result.records[pharmacy.id])).not.toContain('rating');
    expect(result.records[pharmacy.id].externalSources).toEqual([expect.objectContaining({
      sourceType: 'google_business_profile',
      placeId: 'ChIJ3907',
      fields: [],
    })]);
    expect(validatePharmacyEnrichmentSnapshot(buildPharmacyEnrichmentSnapshot(
      { schemaVersion: 1, generatedAt: checkedAt, records: {}, warnings: [] },
      result,
      checkedAt,
    ))).toEqual([]);
  });

  it('rejects a same-street Google candidate without name and civic-number anchors', async () => {
    const wrongNumber = pharmacy.address.replace(/\b\d+[a-z]?\b/i, '99');
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      providers: {
        googlePlaces: { enabled: true, pharmacyIds: [pharmacy.id] },
        facebook: { enabled: false, pharmacyIds: [] },
      },
    }), {
      checkedAt,
      googleApiKey: 'test-google-key',
      fetchJson: async () => ({
        places: [{
          id: 'ChIJ-wrong-branch',
          displayName: { text: 'Farmacia del Borgo' },
          formattedAddress: `${wrongNumber}, ${pharmacy.city}`,
        }],
      }),
    });

    expect(result.records[pharmacy.id]).toEqual({ checkedAt });
    expect(result.warnings).toEqual([expect.stringContaining('no sufficiently certain place match')]);
  });

  it('hard-stops Google requests at the configured monthly budget', async () => {
    let requestCount = 0;
    const config = localConfig({
      providers: {
        googlePlaces: { enabled: true, pharmacyIds: [pharmacy.id], maxAgeDays: 30, monthlyRequestLimit: 1 },
        facebook: { enabled: false, pharmacyIds: [] },
      },
    });
    const fetchJson = async () => {
      requestCount += 1;
      return { places: [] };
    };
    const first = await enrichPharmacyRecords([pharmacy], config, {
      checkedAt,
      googleApiKey: 'test-google-key',
      fetchJson,
    });

    expect(requestCount).toBe(1);
    expect(first.providerUsage).toEqual({ month: '2026-10', googlePlaces: { requests: 1 } });

    const second = await enrichPharmacyRecords([pharmacy], config, {
      previous: { records: first.records, providerUsage: first.providerUsage },
      checkedAt,
      googleApiKey: 'test-google-key',
      fetchJson,
    });

    expect(requestCount).toBe(1);
    expect(second.warnings).toEqual([expect.stringContaining('monthly request limit reached (1)')]);
    expect(second.providerUsage.googlePlaces.requests).toBe(1);
  });

  it('fails closed on an exhausted or malformed Google usage ledger', async () => {
    let requestCount = 0;
    const config = localConfig({
      providers: {
        googlePlaces: { enabled: true, pharmacyIds: [pharmacy.id], monthlyRequestLimit: 10_001 },
        facebook: { enabled: false, pharmacyIds: [] },
      },
    });

    expect(validatePharmacyEnrichmentConfig(config)).toContain(
      'googlePlaces: monthlyRequestLimit cannot exceed 10000',
    );

    const result = await enrichPharmacyRecords([pharmacy], config, {
      previous: {
        records: {},
        providerUsage: { month: '2026-10', googlePlaces: { requests: 10_001 } },
      },
      checkedAt,
      googleApiKey: 'test-google-key',
      fetchJson: async () => {
        requestCount += 1;
        return { places: [] };
      },
    });

    expect(requestCount).toBe(0);
    expect(result.providerUsage).toEqual({ month: '2026-10', googlePlaces: { requests: 10_000 } });
    expect(result.warnings).toEqual([expect.stringContaining('monthly request limit reached (10000)')]);
  });

  it('uses Facebook only with an authorised page and publishes reusable facts, not reviews', async () => {
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      providers: {
        googlePlaces: { enabled: false, pharmacyIds: [] },
        facebook: { enabled: true, pharmacyIds: [pharmacy.id] },
      },
    }), {
      checkedAt,
      facebookPageId: 'page-3907',
      facebookAccessToken: 'test-page-token',
      fetchJson: async () => ({
        name: pharmacy.name,
        link: 'https://www.facebook.com/farmaciainternazionaledicasciago',
        phone: '+39 0332 227362',
        website: 'https://farmacia.example/',
        emails: ['farmaciadicasciago@enterpoint.it'],
        location: { city: pharmacy.city, street: pharmacy.address },
        hours: { mon_1_open: '08:30', mon_1_close: '20:00' },
        rating: 5,
        reviews: [{ message: 'not imported' }],
      }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id]).toMatchObject({
      phone: '+39 0332 227362',
      contactEmail: 'farmaciadicasciago@enterpoint.it',
    });
    expect(JSON.stringify(result.records[pharmacy.id])).not.toContain('reviews');
    expect(result.records[pharmacy.id].externalSources).toEqual([expect.objectContaining({ sourceType: 'facebook' })]);
  });

  it('keeps a matched Facebook source as corroboration when official facts win', async () => {
    const result = await enrichPharmacyRecords([pharmacy], localConfig({
      providers: {
        googlePlaces: { enabled: false, pharmacyIds: [] },
        facebook: { enabled: true, pharmacyIds: [pharmacy.id] },
      },
    }), {
      previous: {
        records: {
          [pharmacy.id]: {
            checkedAt,
            phone: '+39 0332 227362',
            fieldSources: {
              phone: {
                url: enrichmentConfig.sources[0].url,
                sourceType: 'official',
                checkedAt,
              },
            },
            externalSources: [{
              url: enrichmentConfig.sources[0].url,
              label: enrichmentConfig.sources[0].label,
              sourceType: 'official',
              checkedAt,
              fields: ['phone'],
              status: 'verified',
            }],
          },
        },
      },
      checkedAt,
      facebookPageId: 'page-3907',
      facebookAccessToken: 'test-page-token',
      fetchJson: async () => ({
        name: pharmacy.name,
        link: 'https://www.facebook.com/farmaciainternazionaledicasciago',
        phone: '+39 0332 227362',
        location: { city: pharmacy.city, street: pharmacy.address },
      }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.records[pharmacy.id].phone).toBe('+39 0332 227362');
    expect(result.records[pharmacy.id].fieldSources?.phone).toMatchObject({ sourceType: 'official' });
    expect(result.records[pharmacy.id].externalSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'official' }),
      expect.objectContaining({
        sourceType: 'facebook',
        fields: ['phone'],
        url: 'https://www.facebook.com/farmaciainternazionaledicasciago',
      }),
    ]));
  });

  it('imports only identity-matched public Facebook facts into the enrichment snapshot', () => {
    const records: Record<string, any> = { [pharmacy.id]: { checkedAt } };
    const warnings: string[] = [];
    applyPublicFacebookDiscovery(records, [pharmacy], {
      candidates: [{
        pharmacyId: pharmacy.id,
        status: 'candidate_publicly_verified',
        verified: {
          matched: true,
          pageUrl: 'https://www.facebook.com/farmacia-internazionale-casciago',
          facts: {
            phone: '+39 0332 227362',
            openingHours: [{ dayOfWeek: 'monday', opens: '08:30', closes: '20:00' }],
            rating: 5,
          },
        },
      }],
    }, checkedAt, warnings);

    expect(warnings).toEqual([]);
    expect(records[pharmacy.id]).toMatchObject({ phone: '+39 0332 227362' });
    expect(records[pharmacy.id].openingHours).toEqual([{ dayOfWeek: 'monday', opens: '08:30', closes: '20:00' }]);
    expect(JSON.stringify(records[pharmacy.id])).not.toContain('rating');
    expect(records[pharmacy.id].externalSources).toEqual([expect.objectContaining({
      sourceType: 'facebook',
      url: 'https://www.facebook.com/farmacia-internazionale-casciago',
    })]);
  });

  it('sanitizes untrusted public Facebook facts before storing them', () => {
    const records: Record<string, any> = { [pharmacy.id]: { checkedAt } };
    const warnings: string[] = [];
    applyPublicFacebookDiscovery(records, [pharmacy], {
      candidates: [{
        pharmacyId: pharmacy.id,
        status: 'candidate_publicly_verified',
        verified: {
          matched: true,
          pageUrl: 'https://www.facebook.com/farmacia-internazionale-casciago',
          facts: {
            website: 'javascript:alert(1)',
            contactEmail: 'not-an-email',
            openingHours: [{ dayOfWeek: 'monday', opens: '25:00', closes: '20:00' }],
          },
        },
      }],
    }, checkedAt, warnings);

    expect(warnings).toEqual([]);
    expect(records[pharmacy.id]).toEqual({ checkedAt });
  });

  it('allows an official enrichment to replace a directory value, but not the reverse', () => {
    const base = {
      ...pharmacy,
      phone: '+39 000 000000',
      fieldSources: {
        phone: {
          url: 'https://www.openstreetmap.org/node/3907',
          sourceType: 'directory' as const,
          checkedAt,
          license: 'ODbL 1.0',
        },
      },
    } as Pharmacy;
    const official = {
      checkedAt,
      phone: '+39 0332 227362',
      fieldSources: {
        phone: { url: 'https://comune.casciago.va.it/farmacia', sourceType: 'official' as const, checkedAt },
      },
      externalSources: [{
        url: 'https://comune.casciago.va.it/farmacia',
        label: 'Comune di Casciago',
        sourceType: 'official' as const,
        checkedAt,
        fields: ['phone' as const],
      }],
    };
    const officialRecord = mergePharmacyEnrichment(base, official);
    expect(officialRecord.phone).toBe('+39 0332 227362');

    const lowerTrust = mergePharmacyEnrichment(officialRecord, {
      ...official,
      phone: '+39 111 111111',
      fieldSources: {
        phone: { url: 'https://www.openstreetmap.org/node/3907', sourceType: 'directory', checkedAt },
      },
    });
    expect(lowerTrust.phone).toBe('+39 0332 227362');
  });

  it('keeps the legal entity in the body while making the SEO title extractable', () => {
    expect(pharmacyNameForSeo(pharmacy.name)).toBe('FARMACIA INTERNAZIONALE DI CASCIAGO');
    const title = buildPharmacyTitle(pharmacy, [pharmacy]);
    expect(title).toBe('FARMACIA INTERNAZIONALE DI CASCIAGO — Casciago');
    expect(title).not.toContain('…');
  });
});
