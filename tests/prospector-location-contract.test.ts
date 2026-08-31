import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml, fetchGreenhouseJobs, politeFetch } = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  fetchGreenhouseJobs: vi.fn(),
  politeFetch: vi.fn(),
}));

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchHtml,
}));
vi.mock('../scripts/lib/ats-clients/greenhouse-client.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/ats-clients/greenhouse-client.mjs')>()),
  extractGreenhouseBoardToken: () => 'proton',
  fetchGreenhouseJobs,
}));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { fetchAllAccorJobs } from '../scripts/lib/accor-job-parser.mjs';
import { fetchAllMabetexJobs } from '../scripts/lib/mabetex-job-parser.mjs';
import { fetchAllProtonJobs } from '../scripts/lib/proton-job-parser.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import { gradeVacancy } from '../scripts/lib/prospector/validate.mjs';

const SEED_URL = 'https://careers.accor.com/fr/fr/';
const JOB_URL = 'https://careers.accor.com/fr/fr/job/sales-executive';
const LISTING_HTML = '<a href="/fr/fr/job/sales-executive">Sales Executive</a>';
const DESCRIPTION = '<article class="vacancy-description"><p>Lead commercial development, manage client relationships and coordinate the local sales team for the hotel.</p></article>';

describe('prospector location and identity contract', () => {
  beforeEach(() => {
    fetchHtml.mockReset();
    fetchGreenhouseJobs.mockReset();
    politeFetch.mockReset();
  });

  it('keeps stable URL identity and slug while using source-backed geography', async () => {
    fetchHtml.mockImplementation(async (url: string) => url === SEED_URL
      ? LISTING_HTML
      : `<h1>Sales Executive</h1><div class="job-location">Chiasso</div>${DESCRIPTION}`);

    const [job] = await fetchAllAccorJobs();

    expect(job.id).toBe(`accor-${createHash('sha1').update(JOB_URL).digest('hex').slice(0, 12)}`);
    expect(job.slug).toBe('sales-executive-accor-ch');
    expect(job).toMatchObject({ url: JOB_URL, location: 'Chiasso', canton: 'TI' });
  });

  it('drops unverifiable geography with an explicit inventory signal', async () => {
    fetchHtml.mockImplementation(async (url: string) => url === SEED_URL
      ? LISTING_HTML
      : `<h1>Sales Executive</h1>${DESCRIPTION}`);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchAllAccorJobs()).resolves.toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('scartati 1/1 annunci'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('source-backed'));
    warning.mockRestore();
  });

  it('preserves listing order when concurrent detail fetches finish out of order', async () => {
    let releaseFirst = () => {};
    const firstDetailMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const listing = [
      '<a href="/fr/fr/job/first-role">First Role</a>',
      '<a href="/fr/fr/job/second-role">Second Role</a>',
    ].join('');
    fetchHtml.mockImplementation(async (url: string) => {
      if (url === SEED_URL) return listing;
      if (url.endsWith('/first-role')) {
        await firstDetailMayFinish;
        return `<h1>First Role</h1><div class="job-location">Chiasso</div>${DESCRIPTION}`;
      }
      releaseFirst();
      return `<h1>Second Role</h1><div class="job-location">Winterthur</div>${DESCRIPTION}`;
    });

    const jobs = await fetchAllAccorJobs();

    expect(jobs.map((job) => job.title)).toEqual(['First Role', 'Second Role']);
  });

  it('drops authoritative foreign JSON-LD even when the locality has a Swiss homonym', async () => {
    fetchHtml.mockImplementation(async (url: string) => url === SEED_URL
      ? LISTING_HTML
      : `<script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'Sales Executive',
          description: DESCRIPTION,
          jobLocation: { address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' } },
        })}</script><div class="job-location">Geneva</div>${DESCRIPTION}`);

    await expect(fetchAllAccorJobs()).resolves.toEqual([]);
  });

  it('selects a Swiss JSON-LD location after an earlier foreign location', async () => {
    fetchHtml.mockImplementation(async (url: string) => url === SEED_URL
      ? LISTING_HTML
      : `<script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'Sales Executive',
          description: DESCRIPTION,
          jobLocation: [
            { address: { addressLocality: 'Paris', addressCountry: 'FR' } },
            { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
          ],
        })}</script>${DESCRIPTION}`);

    const [job] = await fetchAllAccorJobs();
    expect(job).toMatchObject({ location: 'Zürich, ZH', canton: 'ZH' });
  });

  it('keeps a valid listing location when detail geography is unresolved', async () => {
    const spec = {
      companyKey: 'example',
      companyName: 'Example',
      mode: 'jsonld',
      detailEnrichment: true,
      detailTemplate: '/fr/fr/job/*',
      seedUrls: [SEED_URL],
    };
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Sales Executive',
      url: JOB_URL,
      description: 'Listing description',
      jobLocation: { address: { addressLocality: 'Chiasso', addressCountry: 'CH' } },
    })}</script>`;
    fetchHtml.mockImplementation(async (url: string) => url === SEED_URL
      ? listing
      : `<h1>Sales Executive</h1><div class="job-location">Remote</div>${DESCRIPTION}`);

    const [row] = await runSpecInProduction(spec as any);
    expect(row).toMatchObject({ location: 'Chiasso', canton: 'TI' });
  });

  it('rejects a path-compatible structured URL on a host outside the spec allowlist', async () => {
    const spec = {
      companyKey: 'example',
      companyName: 'Example',
      mode: 'jsonld',
      detailEnrichment: false,
      seedUrls: [SEED_URL],
    };
    fetchHtml.mockResolvedValue(`<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Sales Executive',
      url: 'https://evil.example/fr/fr/job/sales-executive',
      description: DESCRIPTION,
      jobLocation: { address: { addressLocality: 'Geneva', addressCountry: 'CH' } },
    })}</script>`);

    await expect(runSpecInProduction(spec as any, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toEqual([]);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it('marks Geneva NY US as non-source-backed in validation', async () => {
    const body = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Sales Executive',
      jobLocation: { address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' } },
    })}</script><h1>Sales Executive</h1><div class="job-location">Geneva</div><main>${'real vacancy responsibilities benefits '.repeat(40)}</main>`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body });

    const grade = await gradeVacancy({ title: 'Sales Executive', url: JOB_URL, location: 'Geneva' });
    expect(grade.sourceBackedLocation).toBe(false);
  });

  it('drops Proton rows when Greenhouse does not provide verifiable geography', async () => {
    fetchGreenhouseJobs.mockResolvedValue([
      {
        title: 'Security Engineer',
        location: '',
        applyUrl: 'https://job-boards.eu.greenhouse.io/proton/jobs/1',
        descriptionHtml: DESCRIPTION,
      },
      {
        title: 'Product Manager',
        location: 'Paris',
        applyUrl: 'https://job-boards.eu.greenhouse.io/proton/jobs/2',
        descriptionHtml: DESCRIPTION,
      },
    ]);

    await expect(fetchAllProtonJobs()).resolves.toEqual([]);
  });

  it('keeps Proton geography returned by Greenhouse without changing identity', async () => {
    const applyUrl = 'https://job-boards.eu.greenhouse.io/proton/jobs/3';
    fetchGreenhouseJobs.mockResolvedValue([
      {
        title: 'Security Engineer',
        location: 'Genève',
        applyUrl,
        descriptionHtml: DESCRIPTION,
      },
    ]);

    const [job] = await fetchAllProtonJobs();

    expect(job).toMatchObject({ location: 'Genève', canton: 'GE', url: applyUrl });
    expect(job.id).toBe(`proton-${createHash('sha1').update(applyUrl).digest('hex').slice(0, 12)}`);
  });

  it('drops Mabetex rows instead of substituting its Lugano headquarters', async () => {
    fetchHtml.mockResolvedValue(
      `<div class="et_pb_text_inner">Job offers ${'role '.repeat(50)}` +
      '<strong>PROJECT MANAGER</strong><p>Manage international projects and delivery.</p></div>',
    );

    await expect(fetchAllMabetexJobs()).resolves.toEqual([]);
  });

  it('uses the place of work published by Mabetex', async () => {
    fetchHtml.mockResolvedValue(
      `<div class="et_pb_text_inner">Job offers ${'role '.repeat(50)}` +
      '<strong>PROJECT MANAGER</strong><p>Place of work: Chiasso\n</p>' +
      '<p>Manage international projects and delivery.</p></div>',
    );

    const [job] = await fetchAllMabetexJobs();

    expect(job).toMatchObject({
      location: 'Chiasso',
      canton: 'TI',
      addressLocality: 'Chiasso',
      addressRegion: 'TI',
    });
    expect(job.id).toMatch(/^mabetex-/);
  });
});
