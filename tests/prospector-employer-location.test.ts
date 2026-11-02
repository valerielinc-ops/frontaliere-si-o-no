import { beforeEach, describe, expect, it } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import {
  officialEmployerLocationLinks,
  resolveDetailOrListingSwissGeography,
  resolveOfficialEmployerSiteLocation,
  sourceBackedCrawlerBlockReport,
} from '../scripts/lib/prospector/location-evidence.mjs';
import { geographyFieldsForDecision, observeSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import { gradeVacancy } from '../scripts/lib/prospector/validate.mjs';

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const ORGANIZATION_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Example AG',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Via Cantonale 1',
    postalCode: '6500',
    addressLocality: 'Bellinzona',
    addressRegion: 'TI',
    addressCountry: 'CH',
  },
});
const OFFICIAL_HOME = `<html><body><footer><a href="/impressum">Impressum</a><p>Example AG · Via Cantonale 1 · 6500 Bellinzona</p></footer><script type="application/ld+json">${ORGANIZATION_JSON_LD}</script></body></html>`;
const OFFICIAL_IMPRESSUM = '<main><h1>Impressum</h1><address>Example AG<br>Via Cantonale 1<br>6500 Bellinzona</address></main>';

describe('prospector official employer location proof', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('accepts one Swiss address from the verified site and records its provenance', () => {
    expect(officialEmployerLocationLinks(OFFICIAL_HOME, 'https://example.ch/', 'example.ch'))
      .toEqual([{ url: 'https://example.ch/impressum', kind: 'impressum' }]);

    const proof = resolveOfficialEmployerSiteLocation([
      { html: OFFICIAL_HOME, url: 'https://example.ch/', kind: 'homepage' },
      { html: OFFICIAL_IMPRESSUM, url: 'https://example.ch/impressum', kind: 'impressum' },
    ], { verifiedEmployerDomain: 'example.ch', companyName: 'Example AG' });

    expect(proof).toMatchObject({
      reasonCode: null,
      geography: {
        canton: 'TI',
        addressLocality: 'Bellinzona',
        postalCode: '6500',
        streetAddress: 'Via Cantonale 1',
      },
      evidence: {
        source: 'employer_site',
        type: 'jsonld_organization',
        url: 'https://example.ch/',
      },
    });
  });

  it('requires an explicit JSON-LD script type for official organization evidence', () => {
    const untypedOrganization = `<script>${ORGANIZATION_JSON_LD}</script>`;
    expect(resolveOfficialEmployerSiteLocation([
      { html: untypedOrganization, url: 'https://example.ch/', kind: 'homepage' },
    ], { verifiedEmployerDomain: 'example.ch', companyName: 'Example AG' })).toMatchObject({
      geography: null,
      candidate: null,
      reasonCode: 'official_address_missing',
    });
  });

  it('refuses multiple official sites, ATS-owned domains, and agencies', () => {
    const lugano = OFFICIAL_IMPRESSUM.replaceAll('Bellinzona', 'Lugano').replaceAll('6500', '6900');
    expect(resolveOfficialEmployerSiteLocation([
      { html: OFFICIAL_IMPRESSUM, url: 'https://example.ch/impressum', kind: 'impressum' },
      { html: lugano, url: 'https://example.ch/contact', kind: 'contact' },
    ], { verifiedEmployerDomain: 'example.ch', companyName: 'Example AG' })).toMatchObject({
      geography: null,
      reasonCode: 'multiple_official_sedes',
      observedLocations: expect.arrayContaining([
        expect.objectContaining({ addressLocality: 'Bellinzona' }),
        expect.objectContaining({ addressLocality: 'Lugano' }),
      ]),
    });

    expect(resolveOfficialEmployerSiteLocation([
      { html: OFFICIAL_HOME, url: 'https://jobs.shared-ats.example/', kind: 'homepage' },
    ], {
      verifiedEmployerDomain: 'jobs.shared-ats.example',
      platform: 'shared-ats.example',
      companyName: 'Example AG',
    }).reasonCode).toBe('verified_domain_is_shared_platform');

    expect(resolveOfficialEmployerSiteLocation([
      { html: OFFICIAL_HOME, url: 'https://staffing.example/', kind: 'homepage' },
    ], {
      verifiedEmployerDomain: 'staffing.example',
      companyName: 'Example Personalberatung AG',
    }).reasonCode).toBe('agency_employer');

    expect(resolveOfficialEmployerSiteLocation([], {
      verifiedEmployerDomain: 'campobasso-work.ch',
      companyName: 'Campobasso Work Agency GmbH',
    }).reasonCode).toBe('agency_employer');
    expect(resolveOfficialEmployerSiteLocation([], {
      verifiedEmployerDomain: 'flexsis.ch',
      companyName: 'Flexsis AG',
    }).reasonCode).toBe('agency_employer');
  });

  it('lets a vacancy location win over the employer site address', () => {
    const proof = resolveOfficialEmployerSiteLocation([
      { html: OFFICIAL_HOME, url: 'https://example.ch/', kind: 'homepage' },
    ], { verifiedEmployerDomain: 'example.ch', companyName: 'Example AG' });
    const decision = resolveDetailOrListingSwissGeography(
      {},
      { location: 'Zürich', addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' },
      { officialEmployerSiteLocation: proof },
    );

    expect(decision).toMatchObject({ geography: { location: 'Zürich', canton: 'ZH' } });
    expect(decision.candidate).not.toHaveProperty('locationSource', 'employer_site');
    expect(geographyFieldsForDecision(decision, {
      recordLocationEvidence: true,
      locationEvidenceUrl: 'https://jobs.example/job/1',
      offerLocation: 'Zürich',
    })).toMatchObject({
      locationSource: 'offer',
      offerLocation: 'Zürich',
      locationEvidence: { source: 'offer', url: 'https://jobs.example/job/1' },
    });

    const countryOnlyDecision = resolveDetailOrListingSwissGeography(
      { addressCountry: 'CH' },
      {},
      { officialEmployerSiteLocation: proof },
    );
    expect(countryOnlyDecision).toMatchObject({
      geography: null,
      hasDeclaredLocation: true,
    });
    expect(geographyFieldsForDecision(countryOnlyDecision, {
      recordLocationEvidence: true,
      offerLocation: 'CH',
    })).toBeNull();
  });

  it('uses the official proof only when the detail has no declared workplace', async () => {
    const seed = 'https://employer.example/careers/';
    const detail = 'https://employer.example/jobs/platform-engineer';
    const description = 'The successful candidate will plan services, document procedures, solve operational issues, and support continuous improvement across the organisation. '.repeat(3);
    const listing = `<a href="${detail}">Platform Engineer</a>`;
    const detailHtml = `<h1>Platform Engineer</h1><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Platform Engineer',
      datePosted: daysAgo(2),
      description,
    })}</script><main><p>${description}</p></main>`;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(listing);
      if (url === detail) return new Response(detailHtml);
      if (url === 'https://employer.example/') return new Response(OFFICIAL_HOME);
      if (url === 'https://employer.example/impressum') return new Response(OFFICIAL_IMPRESSUM);
      throw new Error(`unexpected fixture URL: ${url}`);
    };
    const observed = await observeSpecInProduction({
      companyKey: 'employer',
      companyName: 'Example AG',
      companyHost: 'employer.example',
      verifiedEmployerDomain: 'employer.example',
      employerSiteLocationFallback: true,
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/jobs/*',
      detailEnrichment: true,
      detailFetchWorkers: 1,
    } as any, {
      fetchImpl,
      lookupImpl: async () => PUBLIC_IP,
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
      employerSiteLocationFallback: true,
      verifiedEmployerDomain: 'employer.example',
    });

    expect(observed.vacancies).toHaveLength(1);
    expect(observed.vacancies[0]).toMatchObject({
      location: 'Bellinzona, TI',
      canton: 'TI',
      addressLocality: 'Bellinzona',
      postalCode: '6500',
      streetAddress: 'Via Cantonale 1',
      locationSource: 'employer_site',
      offerLocation: '',
      locationEvidence: {
        source: 'employer_site',
        url: 'https://employer.example/',
        type: 'jsonld_organization',
      },
    });
    expect(observed.observation).toMatchObject({
      listingCount: 1,
      publishableCount: 1,
      sourceBackedLocationCount: 1,
      dropCounts: {},
    });
  });

  it('does not let an employer-site seat satisfy the independent jobLike proof', async () => {
    const graded = await gradeVacancy({
      title: 'Platform Engineer',
      url: 'https://employer.example/jobs/platform-engineer',
      location: 'Bellinzona, TI',
      locationSource: 'employer_site',
    } as any, {
      observedDetail: {
        body: `<h1>Platform Engineer</h1>${'opaque structured page '.repeat(80)}`,
        status: 200,
        url: 'https://employer.example/jobs/platform-engineer',
        detail: {
          title: 'Platform Engineer',
          hasStructuredVacancy: true,
          locationCandidates: [],
        },
      },
      titleEvidence: {
        detailTitle: 'Platform Engineer',
        finalTitle: 'Platform Engineer',
        titleSource: 'detail',
      },
      spec: {
        companyName: 'Example AG',
        companyHost: 'employer.example',
      },
    });

    expect(graded).toMatchObject({
      sourceBackedLocation: true,
      jobLikeEvidence: null,
      jobLikeEvidenceMode: 'unmeasured',
    });
  });

  it('reports source-backed crawler blocks without changing their publication state', () => {
    const report = sourceBackedCrawlerBlockReport([
      {
        companyKey: 'blocked',
        validationHistory: [{
          runtimeObservation: {
            listingCount: 2,
            publishableCount: 0,
            dropCounts: { source_backed_geography_missing: 2 },
          },
        }],
      },
      {
        companyKey: 'partial',
        observation: {
          listingCount: 3,
          publishableCount: 1,
          dropCounts: { source_backed_geography_missing: 1 },
        },
      },
    ]);

    expect(report).toMatchObject({
      candidateCount: 2,
      listingRows: 5,
      publishableRows: 1,
      sourceBackedGeographyMissingRows: 3,
      allRowsFiltered: 1,
      records: [
        expect.objectContaining({ key: 'blocked', allRowsFiltered: true }),
        expect.objectContaining({ key: 'partial', allRowsFiltered: false }),
      ],
    });
  });
});
