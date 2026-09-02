/**
 * Regression: SPA-side dedup must preserve distinct vacancies that share an
 * ATS landing URL whose hash carries the job identifier.
 *
 * Before the fix, `buildListingDedupKey` keyed off the URL with the hash
 * stripped — so all 10 Galenica (Amavita, Coop Vitality, Sun Store, UFD) jobs
 * in Ticino collapsed to a single survivor under the same key
 * `url|https://jobs.galenica.com/it/jobs/`. The 9 losers vanished from the
 * SPA's `jobs` state, `selectedJob` resolved to null, and JobBoard rendered
 * `JobOrphanView` ("Annuncio non più disponibile") despite the static SSG
 * page being correctly emitted and the data being present in the slim index.
 *
 * The fix prefers `job.id` (stable crawler-assigned identifier) as the dedup
 * key — aligning with the build-side heuristic in
 * `build-plugins/jobsSeoPagesPlugin.ts:dedupKey`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildListingDedupKey,
  dedupeJobsForListing,
} from '@/components/community/JobBoard.tsx';
import type { JobListing } from '@/components/community/JobBoard.tsx';

function makeJob(overrides: Partial<JobListing>): JobListing {
  return {
    id: 'test-id',
    title: 'Test Job',
    company: 'Test Company',
    location: 'Lugano',
    slug: 'test-job-test-company-lugano',
    postedDate: '2026-01-01',
    crawledAt: '2026-01-01',
    source: 'test',
    url: 'https://example.com',
    ...overrides,
  } as unknown as JobListing;
}

describe('buildListingDedupKey', () => {
  it('keys distinct ids to distinct keys even when stripped URL matches', () => {
    const a = makeJob({
      id: 'galenica-38be919a0774',
      url: 'https://jobs.galenica.com/it/jobs/#job.id=12692350',
      slug: 'galenica-coop-vitality-assistente-di-farmacia-afc-tenero',
    });
    const b = makeJob({
      id: 'galenica-f332769aca10',
      url: 'https://jobs.galenica.com/it/jobs/#job.id=12692138',
      slug: 'galenica-unione-farmaceutica-distribuzione-sa-impiegato-a-in-logistica-afc-lugano',
    });
    expect(buildListingDedupKey(a)).not.toBe(buildListingDedupKey(b));
    expect(buildListingDedupKey(a)).toBe('id|galenica-38be919a0774');
  });

  it('falls back to URL when id is missing', () => {
    const job = makeJob({
      id: '',
      url: 'https://example.com/job/42',
    });
    expect(buildListingDedupKey(job)).toBe('url|https://example.com/job/42');
  });

  it('treats numeric zero as a real id instead of falling back', () => {
    const job = makeJob({ id: 0 as unknown as string, url: 'https://example.com/job/42' });
    expect(buildListingDedupKey(job)).toBe('id|0');
  });

  it('falls back to meta key when both id and url are missing', () => {
    const job = makeJob({ id: '', url: '' });
    const key = buildListingDedupKey(job);
    expect(key.startsWith('meta|')).toBe(true);
  });
});

describe('dedupeJobsForListing — Galenica ATS-hash regression', () => {
  it('keeps all 10 Galenica TI vacancies that share an ATS landing URL', () => {
    const galenicaJobs: JobListing[] = [
      ['galenica-38be919a0774', 'galenica-coop-vitality-assistente-di-farmacia-afc-tenero', 'Coop Vitality (Galenica)', 'Tenero', '12692350'],
      ['galenica-f332769aca10', 'galenica-unione-farmaceutica-distribuzione-sa-impiegato-a-in-logistica-afc-lugano', 'Unione Farmaceutica Distribuzione SA (Galenica)', 'Lugano', '12692138'],
      ['galenica-aaaaaa000001', 'galenica-amavita-assistente-di-farmacia-afc-balerna', 'Amavita (Galenica)', 'Balerna', '12692001'],
      ['galenica-aaaaaa000002', 'galenica-amavita-assistente-di-farmacia-afc-mendrisio', 'Amavita (Galenica)', 'Mendrisio', '12692002'],
      ['galenica-aaaaaa000003', 'galenica-amavita-assistente-di-farmacia-afc-ascona', 'Amavita (Galenica)', 'Ascona', '12692003'],
      ['galenica-aaaaaa000004', 'galenica-amavita-assistente-di-farmacia-afc-lugano', 'Amavita (Galenica)', 'Lugano', '12692004'],
      ['galenica-bbbbbb000005', 'galenica-coop-vitality-assistente-di-farmacia-afc-mendrisio', 'Coop Vitality (Galenica)', 'Mendrisio', '12692005'],
      ['galenica-bbbbbb000006', 'galenica-coop-vitality-assistente-di-farmacia-afc-canobbio', 'Coop Vitality (Galenica)', 'Canobbio', '12692006'],
      ['galenica-cccccc000007', 'galenica-sun-store-apotheke-assistente-di-farmacia-afc-lugano', 'Sun Store (Galenica)', 'Lugano', '12692007'],
      ['galenica-cccccc000008', 'galenica-sun-store-apotheke-assistente-di-farmacia-afc-locarno', 'Sun Store (Galenica)', 'Locarno', '12692008'],
    ].map(([id, slug, company, location, jobId]) =>
      makeJob({
        id,
        slug,
        company,
        location,
        canton: 'TI',
        url: `https://jobs.galenica.com/it/jobs/#job.id=${jobId}`,
      }),
    );

    const result = dedupeJobsForListing(galenicaJobs);
    expect(result).toHaveLength(galenicaJobs.length);
    const ids = result.map((j) => j.id).sort();
    expect(ids).toEqual(galenicaJobs.map((j) => j.id).sort());
  });

  it('still collapses true duplicates that share the same id', () => {
    const a = makeJob({
      id: 'galenica-38be919a0774',
      url: 'https://jobs.galenica.com/it/jobs/#job.id=12692350',
      description: 'short',
    });
    const b = makeJob({
      id: 'galenica-38be919a0774',
      url: 'https://jobs.galenica.com/it/jobs/#job.id=12692350',
      description:
        'much longer description that should score higher and win the dedup keep step '.repeat(10),
    });
    const result = dedupeJobsForListing([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].description.length).toBeGreaterThan(a.description!.length);
  });
});
