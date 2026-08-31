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
import {
  fetchAllMabetexJobs,
  isHistoricalMabetexVacancy,
} from '../scripts/lib/mabetex-job-parser.mjs';
import { fetchAllProtonJobs } from '../scripts/lib/proton-job-parser.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import { runSpec, synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';
import { gradeExtraction, gradeVacancy } from '../scripts/lib/prospector/validate.mjs';
import { dedupeByIdentityPreservingMarks } from '../scripts/lib/job-mark-persistence.mjs';
import { assembleUrlKey } from '../scripts/lib/job-url-key.mjs';

const SEED_URL = 'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1';
const SECOND_SEED_URL = 'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=2';
const JOB_URL = 'https://careers.accor.com/fr/fr/job/sales-executive';
const LISTING_HTML = '<a href="/fr/fr/job/sales-executive">Sales Executive</a>';
const DESCRIPTION = '<div class="vacancy-description" data-type="DescriptionWidget"><div aria-label="Job description"><p>Lead commercial development, manage client relationships and coordinate the local sales team for the hotel.</p></div></div>';
const isAccorSeed = (url: string) => url === SEED_URL || url === SECOND_SEED_URL;

describe('prospector location and identity contract', () => {
  beforeEach(() => {
    fetchHtml.mockReset();
    fetchGreenhouseJobs.mockReset();
    politeFetch.mockReset();
    politeFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      body: await fetchHtml(url),
      url,
      host: new URL(url).hostname,
    }));
  });

  it('keeps stable URL identity and slug while using source-backed geography', async () => {
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? LISTING_HTML
      : `<h1>Sales Executive</h1><div class="job-location">Chiasso</div>${DESCRIPTION}`);

    const [job] = await fetchAllAccorJobs();

    expect(job.id).toBe(`accor-${createHash('sha1').update(JOB_URL).digest('hex').slice(0, 12)}`);
    expect(job.slug).toBe('sales-executive-accor-ch');
    expect(job).toMatchObject({ url: JOB_URL, location: 'Chiasso', canton: 'TI' });
    for (const seed of [SEED_URL, SECOND_SEED_URL]) {
      expect(politeFetch).toHaveBeenCalledWith(seed, expect.objectContaining({
        headers: {
          'Accept-Encoding': 'identity',
        },
      }));
    }
  });

  it('propagates the selected structured address through runtime and generated parser', async () => {
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? LISTING_HTML
      : `<script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'Sales Executive',
          description: DESCRIPTION,
          jobLocation: { address: {
            addressLocality: 'Pratteln', addressRegion: 'BL', addressCountry: 'CH',
            postalCode: '4133', streetAddress: 'Grüssenweg 1',
          } },
        })}</script>${DESCRIPTION}`);

    const [job] = await fetchAllAccorJobs();
    expect(job).toMatchObject({
      location: 'Pratteln, BL',
      canton: 'BL',
      addressLocality: 'Pratteln',
      addressRegion: 'BL',
      addressCountry: 'CH',
      postalCode: '4133',
      streetAddress: 'Grüssenweg 1',
    });
  });

  it('drops unverifiable geography with an explicit inventory signal', async () => {
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
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
      if (isAccorSeed(url)) return listing;
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
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
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
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
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
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? listing
      : `<h1>Sales Executive</h1><div class="job-location">Remote</div>${DESCRIPTION}`);

    const [row] = await runSpecInProduction(spec as any);
    expect(row).toMatchObject({ location: 'Chiasso', canton: 'TI' });
  });

  it('runs the detail enrichment that synthesis required for a location-free structured listing', async () => {
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Sales Executive',
      url: JOB_URL,
      description: 'Listing description',
    })}</script>`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body: listing, url: SEED_URL });
    const { spec } = await synthesizeSpec({
      careersUrl: SEED_URL,
      domain: 'example.com',
      name: 'Example',
    });
    expect(spec).toMatchObject({ mode: 'jsonld', detailEnrichment: true });

    politeFetch.mockImplementation(async (url: string) => ({
      ok: true, status: 200, body: await fetchHtml(url), url, host: new URL(url).hostname,
    }));
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? listing
      : `<h1>Sales Executive</h1><div class="job-location">Chiasso</div>${DESCRIPTION}`);
    const rows = await runSpecInProduction(spec as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ location: 'Chiasso', canton: 'TI' });
    expect(fetchHtml).toHaveBeenCalledWith(JOB_URL);
  });

  it('enriches a structured listing whose description is missing or insufficient', async () => {
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Sales Executive',
      url: JOB_URL,
      description: 'Short teaser',
      jobLocation: { address: { addressLocality: 'Chiasso', addressCountry: 'CH' } },
    })}</script>`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body: listing, url: SEED_URL });
    const { spec } = await synthesizeSpec({
      careersUrl: SEED_URL,
      domain: 'example.com',
      name: 'Example',
    });
    expect(spec).toMatchObject({ mode: 'jsonld', detailEnrichment: true });

    politeFetch.mockImplementation(async (url: string) => ({
      ok: true, status: 200, body: await fetchHtml(url), url, host: new URL(url).hostname,
    }));
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? listing
      : `<h1>Sales Executive</h1><div class="job-location">Chiasso</div>${DESCRIPTION}`);
    const rows = await runSpecInProduction(spec as any);
    expect(rows).toEqual([expect.objectContaining({
      location: 'Chiasso', canton: 'TI',
      description: expect.stringContaining('Lead commercial development'),
    })]);
    expect(fetchHtml).toHaveBeenCalledWith(JOB_URL);
  });

  it('does not fabricate an Accor description when detail remains empty', async () => {
    fetchHtml.mockImplementation(async (url: string) => isAccorSeed(url)
      ? LISTING_HTML
      : '<h1>Sales Executive</h1><div class="job-location">Chiasso</div>');
    await expect(fetchAllAccorJobs()).resolves.toEqual([]);
  });

  it('rejects an autonomously discovered cross-origin detail before gate/runtime can diverge', async () => {
    const seed = 'https://employer.example/jobs';
    const crossOriginJob = 'https://ats.example/vacancies/1';
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Platform Engineer',
      url: crossOriginJob,
      description: DESCRIPTION,
      jobLocation: { address: { addressLocality: 'Zürich', addressCountry: 'CH' } },
    })}</script>`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body: listing, url: seed });

    const synthesis = await synthesizeSpec({ careersUrl: seed, domain: 'employer.example', name: 'Employer' });
    expect(synthesis).toMatchObject({ spec: null, vacancies: [] });
    expect(synthesis.reason).toMatch(/origine dettaglio non autorizzata/);

    const spec = {
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'jsonld', seedUrls: [seed], sourceLang: 'de',
    } as any;
    const run = await runSpec(spec, { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
    expect(run.vacancies).toEqual([]);
    expect(run.errors).toEqual([`${crossOriginJob}: origine dettaglio non autorizzata`]);

    politeFetch.mockClear();
    const report = await gradeExtraction(spec, [{ title: 'Platform Engineer', url: crossOriginJob }], {
      sampleSize: 1,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(report.reachableRate).toBe(0);
    expect(politeFetch).not.toHaveBeenCalled();
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

  it('does not count navigation chrome as a publishable vacancy description', async () => {
    const body = '<h1>Sales Executive</h1><div class="job-location">Chiasso</div>' +
      `<nav>${'navigation contact privacy locations benefits careers '.repeat(30)}</nav>`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body, url: JOB_URL });

    const grade = await gradeVacancy({ title: 'Sales Executive', url: JOB_URL, location: 'Chiasso' });
    expect(grade.words).toBeGreaterThan(120);
    expect(grade.sourceBackedLocation).toBe(true);
    expect(grade.contentful).toBe(false);
  });

  it('grades the exact runtime description fallback', async () => {
    const body = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'Sales Executive', description: 'Short teaser',
      jobLocation: { address: { addressLocality: 'Chiasso', addressRegion: 'TI', addressCountry: 'CH' } },
    })}</script><h1>Sales Executive</h1>${'<!-- shell -->'.repeat(20)}`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body, url: JOB_URL });

    const publishableListing = 'Lead commercial development, manage client relationships and coordinate the local sales team while delivering measurable results for hotel guests and colleagues.';
    await expect(gradeVacancy({
      title: 'Sales Executive', url: JOB_URL, location: 'Chiasso', description: publishableListing,
    })).resolves.toMatchObject({ contentful: true });
    await expect(gradeVacancy({
      title: 'Sales Executive', url: JOB_URL, location: 'Chiasso', description: 'Short listing teaser',
    })).resolves.toMatchObject({ contentful: false });
  });

  it('uses the effective redirect URL as structured detail identity', async () => {
    const effectiveUrl = 'https://effective.example/job/current';
    const body = `<h1>Rendered Recommended Role</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'Canonical Current Role', url: '/job/current', description: DESCRIPTION,
        jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      },
      {
        '@type': 'JobPosting', title: 'Rendered Recommended Role', description: DESCRIPTION,
        jobLocation: { address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' } },
      },
    ])}</script>${'<!-- shell -->'.repeat(20)}`;
    politeFetch.mockResolvedValue({ ok: true, status: 200, body, url: effectiveUrl });

    await expect(gradeVacancy({
      title: 'Canonical Current Role', url: JOB_URL, location: 'Zürich', description: DESCRIPTION,
    })).resolves.toMatchObject({ sourceBackedLocation: true, contentful: true });
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
      `<p>${'Manage international projects, coordinate delivery teams, budgets and client requirements. '.repeat(3)}</p></div>`,
    );

    const [job] = await fetchAllMabetexJobs();

    expect(job).toMatchObject({
      location: 'Chiasso',
      canton: 'TI',
      addressLocality: 'Chiasso',
      addressRegion: 'TI',
      slug: 'project-manager-chiasso-mabetex',
    });
    expect(job.previousSlugs).toBeUndefined();
    expect(job.url).toMatch(/^https:\/\/www\.mabetex\.com\/career\/#vacancy-project-manager-chiasso-[a-f0-9]{8}$/);
    expect(job.id).toMatch(/^mabetex-/);
  });

  it('assigns legacy Mabetex identity only to the evidenced historical vacancy', () => {
    expect(isHistoricalMabetexVacancy('Project Manager', 'Southwest Africa')).toBe(true);
    expect(isHistoricalMabetexVacancy('Project Manager', 'Chiasso')).toBe(false);
    expect(isHistoricalMabetexVacancy('Design Engineer', 'Southwest Africa')).toBe(false);
  });

  it('segments each Mabetex vacancy into its own location, description and stable slug aliases', async () => {
    fetchHtml.mockResolvedValue(
      `<div class="et_pb_text_inner">Job offers ${'role '.repeat(50)}` +
      '<p><strong>PROJECT MANAGER</strong></p><p>Place of work: Chiasso</p>' +
      `<p>${'Lead construction delivery in Ticino with client and engineering teams. '.repeat(4)}</p>` +
      '<p><strong>DESIGN ENGINEER</strong></p><p>Place of work: Genève</p>' +
      `<p>${'Design technical solutions in Geneva with architects and project stakeholders. '.repeat(4)}</p></div>`,
    );

    const jobs = await fetchAllMabetexJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: 'Project Manager', location: 'Chiasso', canton: 'TI',
      slug: 'project-manager-chiasso-mabetex',
    });
    expect(jobs[1]).toMatchObject({
      title: 'Design Engineer', location: 'Genève', canton: 'GE',
      slug: 'design-engineer-geneve-mabetex',
    });
    expect(jobs.every((job) => job.previousSlugs === undefined)).toBe(true);
    expect(jobs[0].description).not.toContain('Design technical solutions');
    expect(jobs[1].description).not.toContain('Lead construction delivery');
    expect(jobs.map((job) => job.url)).toEqual([
      expect.stringMatching(/^https:\/\/www\.mabetex\.com\/career\/#vacancy-project-manager-chiasso-[a-f0-9]{8}$/),
      expect.stringMatching(/^https:\/\/www\.mabetex\.com\/career\/#vacancy-design-engineer-geneve-[a-f0-9]{8}$/),
    ]);
    const assembled = dedupeByIdentityPreservingMarks(
      jobs.map((job) => ({ job, assembledAt: '2026-08-31T00:00:00Z' })),
      (job: any) => `url:${assembleUrlKey(job.url)}`,
    );
    expect(assembled).toMatchObject({ collapsed: 0 });
    expect(assembled.winners).toHaveLength(2);
  });

  it('keeps Mabetex identities stable across DOM order and separates same-title locations', async () => {
    const page = (locations: string[]) =>
      `<div class="et_pb_text_inner">Job offers ${'role '.repeat(50)}` + locations.map((location) =>
        `<p><strong>PROJECT MANAGER</strong></p><p>Place of work: ${location}</p>` +
        `<p>${`Lead construction delivery in ${location} with client, engineering and finance teams. `.repeat(4)}</p>`
      ).join('') + '</div>';
    fetchHtml.mockResolvedValueOnce(page(['Chiasso', 'Genève']));
    const first = await fetchAllMabetexJobs();
    fetchHtml.mockResolvedValueOnce(page(['Genève', 'Chiasso']));
    const reordered = await fetchAllMabetexJobs();
    const identities = (jobs: any[]) => Object.fromEntries(jobs.map((job) => [job.location, {
      id: job.id, slug: job.slug, url: job.url, previousSlugs: job.previousSlugs,
    }]));
    expect(identities(reordered)).toEqual(identities(first));
    expect(new Set(first.map((job) => job.id)).size).toBe(2);
    expect(new Set(first.map((job) => job.url)).size).toBe(2);
    expect(first.every((job) => job.previousSlugs === undefined)).toBe(true);
  });
});
