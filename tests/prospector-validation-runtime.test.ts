import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { observeSpecInProduction, runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import { gradeExtraction, gradeVacancy } from '../scripts/lib/prospector/validate.mjs';
import { isGenericVacancyTitle, rawDetailTitleEvidence, selectPublishableTitle } from '../scripts/lib/prospector/production-title.mjs';
import { selectValidationSample } from '../scripts/lib/prospector/validation-sample.mjs';
import { prioritizeValidationSpecs } from '../scripts/lib/prospector/validation-schedule.mjs';
import { reconcileOpenPromotions } from '../scripts/lib/prospector/promotion-reconciliation.mjs';
import { candidateStatusAfterValidation, evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import { requeuePromotedCandidate } from '../scripts/lib/prospector/candidate-store.mjs';
import {
  productionRuntimeOptionsFor,
  sourceAdapterRuntimeObservationFor,
} from '../scripts/lib/prospector/source-adapters.mjs';
import { matchExistingCrawlerForCompleteSnapshot } from '../scripts/lib/prospector/runtime-duplicate.mjs';

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];
const DESCRIPTION = 'The successful candidate will plan and deliver reliable customer services, work with the engineering team, document procedures, solve operational issues, and support continuous improvement across the organisation. '.repeat(3);

function fixtureSpec({
  firstTwoLocations = 'missing',
  populationCount = 10,
  genericListingTitleIndex = -1,
  allLocationsSwiss = false,
}: {
  firstTwoLocations?: 'missing' | 'foreign';
  populationCount?: number;
  genericListingTitleIndex?: number;
  allLocationsSwiss?: boolean;
} = {}) {
  const seed = 'https://employer.example/careers/';
  const urls = Array.from({ length: populationCount }, (_, index) => `https://employer.example/jobs/${index + 1}`);
  const listing = urls.map((url, index) => `<a href="${url}">${index === genericListingTitleIndex ? 'Jobs' : `Platform Engineer ${index + 1}`}</a>`).join('\n');
  const detailBodies = new Map(urls.map((url, index) => {
    const jobLocation = index < 2 && !allLocationsSwiss
      ? (firstTwoLocations === 'foreign'
        ? { address: { addressLocality: 'Vaduz', addressCountry: 'LI' } }
        : undefined)
      : { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } };
    const posting = {
      '@type': 'JobPosting',
      title: 'Header',
      description: DESCRIPTION,
      ...(jobLocation ? { jobLocation } : {}),
    };
    return [url, `<html><head><title>Header</title></head><body><h1>Header</h1>
      <script type="application/ld+json">${JSON.stringify(posting)}</script>
      <main><p>Platform Engineer ${index + 1}</p><p>${DESCRIPTION}</p></main></body></html>`];
  }));
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
    if (url === seed) return new Response(listing);
    const detail = detailBodies.get(url);
    if (detail) return new Response(detail);
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  return {
    spec: {
      companyKey: 'employer',
      companyName: 'Employer',
      companyHost: 'employer.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/jobs/*',
      detailEnrichment: true,
      detailFetchWorkers: 4,
    } as any,
    urls,
    fetchImpl,
    runtime: {
      fetchImpl,
      lookupImpl: async () => PUBLIC_IP,
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    },
  };
}

describe('Prospector production validation', () => {
  it('reads Open Graph title regardless of meta attribute order', () => {
    expect(rawDetailTitleEvidence('<meta property="og:title" content="Senior Engineer">').rawOpenGraphTitle)
      .toBe('Senior Engineer');
    expect(rawDetailTitleEvidence('<meta content="Senior Engineer" property="og:title">').rawOpenGraphTitle)
      .toBe('Senior Engineer');
    expect(rawDetailTitleEvidence('<meta content="Senior Engineer" name="og:title">').rawOpenGraphTitle)
      .toBe('Senior Engineer');
    expect(rawDetailTitleEvidence('<meta property="og:title" content="Senior > Engineer">').rawOpenGraphTitle)
      .toBe('Senior > Engineer');
  });

  it('keeps a valid listing title when the detail H1 is generic chrome', () => {
    expect(isGenericVacancyTitle('Header')).toBe(true);
    expect(selectPublishableTitle('Header', 'Platform Engineer')).toBe('Platform Engineer');
    expect(selectPublishableTitle('Jobs', 'Offene Stellen')).toBe('');
    expect(selectPublishableTitle('Mehr erfahren', 'Mehr erfahren', ['Mehr erfahren', 'Careers | Employer']))
      .toBe('');
    expect(selectPublishableTitle('Mehr erfahren', 'Mehr erfahren', ['', 'Disposition Küche - Jobportal | Hans Eisenring']))
      .toBe('Disposition Küche');
    expect(selectPublishableTitle('Mehr erfahren', 'Mehr erfahren', 'Careers | Employer')).toBe('');
  });

  it('uses the detail title and labelled workplace when listing data contains CTAs and a company address', async () => {
    const seed = 'https://hanseisenring.ch/unternehmen/karriere/jobportal';
    const roles = [
      { slug: 'disposition-kueche', title: 'Disposition Küche', locality: 'Münchwilen', canton: 'TG' },
      { slug: 'sachbearbeitung-servicecenter', title: 'Sachbearbeitung Servicecenter', locality: 'Wängi', canton: 'TG' },
      { slug: 'projektleitung-abacus', title: 'Projektleitung Abacus', locality: 'Oensingen', canton: 'SO' },
      { slug: 'servicetechnik-ostschweiz', title: 'Servicetechnik', locality: 'Einsatzgebiet Ostschweiz oder Region Zürich', canton: '' },
    ];
    const urls = roles.map(({ slug }) => `${seed}/${slug}`);
    const detailsByUrl = new Map(roles.map((role, index) => {
      const structuredPosting = {
        '@type': 'JobPosting',
        title: 'Mehr erfahren',
        description: DESCRIPTION,
        jobLocation: {
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Sirnach',
            addressRegion: 'TG',
            addressCountry: 'CH',
          },
        },
      };
      const body = `<html><head><title>${role.title} - Jobportal - Karriere - Unternehmen | Hans Eisenring</title>
        <meta property="og:title" content="${role.title}" /></head><body>
        <main><script type="application/ld+json">${JSON.stringify(structuredPosting)}</script>
        <div><h3>Arbeitsort</h3><div class="c-bodytext"><p>${role.locality}${role.canton ? ` (${role.canton})` : ''}</p></div></div>
        <p>${DESCRIPTION}</p><p>Aufgaben und Anforderungen für ${role.title}.</p></main></body></html>`;
      return [urls[index], body];
    }));
    const listing = roles.map((_, index) => `<a href="${urls[index]}">Mehr erfahren</a>`).join('\n');
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(listing);
      const body = detailsByUrl.get(url);
      if (body) return new Response(body);
      throw new Error(`unexpected fixture URL: ${url}`);
    };
    const spec = {
      companyKey: 'hanseisenring',
      companyName: 'Hans Eisenring AG',
      companyHost: 'hanseisenring.ch',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/unternehmen/karriere/jobportal/*',
      detailEnrichment: true,
      detailLocationLabel: 'Arbeitsort',
      qualityContractVersion: 2,
      detailFetchWorkers: 3,
    } as any;
    const runtime = {
      fetchImpl,
      lookupImpl: async () => PUBLIC_IP,
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    };

    expect(isGenericVacancyTitle('Mehr erfahren')).toBe(true);
    expect(selectPublishableTitle('Mehr erfahren', 'Mehr erfahren', ['Disposition Küche']))
      .toBe('Disposition Küche');

    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(spec, runtime);
      const publishableRoles = roles.filter((role) => role.canton);
      expect(observed.vacancies.map((vacancy) => vacancy.title)).toEqual(publishableRoles.map((role) => role.title));
      expect([...observed.titleEvidenceByUrl.values()].map((evidence) => evidence.titleSource))
        .toEqual(['raw_open_graph', 'raw_open_graph', 'raw_open_graph']);
      expect(observed.vacancies.map((vacancy) => vacancy.location))
        .toEqual(publishableRoles.map((role) => role.locality));
      expect(observed.vacancies.map((vacancy) => vacancy.canton))
        .toEqual(publishableRoles.map((role) => role.canton));
      expect(observed.observation.dropCounts).toMatchObject({ source_backed_geography_missing: 1 });

      const report = await gradeExtraction(spec, observed.vacancies, {
        sampleSize: 3,
        runtimeObservation: observed.observation,
        observedDetailsByUrl: observed.detailPagesByUrl,
        titleEvidenceByUrl: observed.titleEvidenceByUrl,
        sampleDate: '2026-10-20T12:00:00.000Z',
        lookupImpl: async () => PUBLIC_IP,
        fetchImpl,
        sleepImpl: async () => {},
      });
      expect(report).toMatchObject({
        qualityContractVersion: 2,
        vacancyCount: 3,
        sampled: 3,
        titleMatchRate: 1,
        locationSourceRate: 0.75,
        verdict: 'good',
      });
      expect(report.samples.every((sample) => sample.titleEvidenceSource === 'raw_open_graph' && sample.titleMatch === 1))
        .toBe(true);
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('grades the production output, counts unexpected geography drops, and rejects an incomplete snapshot', async () => {
    const { spec, urls, runtime } = fixtureSpec();
    clearPoliteFetchStateForTests();
    try {
      let rejected: any;
      try {
        await runSpecInProduction(spec, runtime);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected.specRuntimeObservation).toMatchObject({
        listingCount: 10,
        publishableCount: 8,
        runtimeOutputCount: 0,
        snapshotAccepted: false,
        exactListingCount: true,
        qualityDropDenominator: 10,
        complete: false,
        sourceBackedLocationCount: 8,
        sourceBackedLocationDenominator: 10,
        dropCounts: { source_backed_geography_missing: 2 },
        detailDrop: { candidates: 10, rejected: 2, dropped: 2 },
      });

      clearPoliteFetchStateForTests();
      const observed = await observeSpecInProduction(spec, runtime);
      expect(observed.vacancies).toHaveLength(8);
      expect(observed.observation).toMatchObject({
        publishableCount: 8,
        runtimeOutputCount: 0,
        snapshotAccepted: false,
      });
      expect(observed.vacancies[0]).toMatchObject({
        title: 'Platform Engineer 3',
        datePosted: '',
        postingDateSource: 'unknown',
      });
      expect(observed.vacancies.some((vacancy) => vacancy.title === 'Header')).toBe(false);
      expect(observed.titleEvidenceByUrl?.get(observed.vacancies[0].url)).toMatchObject({
        listingTitle: 'Platform Engineer 3',
        rawH1Title: 'Header',
        rawDocumentTitle: 'Header',
        finalTitle: 'Platform Engineer 3',
        titleSource: 'listing',
      });

      const report = await gradeExtraction(spec, observed.vacancies, {
        sampleSize: 3,
        runtimeObservation: observed.observation,
        observedDetailsByUrl: observed.detailPagesByUrl || undefined,
        sampleDate: '2026-10-19T12:00:00.000Z',
        lookupImpl: async () => PUBLIC_IP,
        fetchImpl: runtime.fetchImpl,
        sleepImpl: async () => {},
      });
      expect(report.vacancyCount).toBe(8);
      expect(report.locationSourceRate).toBe(0.8);
      expect(report.sampleSelection).toMatchObject({
        algorithmVersion: 'utc-cyclic-strata-v1',
        populationCount: 8,
        sampleCount: 3,
        day: '2026-10-19',
      });
      expect(report.sampleSelection.selected).toHaveLength(3);
      expect(report.samples.every((sample) => sample.titleMatch > 0.8)).toBe(true);
      expect(urls).toHaveLength(10);
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('counts source-backed geography before a title drop and resets a small all-drop snapshot', async () => {
    const titleDropFixture = fixtureSpec({ genericListingTitleIndex: 2 });
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(titleDropFixture.spec, titleDropFixture.runtime);
      expect(observed.observation).toMatchObject({
        listingCount: 10,
        publishableCount: 7,
        sourceBackedLocationCount: 8,
        sourceBackedLocationDenominator: 10,
        sourceBackedLocationRate: 0.8,
        dropCounts: {
          source_backed_geography_missing: 2,
          generic_or_missing_title: 1,
        },
      });
    } finally {
      clearPoliteFetchStateForTests();
    }

    const tinyFixture = fixtureSpec({
      populationCount: 1,
      genericListingTitleIndex: 0,
      allLocationsSwiss: true,
    });
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(tinyFixture.spec, tinyFixture.runtime);
      expect(observed.observation).toMatchObject({
        listingCount: 1,
        publishableCount: 0,
        runtimeOutputCount: 0,
        snapshotAccepted: true,
        productionSnapshotAccepted: true,
        complete: false,
        promotionObservationComplete: false,
        sourceBackedLocationCount: 1,
        dropCounts: { generic_or_missing_title: 1 },
      });
      const candidate = {
        status: 'promoted',
        crawlerKey: 'employer',
        validationHistory: [
          { at: '2026-10-17T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
          { at: '2026-10-18T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
          { at: '2026-10-19T09:00:00Z', verdict: 'weak', runtimeSnapshotComplete: observed.observation.complete },
        ],
      };
      expect(evaluatePromotion(candidate).checks.days).toBe(false);
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('does not match a partial URL overlap as a terminal twin and ignores body title tokens', async () => {
    const url = 'https://existing.example/jobs/42';
    const ownership = {
      urlsByKey: new Map([['incumbent', new Set([url])]]),
    };
    const partialUrls = [url];
    expect(matchExistingCrawlerForCompleteSnapshot(partialUrls, ownership, {}, {
      complete: false,
      listingPopulationComplete: false,
    })).toBeNull();
    const antiBotRows: any[] = [];
    Object.defineProperties(antiBotRows, {
      fetchOutcome: { value: 'anti_bot_block', enumerable: false },
      discoveredCount: { value: 2, enumerable: false },
    });
    const failedObservation = sourceAdapterRuntimeObservationFor(antiBotRows);
    expect(matchExistingCrawlerForCompleteSnapshot(partialUrls, ownership, {}, failedObservation)).toBeNull();
    expect(matchExistingCrawlerForCompleteSnapshot(partialUrls, ownership, {}, {
      complete: true,
      listingPopulationComplete: true,
    })).toMatchObject({ key: 'incumbent', shared: 1, total: 1 });

    const description = 'A welcome page with office details, services, company history and contact information only.';
    const detailBody = `<html><title>Open positions</title><h1>Careers</h1><main><p>Platform Engineer</p>${DESCRIPTION}</main></html>`;
    const graded = await gradeVacancy({
      url,
      title: 'Platform Engineer',
      description,
    }, {
      observedDetail: {
        body: detailBody,
        status: 200,
        url,
        detail: { title: 'Platform Engineer', description: DESCRIPTION, locationCandidates: [] },
      },
      titleEvidence: {
        listingTitle: 'Accountant',
        detailTitle: 'Platform Engineer',
        finalTitle: 'Platform Engineer',
        titleSource: 'detail',
      },
    });
    expect(graded.titleMatch).toBe(0);
    expect(graded.listingTitle).toBe('Accountant');
    expect(graded.detailTitle).toBe('Platform Engineer');
    expect(graded.finalTitle).toBe('Platform Engineer');
    expect(graded.authoritativeTitle).toBe('Accountant');
    expect(graded.titleEvidenceSource).toBe('listing');
    expect(graded.titleSource).toBe('detail');
    expect(graded.jobLike).toBe(false);
  });

  it('accepts the PhysioSwiss listing-title fallback when raw detail headings are Header chrome', async () => {
    const title = 'Dipl. Physiotherapeut/-in (40-100%)';
    expect(selectPublishableTitle('Header', title)).toBe(title);
    const graded = await gradeVacancy({
      url: 'https://physioswiss.ch/stelleninserate/157790/dipl-physiotherapeut-in-40-100/',
      title,
      description: DESCRIPTION,
    }, {
      observedDetail: {
        body: `<html><title>Header</title><h1>Header</h1><main>${DESCRIPTION}</main></html>`,
        status: 200,
        url: 'https://physioswiss.ch/stelleninserate/157790/dipl-physiotherapeut-in-40-100/',
        detail: { title: 'Header', description: DESCRIPTION, locationCandidates: [] },
      },
      titleEvidence: {
        listingTitle: title,
        detailTitle: 'Header',
        finalTitle: title,
        titleSource: 'listing',
      },
    });
    expect(graded).toMatchObject({
      titleMatch: 1,
      titleSource: 'listing',
      titleEvidenceSource: 'listing',
      authoritativeTitle: title,
      rawH1Title: 'Header',
      rawDocumentTitle: 'Header',
    });
  });

  it('classifies explicitly expected geography filters separately from quality drops', async () => {
    const { spec, runtime } = fixtureSpec({ firstTwoLocations: 'foreign' });
    spec.companyKey = 'medimeo';
    const productionOptions = productionRuntimeOptionsFor(spec);
    expect(productionOptions?.isExpectedDetailFilter).toBeTypeOf('function');
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(spec, { ...runtime, ...productionOptions });
      expect(observed.observation).toMatchObject({
        listingCount: 10,
        publishableCount: 8,
        runtimeOutputCount: 8,
        snapshotAccepted: true,
        qualityDropDenominator: 8,
        expectedFilterCount: 2,
        expectedFilters: { source_geography: 2 },
        dropCounts: { source_backed_geography_missing: 0 },
        complete: true,
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('does not excuse missing or unknown Medimeo geography as an expected foreign filter', async () => {
    const { spec, runtime } = fixtureSpec();
    spec.companyKey = 'medimeo';
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(spec, {
        ...runtime,
        ...productionRuntimeOptionsFor(spec),
      });
      expect(observed.observation).toMatchObject({
        listingCount: 10,
        publishableCount: 8,
        runtimeOutputCount: 0,
        snapshotAccepted: false,
        qualityDropDenominator: 10,
        expectedFilterCount: 0,
        dropCounts: { source_backed_geography_missing: 2 },
        complete: false,
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('records a production anti-bot empty outcome as incomplete validation evidence', async () => {
    const { spec, runtime } = fixtureSpec();
    spec.rescueOnEmptyListing = true;
    spec.emptyListingOutcome = 'anti_bot_block';
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/jobs\/\d+$/.test(url)) return new Response('Forbidden by edge policy', { status: 403 });
      return runtime.fetchImpl(input);
    };
    const blockedRuntime = {
      ...runtime,
      fetchImpl,
      disableWafProxy: false,
      jinaRetries: 0,
      jinaFetchImpl: async () => new Response('upstream unavailable', { status: 502 }),
      jinaSleepImpl: async () => {},
    };
    clearPoliteFetchStateForTests();
    try {
      const productionRows = await runSpecInProduction(spec, blockedRuntime);
      expect(productionRows).toHaveLength(0);
      expect((productionRows as any).fetchOutcome).toBe('anti_bot_block');

      clearPoliteFetchStateForTests();
      const observed = await observeSpecInProduction(spec, blockedRuntime);
      expect(observed.observation).toMatchObject({
        listingCount: 10,
        publishableCount: 0,
        runtimeOutputCount: 0,
        snapshotAccepted: false,
        complete: false,
        dropCounts: { detail_fetch_or_extraction: 10 },
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it.each(['anti_bot_block', 'selector_miss'])('fails closed on empty listing extractor outcome %s', async (fetchOutcome) => {
    const { spec, runtime } = fixtureSpec({ populationCount: 0 });
    const fetch = runtime.fetchImpl;
    runtime.fetchImpl = async (input: string | URL | Request) => (
      String(input) === spec.seedUrls[0]
        ? new Response('<html><body>Source response</body></html>')
        : fetch(input)
    );
    (runtime as any).listingExtractor = () => {
      const empty: any[] = [];
      Object.defineProperties(empty, {
        fetchOutcome: { value: fetchOutcome, enumerable: false },
        discoveredCount: { value: 0, enumerable: false },
      });
      return empty;
    };
    clearPoliteFetchStateForTests();
    try {
      let rejected: any;
      try {
        await runSpecInProduction(spec, runtime);
      } catch (error) {
        rejected = error;
      }
      expect(rejected?.specRuntimeObservation).toMatchObject({
        fetchOutcome,
        listingCount: 0,
        exactListingCount: false,
        snapshotAccepted: false,
        complete: false,
      });

      clearPoliteFetchStateForTests();
      const observed = await observeSpecInProduction(spec, runtime);
      expect(observed.observation).toMatchObject({
        fetchOutcome,
        exactListingCount: false,
        snapshotAccepted: false,
        complete: false,
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('accepts an explicitly successful authoritative empty listing', async () => {
    const { spec, runtime } = fixtureSpec({ populationCount: 0 });
    const fetch = runtime.fetchImpl;
    runtime.fetchImpl = async (input: string | URL | Request) => (
      String(input) === spec.seedUrls[0]
        ? new Response('<html><body>No vacancies right now</body></html>')
        : fetch(input)
    );
    (runtime as any).listingExtractor = () => {
      const empty: any[] = [];
      Object.defineProperties(empty, {
        fetchOutcome: { value: 'ok', enumerable: false },
        discoveredCount: { value: 0, enumerable: false },
      });
      return empty;
    };
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(spec, runtime);
      expect(observed.vacancies).toHaveLength(0);
      expect(observed.observation).toMatchObject({
        fetchOutcome: 'ok',
        listingCount: 0,
        exactListingCount: true,
        snapshotAccepted: true,
        complete: true,
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('keeps an empty listing without an authoritative outcome retryable', async () => {
    const { spec, runtime } = fixtureSpec({ populationCount: 0 });
    clearPoliteFetchStateForTests();
    try {
      const observed = await observeSpecInProduction(spec, runtime);
      expect(observed.observation).toMatchObject({
        listingCount: 0,
        exactListingCount: false,
        snapshotAccepted: false,
        complete: false,
        dropCounts: { unverified_empty_listing: 1 },
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('aborts a non-empty detail-enriched listing with a selector-miss outcome', async () => {
    const { spec, urls, runtime } = fixtureSpec({ populationCount: 1 });
    (runtime as any).listingExtractor = () => {
      const partial: any[] = [{ title: 'Platform Engineer 1', url: urls[0] }];
      Object.defineProperties(partial, {
        fetchOutcome: { value: 'selector_miss', enumerable: false },
        discoveredCount: { value: 1, enumerable: false },
      });
      return partial;
    };
    clearPoliteFetchStateForTests();
    try {
      let rejected: any;
      try {
        await runSpecInProduction(spec, runtime);
      } catch (error) {
        rejected = error;
      }
      expect(rejected?.specRuntimeObservation).toMatchObject({
        fetchOutcome: 'selector_miss',
        listingCount: 1,
        exactListingCount: false,
        snapshotAccepted: false,
        complete: false,
        dropCounts: { fetch_outcome_selector_miss: 1 },
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });

  it('fails closed on a non-empty listing with an explicit undefined fetch outcome', async () => {
    const { spec, urls, runtime } = fixtureSpec({ populationCount: 1, allLocationsSwiss: true });
    (runtime as any).listingExtractor = () => {
      const rows: any[] = [{ title: 'Platform Engineer 1', url: urls[0] }];
      Object.defineProperties(rows, {
        fetchOutcome: { value: undefined, enumerable: false },
        discoveredCount: { value: 1, enumerable: false },
      });
      return rows;
    };
    clearPoliteFetchStateForTests();
    try {
      let rejected: any;
      try {
        await runSpecInProduction(spec, runtime);
      } catch (error) {
        rejected = error;
      }
      expect(rejected?.specRuntimeObservation).toMatchObject({
        fetchOutcome: null,
        exactListingCount: false,
        snapshotAccepted: false,
        complete: false,
        dropCounts: { unknown_fetch_outcome: 1 },
      });
    } finally {
      clearPoliteFetchStateForTests();
    }
  });
});

describe('Prospector validation sample and schedule', () => {
  it('replays a same-day sample, rotates it on the next UTC day, and takes a small-population census', () => {
    const vacancies = Array.from({ length: 10 }, (_, index) => ({ url: `https://employer.example/jobs/${index}` }));
    const first = selectValidationSample(vacancies, {
      companyKey: 'employer', sampleSize: 3, date: '2026-10-19T01:00:00.000Z',
    });
    const replay = selectValidationSample(vacancies, {
      companyKey: 'employer', sampleSize: 3, date: '2026-10-19T23:00:00.000Z',
    });
    const nextDay = selectValidationSample(vacancies, {
      companyKey: 'employer', sampleSize: 3, date: '2026-10-20T00:00:00.000Z',
    });
    expect(first.selected.map(({ id }) => id)).toEqual(replay.selected.map(({ id }) => id));
    expect(first.selected.map(({ index }) => index)).not.toEqual(nextDay.selected.map(({ index }) => index));
    expect(selectValidationSample(vacancies.slice(0, 2), { sampleSize: 4 }).sampleCount).toBe(2);
    expect(selectValidationSample(vacancies.slice(0, 2), { sampleSize: 4 }).selected.map(({ index }) => index))
      .toEqual([0, 1]);
  });

  it('reserves predictable slots for candidates due for their second distinct-day pass', () => {
    const candidates: Record<string, any> = {
      'due.example': {
        status: 'promoted',
        validationHistory: [{ at: '2026-10-18T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true }],
      },
    };
    const specs = [
      { companyKey: 'due.example' },
      ...Array.from({ length: 12 }, (_, index) => ({ companyKey: `new-${String(index).padStart(2, '0')}.example` })),
    ];
    const order = prioritizeValidationSpecs(specs, (spec) => candidates[spec.companyKey], {
      limit: 8,
      date: '2026-10-19T12:00:00Z',
    });
    expect(order[0].companyKey).toBe('due.example');
    expect(order).toHaveLength(8);
    expect(order.slice(1).every((spec) => spec.companyKey.startsWith('new-'))).toBe(true);
  });

  it('does not treat a prior runtime-incomplete candidate as already stable', () => {
    const specs = [
      { companyKey: 'retry.example' },
      { companyKey: 'stable.example' },
    ];
    const candidates: Record<string, any> = {
      'retry.example': {
        validationHistory: [
          { at: '2026-10-17T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
          { at: '2026-10-18T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
          { at: '2026-10-19T09:00:00Z', verdict: 'weak', runtimeSnapshotComplete: false },
        ],
      },
      'stable.example': {
        validationHistory: [
          { at: '2026-10-17T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
          { at: '2026-10-18T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
        ],
      },
    };
    const order = prioritizeValidationSpecs(specs, (spec) => candidates[spec.companyKey], {
      limit: 1,
      date: '2026-10-19T12:00:00Z',
    });
    expect(order[0].companyKey).toBe('retry.example');
  });

  it('retries an incomplete Medimeo snapshot and clears previous good-day readiness', () => {
    expect(candidateStatusAfterValidation({ verdict: 'bad', runtimeSnapshotComplete: false }))
      .toBe('validated');
    const candidate = {
      status: 'promoted',
      crawlerKey: 'medimeo',
      validationHistory: [
        { at: '2026-10-17T09:00:00Z', verdict: 'good', score: 0.98, vacancyCount: 6, sampled: 4, reachableRate: 1, titleMatchRate: 1, contentfulRate: 1, locationSourceRate: 1, distinctRate: 1, detailDistinctRate: 1, jobLikeRate: 1, logoFound: true },
        { at: '2026-10-18T09:00:00Z', verdict: 'good', score: 0.98, vacancyCount: 6, sampled: 4, reachableRate: 1, titleMatchRate: 1, contentfulRate: 1, locationSourceRate: 1, distinctRate: 1, detailDistinctRate: 1, jobLikeRate: 1, logoFound: true },
        { at: '2026-10-19T09:00:00Z', verdict: 'weak', runtimeSnapshotComplete: false },
      ],
    };
    const gate = evaluatePromotion(candidate);
    expect(gate.checks.runs).toBe(false);
    expect(gate.checks.days).toBe(false);

    const store = { candidates: { 'medimeo@aarau': { ...candidate, key: 'medimeo@aarau' } } } as any;
    const next = candidateStatusAfterValidation({ verdict: 'weak', runtimeSnapshotComplete: false });
    expect(next).toBe('validated');
    expect(requeuePromotedCandidate(store, 'medimeo@aarau', {
      reason: 'runtime snapshot incompleto',
      validationHistory: candidate.validationHistory,
    }, null)?.status).toBe('validated');
  });
});

describe('Prospector promotion reconciliation', () => {
  const storeWith = (status = 'promoting') => ({
    candidates: {
      'employer.example': {
        key: 'employer.example', status, promotionPr: '42', promotionBranch: 'prospector/promote-42',
      },
    },
  });

  it('requeues only the exact closed, unmerged promotion PR and retains its audit record', async () => {
    const store = storeWith();
    const result = await reconcileOpenPromotions(store, async () => ({
      number: 42, state: 'CLOSED', mergedAt: null, closedAt: '2026-10-18T18:00:00Z', url: 'https://github.com/acme/site/pull/42',
    }), null);
    expect(result).toEqual({ landed: 0, reopened: 1 });
    expect(store.candidates['employer.example']).toMatchObject({
      status: 'promoted',
      reason: 'PR 42 chiusa senza merge, ricandidato',
      promotionHistory: [{ number: '42', state: 'CLOSED', mergedAt: null }],
    });
    expect(store.candidates['employer.example'].promotionPr).toBeUndefined();
    expect(store.candidates['employer.example'].promotionBranch).toBeUndefined();
  });

  it.each([
    ['open', async () => ({ number: 42, state: 'OPEN', mergedAt: null })],
    ['mismatched PR', async () => ({ number: 41, state: 'CLOSED', mergedAt: null })],
    ['closed but merged', async () => ({ number: 42, state: 'CLOSED', mergedAt: '2026-10-18T18:00:00Z' })],
    ['lookup failure', async () => { throw new Error('unavailable'); }],
  ])('leaves the in-flight record unchanged for %s', async (_label, lookup) => {
    const store = storeWith();
    const before = structuredClone(store.candidates['employer.example']);
    await reconcileOpenPromotions(store, lookup as any, null);
    expect(store.candidates['employer.example']).toEqual(before);
  });

  it('marks an exact merged PR as production', async () => {
    const store = storeWith();
    const result = await reconcileOpenPromotions(store, async () => ({
      number: 42, state: 'MERGED', mergedAt: '2026-10-18T18:00:00Z',
    }), null);
    expect(result).toEqual({ landed: 1, reopened: 0 });
    expect(store.candidates['employer.example'].status).toBe('production');
  });

  it('records the closed-PR transition in normal mode and omits the ledger in dry-run mode', async () => {
    const normalDirectory = mkdtempSync(path.join(tmpdir(), 'prospector-ledger-normal-'));
    const dryRunDirectory = mkdtempSync(path.join(tmpdir(), 'prospector-ledger-dry-run-'));
    const normalLedger = path.join(normalDirectory, 'ledger.jsonl');
    const dryRunLedger = path.join(dryRunDirectory, 'ledger.jsonl');
    try {
      const normalStore = storeWith();
      await reconcileOpenPromotions(normalStore, async () => ({
        number: 42, state: 'CLOSED', mergedAt: null, closedAt: '2026-10-18T18:00:00Z',
      }), normalLedger);
      expect(readFileSync(normalLedger, 'utf8')).toContain('"from":"promoting","to":"promoted"');

      const dryRunStore = storeWith();
      await reconcileOpenPromotions(dryRunStore, async () => ({
        number: 42, state: 'CLOSED', mergedAt: null, closedAt: '2026-10-18T18:00:00Z',
      }), null);
      expect(dryRunStore.candidates['employer.example'].status).toBe('promoted');
      expect(existsSync(dryRunLedger)).toBe(false);
    } finally {
      rmSync(normalDirectory, { recursive: true, force: true });
      rmSync(dryRunDirectory, { recursive: true, force: true });
    }
  });
});
