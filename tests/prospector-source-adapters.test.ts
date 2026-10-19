import { describe, expect, it } from 'vitest';
import { fetchAllRecruitingapp2649Jobs } from '../scripts/lib/recruitingapp-2649-job-parser.mjs';
import { fetchAllRecruitingapp2677Jobs } from '../scripts/lib/recruitingapp-2677-job-parser.mjs';
import {
  productionRuntimeOptionsFor,
  SOURCE_CRAWLER_ADAPTERS,
  sourceCrawlerAdapterFor,
  sourceAdapterRuntimeObservationFor,
} from '../scripts/lib/prospector/source-adapters.mjs';
import { gradeExtraction } from '../scripts/lib/prospector/validate.mjs';

describe('prospector source-crawler adapters', () => {
  it('routes each source adapter through its production parser and detail extractor', () => {
    expect(Object.keys(SOURCE_CRAWLER_ADAPTERS).sort()).toEqual([
      'agat',
      'le-team',
      'recruitingapp-2649',
      'recruitingapp-2677',
      'rh-expert-ch',
      'seniorenzentrum-engelhof',
    ]);
    for (const companyKey of Object.keys(SOURCE_CRAWLER_ADAPTERS)) {
      const adapter = sourceCrawlerAdapterFor({ companyKey });
      expect(adapter?.version).toMatch(/-dedicated-v1$/);
      expect(adapter?.fetchJobs).toBeTypeOf('function');
      expect(adapter?.detailExtractor).toBeTypeOf('function');
    }
    expect(sourceCrawlerAdapterFor({ companyKey: 'recruitingapp-2649' })?.fetchJobs)
      .toBe(fetchAllRecruitingapp2649Jobs);
    expect(sourceCrawlerAdapterFor({ companyKey: 'recruitingapp-2677' })?.fetchJobs)
      .toBe(fetchAllRecruitingapp2677Jobs);
  });

  it('keeps rejected-candidate revalidation opt-in to RH-Expert only', () => {
    expect(sourceCrawlerAdapterFor({ companyKey: 'rh-expert-ch' })?.allowRejectedRevalidation).toBe(true);
    expect(sourceCrawlerAdapterFor({ companyKey: 'le-team' })?.allowRejectedRevalidation).toBeUndefined();
    expect(sourceCrawlerAdapterFor({ companyKey: 'agat' })?.allowRejectedRevalidation).toBeUndefined();
    expect(sourceCrawlerAdapterFor({ companyKey: 'seniorenzentrum-engelhof' })?.allowRejectedRevalidation).toBe(true);
    expect(sourceCrawlerAdapterFor({ companyKey: 'unrelated' })).toBeNull();
  });

  it('reuses source-specific extraction and expected-filter policies during spec observation', () => {
    for (const companyKey of [
      'gmo', 'medimeo', 'medimeo-ch', 'proman-fleurier',
    ]) {
      expect(productionRuntimeOptionsFor({ companyKey })?.isExpectedDetailFilter)
        .toBeTypeOf('function');
    }
    expect(productionRuntimeOptionsFor({ companyKey: 'proman-fleurier' }))
      .toMatchObject({ listingExtractor: expect.any(Function), detailExtractor: expect.any(Function) });
    expect(productionRuntimeOptionsFor({ companyKey: 'recruitingapp-2649' })).toBeNull();
    expect(productionRuntimeOptionsFor({ companyKey: 'recruitingapp-2677' })).toBeNull();
    expect(productionRuntimeOptionsFor({ companyKey: 'unrelated' })).toBeNull();
  });

  it('fails closed on typed adapter failures and incomplete authoritative snapshots', () => {
    const blocked: any[] = [];
    Object.defineProperties(blocked, {
      fetchOutcome: { value: 'anti_bot_block', enumerable: false },
      discoveredCount: { value: 10, enumerable: false },
      detailDrop: { value: { candidates: 10, gone: 0, rejected: 10, dropped: 10 }, enumerable: false },
    });
    expect(sourceAdapterRuntimeObservationFor(blocked)).toMatchObject({
      algorithmVersion: 'source-adapter-output-v2',
      fetchOutcome: 'anti_bot_block',
      listingCount: 10,
      runtimeOutputCount: 0,
      snapshotAccepted: false,
      complete: false,
      dropCounts: { fetch_outcome_anti_bot_block: 1, detail_runtime_rejected: 10 },
    });

    const partial: any[] = [{ url: 'https://example.test/job/1', title: 'Engineer' }];
    Object.defineProperties(partial, {
      discoveredCount: { value: 3, enumerable: false },
      authoritativeSnapshotProof: {
        value: {
          discoveredCount: 3,
          attemptedDetailCount: 2,
          detailCount: 2,
          publishedCount: 1,
          complete: false,
          details: [{ id: '1' }, { id: '2' }],
        },
        enumerable: false,
      },
    });
    expect(sourceAdapterRuntimeObservationFor(partial)).toMatchObject({
      listingCount: 3,
      publishableCount: 1,
      runtimeOutputCount: 0,
      snapshotAccepted: false,
      exactListingCount: false,
      complete: false,
      dropCounts: { authoritative_snapshot_proof_incomplete: 1 },
    });

    const unverifiedEmpty: any[] = [];
    expect(sourceAdapterRuntimeObservationFor(unverifiedEmpty)).toMatchObject({
      listingCount: null,
      exactListingCount: false,
      complete: false,
      promotionObservationComplete: false,
      dropCounts: { source_adapter_listing_count_unverified: 1 },
    });

    const zeroWithoutProof: any[] = [];
    Object.defineProperty(zeroWithoutProof, 'discoveredCount', { value: 0, enumerable: false });
    expect(sourceAdapterRuntimeObservationFor(zeroWithoutProof)).toMatchObject({
      listingCount: 0,
      exactListingCount: true,
      snapshotAccepted: false,
      complete: false,
      promotionObservationComplete: false,
      dropCounts: { source_adapter_zero_listing_unverified: 1 },
      failure: 'zero-row adapter listing lacks an accepted fetch outcome or authoritative proof',
    });

    for (const fetchOutcome of ['ok', 'filtered_empty']) {
      const acceptedEmpty: any[] = [];
      Object.defineProperties(acceptedEmpty, {
        fetchOutcome: { value: fetchOutcome, enumerable: false },
        discoveredCount: { value: 0, enumerable: false },
      });
      expect(sourceAdapterRuntimeObservationFor(acceptedEmpty)).toMatchObject({
        fetchOutcome,
        listingCount: 0,
        snapshotAccepted: true,
        complete: true,
        promotionObservationComplete: true,
      });
    }

    const provenEmpty: any[] = [];
    Object.defineProperty(provenEmpty, 'authoritativeSnapshotProof', {
      value: {
        discoveredCount: 0,
        attemptedDetailCount: 0,
        detailCount: 0,
        publishedCount: 0,
        complete: true,
        details: [],
      },
      enumerable: false,
    });
    expect(sourceAdapterRuntimeObservationFor(provenEmpty)).toMatchObject({
      listingCount: 0,
      exactListingCount: true,
      snapshotAccepted: true,
      complete: true,
      promotionObservationComplete: true,
    });
  });

  it.each([
    ['number', 0, 'source_adapter_malformed_fetch_outcome'],
    ['boolean', false, 'source_adapter_malformed_fetch_outcome'],
    ['undefined', undefined, 'source_adapter_malformed_fetch_outcome'],
    ['object', { status: 'ok' }, 'source_adapter_malformed_fetch_outcome'],
    ['unknown string', 'not-a-real-outcome', 'source_adapter_unknown_fetch_outcome'],
    ['empty string', '', 'source_adapter_unknown_fetch_outcome'],
  ])('fails closed when an adapter declares a malformed or unknown %s outcome', (_label, rawOutcome, dropCode) => {
    const rows: any[] = [{ url: 'https://example.test/job/1', title: 'Engineer' }];
    Object.defineProperties(rows, {
      fetchOutcome: { value: rawOutcome, enumerable: false },
      discoveredCount: { value: 1, enumerable: false },
      detailDrop: {
        value: { candidates: 1, gone: 0, rejected: 0, dropped: 0 },
        enumerable: false,
      },
    });

    const observation = sourceAdapterRuntimeObservationFor(rows);
    expect(observation).toMatchObject({
      fetchOutcomePresent: true,
      complete: false,
      snapshotAccepted: false,
      dropCounts: { [dropCode]: 1 },
    });
    if (typeof rawOutcome !== 'string' && rawOutcome !== null) {
      expect(observation).toMatchObject({ malformedFetchOutcome: true });
    }
    if (typeof rawOutcome === 'number' || typeof rawOutcome === 'boolean') {
      expect(observation.fetchOutcomeValue).toBe(rawOutcome);
    }
  });

  it('preserves null as an absent fetch-outcome sentinel', () => {
    const rows: any[] = [{ url: 'https://example.test/job/1', title: 'Engineer' }];
    Object.defineProperties(rows, {
      fetchOutcome: { value: null, enumerable: false },
      discoveredCount: { value: 1, enumerable: false },
      detailDrop: {
        value: { candidates: 1, gone: 0, rejected: 0, dropped: 0 },
        enumerable: false,
      },
    });

    expect(sourceAdapterRuntimeObservationFor(rows)).toMatchObject({
      fetchOutcomePresent: true,
      fetchOutcomeType: 'null',
      fetchOutcomeValue: null,
      malformedFetchOutcome: false,
      complete: true,
      snapshotAccepted: true,
    });
  });

  it('does not accept an authoritative-empty marker on non-empty adapter output', () => {
    const rows: any[] = [{ url: 'https://example.test/job/1', title: 'Engineer' }];
    Object.defineProperty(rows, 'authoritativeEmptyState', {
      value: 'authoritative-source-zero',
      enumerable: false,
    });

    expect(sourceAdapterRuntimeObservationFor(rows)).toMatchObject({
      complete: false,
      promotionObservationComplete: false,
      failure: 'exact listing count is missing',
    });
  });

  it('does not accept an authoritative-empty marker that contradicts a nonzero count', () => {
    const rows: any[] = [];
    Object.defineProperties(rows, {
      authoritativeEmptyState: { value: 'authoritative-source-zero', enumerable: false },
      discoveredCount: { value: 1, enumerable: false },
    });

    expect(sourceAdapterRuntimeObservationFor(rows)).toMatchObject({
      complete: false,
      promotionObservationComplete: false,
      dropCounts: { source_adapter_row_accounting_mismatch: 1 },
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['fractional', 0.5],
    ['string', '0'],
    ['undefined', undefined],
  ])('rejects an authoritative-empty marker with a malformed discovered count (%s)', (_label, count) => {
    const rows: any[] = [];
    Object.defineProperties(rows, {
      authoritativeEmptyState: { value: 'authoritative-source-zero', enumerable: false },
      discoveredCount: { value: count, enumerable: false },
    });

    expect(sourceAdapterRuntimeObservationFor(rows)).toMatchObject({
      snapshotAccepted: false,
      complete: false,
      promotionObservationComplete: false,
      dropCounts: { source_adapter_malformed_listing_count: 1 },
      failure: 'discoveredCount metadata is malformed',
    });
  });

  it('grades adapter detail pages from the parser observation without a second fetch', async () => {
    const url = 'https://employer.example/jobs/1';
    const vacancy = {
      url,
      title: 'Platform Engineer',
      description: 'The successful candidate will plan services, work with the team, document procedures, and support continuous improvement. '.repeat(4),
      location: 'Zürich',
      addressCountry: 'CH',
    };
    const rows: any[] = [vacancy];
    const body = `<html><head><title>Platform Engineer</title></head><body><h1>Platform Engineer</h1><main>${vacancy.description}</main></body></html>`;
    Object.defineProperties(rows, {
      discoveredCount: { value: 1, enumerable: false },
      detailDrop: { value: { candidates: 1, gone: 0, rejected: 0, dropped: 0 }, enumerable: false },
      observedDetailsByUrl: {
        value: new Map([[url, { body, status: 200, url }]]),
        enumerable: false,
      },
      titleEvidenceByUrl: {
        value: new Map([[url, { listingTitle: 'Platform Engineer', finalTitle: 'Platform Engineer' }]]),
        enumerable: false,
      },
    });
    expect(sourceAdapterRuntimeObservationFor(rows, { requireObservedDetails: true })).toMatchObject({
      complete: true,
      observedDetailCount: 1,
      missingObservedDetailCount: 0,
    });

    let secondFetches = 0;
    const report = await gradeExtraction({ companyKey: 'employer' }, rows, {
      sampleSize: 1,
      requireObservedDetails: true,
      observedDetailsByUrl: rows.observedDetailsByUrl,
      titleEvidenceByUrl: rows.titleEvidenceByUrl,
      fetchImpl: async () => {
        secondFetches++;
        return new Response(body);
      },
    });
    expect(secondFetches).toBe(0);
    expect(report.sampled).toBe(1);
    expect(report.samples[0]).toMatchObject({ reachable: true, titleMatch: 1 });
  });

  it('marks adapter output incomplete when its parser did not retain fetched detail evidence', () => {
    const rows: any[] = [{ url: 'https://example.test/job/1', title: 'Engineer' }];
    Object.defineProperties(rows, {
      discoveredCount: { value: 1, enumerable: false },
      detailDrop: { value: { candidates: 1, gone: 0, rejected: 0, dropped: 0 }, enumerable: false },
    });
    expect(sourceAdapterRuntimeObservationFor(rows, { requireObservedDetails: true })).toMatchObject({
      complete: false,
      missingObservedDetailCount: 1,
      dropCounts: { source_adapter_detail_observation_missing: 1 },
    });
  });

  it('keeps the recruitingapp all-ID proof and reviewed foreign filters distinct', () => {
    const filtered: any[] = [];
    const proof = {
      discoveredCount: 2,
      attemptedDetailCount: 2,
      detailCount: 2,
      publishedCount: 0,
      complete: true,
      details: [
        { id: '1', title: 'Role 1', rich: true, swiss: false, locations: ['Berlin'] },
        { id: '2', title: 'Role 2', rich: true, swiss: false, locations: ['Bonn'] },
      ],
    };
    Object.defineProperties(filtered, {
      discoveredCount: { value: 2, enumerable: false },
      authoritativeSnapshotProof: { value: proof, enumerable: false },
      detailDrop: { value: { candidates: 0, gone: 0, rejected: 0, dropped: 0 }, enumerable: false },
    });
    expect(sourceAdapterRuntimeObservationFor(filtered, {
      companyKey: 'recruitingapp-2649',
      adapter: sourceCrawlerAdapterFor({ companyKey: 'recruitingapp-2649' }),
    })).toMatchObject({
      listingCount: 2,
      runtimeOutputCount: 0,
      expectedFilterCount: 2,
      expectedFilters: { authoritative_foreign_geography: 2 },
      dropCounts: { detail_runtime_gone: 0, detail_runtime_rejected: 0 },
      snapshotAccepted: true,
      complete: true,
    });
  });
});
