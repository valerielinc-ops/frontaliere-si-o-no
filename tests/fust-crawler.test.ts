import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFustAdapterConfig,
  buildFustPublishPlan,
  deriveFustWorkplaceCanton,
  ensureUniqueFustSlugs,
  extractFustWorkplaceFromHtml,
  fetchFustJobUrls,
  handleFustEmptyDiscovery,
  isCanonicalFustDetailUrl,
  readFustSummarySlice,
  reconcileFustJobsWithDiscovery,
  writeFustPublishPlan,
} from '../scripts/update-fust-jobs.mjs';
import { exitCrawlerOnError } from '../scripts/lib/crawler-template.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';
import { snapshotJobSlugs } from '../scripts/jobs-url-helper.mjs';

type FustFixtureDetail = { url: string; workplace: string; canton: string; html: string };
type FustFixtureJob = {
  id: string;
  title: string;
  attributes: Record<string, string[]>;
  links: { directlink: string };
};
type FustFixture = {
  api: { total: number; jobs: FustFixtureJob[] };
  details: FustFixtureDetail[];
};
type FustFallback = { workplace: string; canton: string };
type SummaryObservation = { total: number; removedJobs: object[] };
type SliceObservation = { key: string; jobs: object[]; options: { skipShrinkGuard: boolean } };
type VerifiedObservation = {
  key: string;
  jobs: object[];
  options: { isTargetJob: (job: object) => boolean };
};

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'fust-detail-pages.json'), 'utf8')
) as FustFixture;

describe('Fust authoritative discovery', () => {
  it('publishes canonical feed URLs only through the explicit detail contract', () => {
    const seedDetailUrls = fixture.details.map((detail) => detail.url);
    const seedMetaByUrl = Object.fromEntries(fixture.details.map((detail) => [
      detail.url,
      { location: detail.workplace, canton: detail.canton },
    ]));
    const adapter = buildFustAdapterConfig(
      { companyKey: 'fust', seedUrls: ['https://jobs.fust.ch/jobs'] },
      seedDetailUrls,
      seedMetaByUrl,
      '2026-09-01T00:00:00.000Z',
    );

    expect(adapter.seedUrls).toBeUndefined();
    expect(adapter.seedDetailUrls).toEqual(seedDetailUrls);
    expect(adapter.seedMetaByUrl).toEqual(seedMetaByUrl);
    expect(adapter.updatedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('parses the representative French detail fixture only through that explicit contract', () => {
    const detail = fixture.details.find((item) => item.url.includes('/postes-vacants/'))!;
    const jsonLd = detail.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(jsonLd).toBeTruthy();
    const node = JSON.parse(String(jsonLd));
    const seedMeta = {
      location: detail.workplace,
      canton: detail.canton,
      company: 'Fust',
    };

    expect(sharedCrawlerTestables.toJobFromJsonLd(node, 'Fust', detail.url, { seedMeta }))
      .toMatchObject({ job: null, reason: 'jsonld_not_detail_url' });
    const parsed = sharedCrawlerTestables.toJobFromJsonLd(node, 'Fust', detail.url, {
      seedMeta,
      isSeedDetail: true,
    });
    expect(parsed).toMatchObject({
      reason: null,
      job: {
        url: detail.url,
        company: 'Fust',
        canton: detail.canton,
      },
    });
    const reconciled = reconcileFustJobsWithDiscovery([parsed.job], {
      urls: [detail.url],
      seedMetaByUrl: { [detail.url]: seedMeta },
    });
    expect(reconciled[0]).toMatchObject({
      url: detail.url,
      company: 'Fust',
      location: detail.workplace,
      addressLocality: detail.workplace,
      canton: detail.canton,
      addressRegion: detail.canton,
    });
  });

  it('accepts only canonical branded detail URLs with UUID identity', () => {
    for (const detail of fixture.details) expect(isCanonicalFustDetailUrl(detail.url)).toBe(true);
    expect(isCanonicalFustDetailUrl('https://jobs.coopjobs.ch/offene-stellen/foo/56db6b36-264e-4f25-bdf5-40a42e764b6b')).toBe(false);
    expect(isCanonicalFustDetailUrl('https://jobs.fust.ch/offene-stellen/foo/not-a-uuid')).toBe(false);
    expect(isCanonicalFustDetailUrl(`${fixture.details[0].url}?wrapped=1`)).toBe(false);
    expect(isCanonicalFustDetailUrl('https://apply.example.test/redirect?job=10100000')).toBe(false);
  });

  it('reads the real workplace instead of Prospective JSON-LD headquarters', () => {
    for (const detail of fixture.details) {
      expect(extractFustWorkplaceFromHtml(detail.html)).toBe(detail.workplace);
      expect(deriveFustWorkplaceCanton(detail.workplace)).toBe(detail.canton);
    }
    const addressBlock = '<h4 data-type="section-title"><b>Arbeitsort</b></h4>'
      + '<p>Fust <br> Riedmoosstrasse 10 <br> 3172 Niederwangen BE</p>';
    expect(extractFustWorkplaceFromHtml(addressBlock)).toBe('Niederwangen BE');
    expect(deriveFustWorkplaceCanton('Niederwangen BE', 'BE')).toBe('BE');
    expect(extractFustWorkplaceFromHtml(
      `<script>var utag_data = { job_arbeitsort: 'Fust' };</script>${fixture.details[3].html}`,
    )).toBe('Bellinzona');
  });

  it('fails loud when the real workplace cannot identify exactly one canton', () => {
    // An API hint may choose only among canton pairs already corroborated by
    // the shared municipality resolver; it is never accepted as free-form
    // geography for an ambiguous known municipality.
    expect(deriveFustWorkplaceCanton('Rickenbach', 'TG')).toBe('TG');
    expect(() => deriveFustWorkplaceCanton('Rickenbach', 'BS'))
      .toThrow(/ambiguous across BL, LU, SO, TG, ZH/);
    expect(() => deriveFustWorkplaceCanton('Schweizweit'))
      .toThrow(/not resolvable to a Swiss municipality/);
    expect(() => deriveFustWorkplaceCanton('Cressier'))
      .toThrow(/ambiguous across FR, NE/);
  });

  it('uses a valid API canton only when the CH resolver has no workplace candidate', () => {
    const fallbacks: FustFallback[] = [];
    expect(deriveFustWorkplaceCanton('Netstal', 'GL', {
      onUnknownFallback: (fallback: FustFallback) => fallbacks.push(fallback),
    })).toBe('GL');
    expect(fallbacks).toEqual([{ workplace: 'Netstal', canton: 'GL' }]);
    expect(() => deriveFustWorkplaceCanton('Netstal', 'XX'))
      .toThrow(/not resolvable to a Swiss municipality/);
    expect(deriveFustWorkplaceCanton('Oberwil', 'BS')).toBe('BL');
  });

  it('builds a complete canonical allowlist and enriches every valid detail', async () => {
    const detailByUrl = new Map<string, string>(
      fixture.details.map((detail) => [String(detail.url), String(detail.html)])
    );
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/public/v1/medium/1000103/jobs?')) {
        const jobs = fixture.api.jobs.slice(0, 4).map((job, index) => index === 0
          ? {
              ...job,
              links: { directlink: `${job.links.directlink.replace('jobs.fust.ch', 'JOBS.FUST.CH')}/` },
            }
          : job);
        return new Response(JSON.stringify({ total: 4, jobs }), { status: 200 });
      }
      const html = detailByUrl.get(url);
      return new Response(html || 'not found', { status: html ? 200 : 404 });
    };

    const discovery = await fetchFustJobUrls({ fetchImpl });
    expect(discovery.apiTotal).toBe(4);
    expect(discovery.urls).toHaveLength(4);
    expect(discovery.urls[0]).toBe(fixture.details[0].url);
    expect(discovery.droppedMalformedUrl).toBe(0);
    expect(discovery.droppedDuplicateIdentity).toBe(0);
    expect(discovery.workplaceCount).toBe(4);
    for (const detail of fixture.details) {
      expect(discovery.seedMetaByUrl[detail.url].location).toBe(detail.workplace);
      expect(discovery.seedMetaByUrl[detail.url].canton).toBe(detail.canton);
      expect(discovery.seedMetaByUrl[detail.url].sourceId).toMatch(/^101\d+$/);
    }
  });

  it('accepts a verified total=0 as an authoritative empty discovery', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ total: 0, jobs: [] }), { status: 200 });
    await expect(fetchFustJobUrls({ fetchImpl })).resolves.toMatchObject({
      apiTotal: 0,
      urls: [],
      seedMetaByUrl: {},
      workplaceCount: 0,
    });
  });

  it('fails loud when an authoritative API snapshot contains an off-host URL', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      if (String(input).includes('/public/v1/medium/1000103/jobs?')) {
        return new Response(JSON.stringify(fixture.api), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    await expect(fetchFustJobUrls({ fetchImpl, enrichDetails: false }))
      .rejects.toThrow(/API=5, matched=5, canonical=4, non-CH=0, malformed=1/);
  });

  it('fails loud on a partial authoritative listing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      total: 501,
      jobs: fixture.api.jobs.slice(0, 4),
    }), { status: 200 });
    await expect(fetchFustJobUrls({ fetchImpl, enrichDetails: false }))
      .rejects.toThrow(/fetched 4\/501/);
  });

  it('fails loud when a canonical detail has no verified workplace', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/public/v1/medium/1000103/jobs?')) {
        return new Response(JSON.stringify({ total: 4, jobs: fixture.api.jobs.slice(0, 4) }), { status: 200 });
      }
      const detail = fixture.details.find((item) => item.url === url);
      return new Response(detail?.html || 'not found', {
        status: detail && detail !== fixture.details[3] ? 200 : 404,
      });
    };
    await expect(fetchFustJobUrls({ fetchImpl }))
      .rejects.toThrow(/enriched 3\/4 canonical details/);
  });
});

describe('Fust post-crawl reconciliation', () => {
  const discovery = {
    urls: fixture.details.map((detail) => detail.url),
    seedMetaByUrl: Object.fromEntries(fixture.details.map((detail, index) => [
      detail.url,
      {
        location: detail.workplace,
        canton: detail.canton,
        company: 'Fust',
        title: fixture.api.jobs[index].title,
        sourceId: fixture.api.jobs[index].id,
      },
    ])),
  };
  const commonSlug = 'detailhandelsfachfrau-mann-efz-fust-oberburen';
  const crawled = fixture.details.map((detail, index) => ({
    id: `company-${['keep01', 'new002', 'new003', 'new004'][index]}`,
    url: detail.url,
    company: index === 2 ? 'Services ménagers suisses SA' : 'Fust | Swiss Household Services AG',
    companyKey: 'fust',
    title: fixture.api.jobs[index].title,
    description: `payload-${index}`.repeat(30),
    location: 'Oberbüren',
    addressLocality: 'Oberbüren',
    canton: 'SG',
    addressRegion: 'SG',
    postalCode: '9245',
    streetAddress: 'Bogenstrasse 7',
    slug: index < 3 ? commonSlug : 'montatore-impianti-sanitari-fust-bellinzona',
    slugByLocale: {
      it: index < 3 ? commonSlug : 'montatore-impianti-sanitari-fust-bellinzona',
      de: index < 3 ? commonSlug : 'sanitarmonteur-fust-bellinzona',
    },
    previousSlugs: index === 0 ? ['redirect-storico-fust'] : [],
    previousSlugsByLocale: index === 0 ? { it: ['redirect-italiano-storico'] } : {},
  }));
  const stale = {
    id: 'company-stale1',
    url: 'https://jobs.fust.ch/offene-stellen/scaduto/11111111-1111-4111-8111-111111111111',
    company: 'Fust',
    companyKey: 'fust',
    title: 'Scaduto',
    slug: 'scaduto-fust',
  };

  it('keeps exactly the authoritative identities and preserves existing id/slug', () => {
    const prior = [{
      ...crawled[0],
      id: 'company-published01',
      slug: 'slug-pubblicato-fust',
      slugByLocale: { ...crawled[0].slugByLocale, it: 'slug-italiano-pubblicato' },
      previousSlugs: ['redirect-storico-fust', 'redirect-precedente-fust'],
      previousSlugsByLocale: {
        it: ['redirect-italiano-storico', 'redirect-italiano-precedente'],
        de: ['redirect-tedesco-precedente'],
      },
    }];
    const reconciled = reconcileFustJobsWithDiscovery([...crawled, stale], discovery, prior);
    expect(reconciled).toHaveLength(4);
    expect(reconciled.map((job: { url: string }) => job.url)).toEqual(discovery.urls);
    expect(reconciled[0]).toMatchObject({
      id: 'company-published01',
      slug: 'slug-pubblicato-fust',
      company: 'Fust',
      companyKey: 'fust',
      location: 'Oberwil',
      addressLocality: 'Oberwil',
      canton: 'BL',
      addressRegion: 'BL',
      postalCode: '',
      streetAddress: '',
    });
    expect(reconciled[0].slugByLocale.it).toBe('slug-italiano-pubblicato');
    expect(reconciled[0].previousSlugs).toEqual([
      'redirect-storico-fust',
      'redirect-precedente-fust',
    ]);
    expect(reconciled[0].previousSlugsByLocale).toEqual({
      it: ['redirect-italiano-storico', 'redirect-italiano-precedente'],
      de: ['redirect-tedesco-precedente'],
    });
    expect(reconciled[1].slug).toContain('niederwangen-bei-bern');
    expect(reconciled[1].slug).not.toContain('oberburen');
    expect(reconciled[2].company).toBe('Fust');
  });

  it('suffixes only newcomers on flat/locale collisions and is idempotent', () => {
    const withHistory = crawled.map((job, index) => index === 1 ? {
      ...job,
      previousSlugs: ['already-retired-fust-slug'],
      previousSlugsByLocale: { it: ['already-retired-it-fust-slug'] },
    } : job);
    const stable = ensureUniqueFustSlugs(withHistory, [withHistory[0]]);
    expect(stable[0].slug).toBe(commonSlug);
    expect(stable[1].slug).toBe(`${commonSlug}-new002`);
    expect(stable[2].slug).toBe(`${commonSlug}-new003`);
    for (const scope of ['slug', 'it', 'de']) {
      const values = stable.map((job: typeof crawled[number]) => scope === 'slug'
        ? job.slug
        : job.slugByLocale[scope as keyof typeof job.slugByLocale]);
      expect(new Set(values).size).toBe(values.length);
    }
    expect(stable[1].previousSlugs).toEqual(['already-retired-fust-slug']);
    expect(stable[1].previousSlugsByLocale).toEqual({ it: ['already-retired-it-fust-slug'] });
    expect(ensureUniqueFustSlugs(stable, [stable[0]])).toEqual(stable);
  });

  it('disambiguates canonical UUIDs that share the first 10 characters', () => {
    const longCollisionSlug = 'x'.repeat(90);
    const collision = [
      {
        ...crawled[0],
        id: 'x',
        url: 'https://jobs.fust.ch/offene-stellen/a/12345678-1234-4aaa-8aaa-111111111111',
        slug: longCollisionSlug,
        slugByLocale: { it: longCollisionSlug },
      },
      {
        ...crawled[1],
        id: 'y',
        url: 'https://jobs.fust.ch/offene-stellen/b/12345678-1234-4bbb-8bbb-222222222222',
        slug: longCollisionSlug,
        slugByLocale: { it: longCollisionSlug },
      },
    ];
    const stable = ensureUniqueFustSlugs(collision);
    expect(stable[0].slug).toBe(longCollisionSlug);
    expect(stable[1].slug).toContain('1234567812344bbb8bbb222222222222');
    expect(new Set(stable.map((job) => job.slug)).size).toBe(2);
    expect(new Set(stable.map((job) => job.slugByLocale.it)).size).toBe(2);
    expect(stable.every((job) => job.slug.length <= 90)).toBe(true);
    expect(stable.every((job) => job.slugByLocale.it.length <= 90)).toBe(true);
  });

  it('fails loud instead of writing an incomplete authoritative snapshot', () => {
    expect(() => reconcileFustJobsWithDiscovery(crawled.slice(0, 3), discovery))
      .toThrow(/completeness invariant failed: 1\/4/);
  });

  it('treats the historical 327-row snapshot as contamination, not a coverage baseline', () => {
    const crossBrandNoise = Array.from({ length: 323 }, (_, index) => ({
      id: `coop-${index}`,
      url: `https://jobs.coopjobs.ch/offene-stellen/noise/${String(index).padStart(8, '0')}`,
      company: 'Coop',
      companyKey: 'fust',
      slug: `noise-${index}`,
    }));
    const reconciled = reconcileFustJobsWithDiscovery([...crawled, ...crossBrandNoise], discovery);
    expect([...crawled, ...crossBrandNoise]).toHaveLength(327);
    expect(reconciled).toHaveLength(4);
    expect(reconciled.every((job: { company: string }) => job.company === 'Fust')).toBe(true);
  });

  it('publishes a verified empty snapshot with a coherent empty slice and removal summary', async () => {
    const prior = [crawled[0]];
    const discovery = { urls: [], seedMetaByUrl: {}, apiTotal: 0 };
    const reconciled = reconcileFustJobsWithDiscovery(prior, discovery, prior);
    const plan = buildFustPublishPlan(reconciled, snapshotJobSlugs(prior), {
      durationMs: 123,
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    const calls: {
      archive?: { jobs: object[]; key: string };
      slice?: SliceObservation;
      summary?: SummaryObservation;
      assembled?: boolean;
    } = {};
    const events: string[] = [];

    const result = await writeFustPublishPlan(plan, {
      authoritativeEmpty: true,
      priorJobs: prior,
      archive: async (jobs: object[], key: string) => {
        await Promise.resolve();
        calls.archive = { jobs, key };
        events.push('archive');
        return jobs.length;
      },
      writeSlice: async (key: string, jobs: object[], options: { skipShrinkGuard: boolean }) => {
        await Promise.resolve();
        calls.slice = { key, jobs, options };
        events.push('slice');
      },
      writeVerified: async () => {
        throw new Error('the generic shrink verifier must not own a verified API total=0');
      },
      writeSummary: async (summary: SummaryObservation) => {
        await Promise.resolve();
        calls.summary = summary;
        events.push('summary');
      },
      assemble: async () => {
        calls.assembled = true;
        events.push('assemble');
      },
    });

    expect(reconciled).toEqual([]);
    expect(plan.summary).toMatchObject({ total: 0, removedCount: 1, durationMs: 123 });
    expect(calls.slice).toEqual({ key: 'fust', jobs: [], options: { skipShrinkGuard: true } });
    expect(calls.summary!.total).toBe(calls.slice!.jobs.length);
    expect(calls.summary!.removedJobs).toHaveLength(1);
    expect(calls.archive).toEqual({ jobs: prior, key: 'fust' });
    expect(calls.assembled).toBe(true);
    expect(events).toEqual(['archive', 'slice', 'summary', 'assemble']);
    expect(result).toEqual({ total: 0, archived: 1 });
  });

  it('requires two durable zero snapshots before archiving the prior slice', async () => {
    const prior = [crawled[0]];
    const discovery = {
      urls: [],
      seedMetaByUrl: {},
      apiTotal: 0,
      droppedMalformedUrl: 0,
      droppedDuplicateIdentity: 0,
      workplaceCount: 0,
      unknownCantonFallbacks: [],
    };
    const before = snapshotJobSlugs(prior);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fust-empty-confirmation-'));
    const statePath = path.join(stateDir, 'fust.json');
    let slice = [...prior];
    const archive = vi.fn(async () => prior.length);
    const writeSlice = vi.fn(async (_key: string, jobs: object[]) => { slice = [...jobs] as typeof prior; });
    const readSummary = () => fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>
      : null;
    const writeSummary = vi.fn(async (summary: Record<string, unknown>) => {
      fs.writeFileSync(statePath, `${JSON.stringify(summary)}\n`, 'utf8');
    });
    const writeScratch = vi.fn(() => []);
    const assemble = vi.fn(async () => {});
    const options = {
      readSummary,
      writeSummary,
      writeScratch,
      archive,
      writeSlice,
      writeVerified: vi.fn(async () => { throw new Error('verified writer must not own total=0'); }),
      assemble,
      durationMs: 123,
      generatedAt: '2026-08-31T00:00:00.000Z',
    };

    try {
      const first = await handleFustEmptyDiscovery(discovery, prior, before, options);
      expect(first).toEqual({ confirmed: false, total: 1, archived: 0 });
      expect(slice).toEqual(prior);
      expect(archive).not.toHaveBeenCalled();
      expect(writeSlice).not.toHaveBeenCalled();
      expect(writeScratch).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();
      expect(readSummary()).toMatchObject({
        total: 1,
        removedCount: 0,
        authoritativeEmptyConsecutiveRuns: 1,
        authoritativeEmptyPending: true,
      });

      // Simulate a new process: the second call reconstructs confirmation
      // exclusively from the versionable summary file, not module memory.
      const second = await handleFustEmptyDiscovery(discovery, prior, before, options);
      expect(second).toEqual({ confirmed: true, total: 0, archived: 1 });
      expect(slice).toEqual([]);
      expect(archive).toHaveBeenCalledWith(prior, 'fust');
      expect(writeScratch).toHaveBeenCalledTimes(1);
      expect(assemble).toHaveBeenCalledTimes(1);
      expect(readSummary()).toMatchObject({ total: 0, removedCount: 1 });
      expect(readSummary()).not.toHaveProperty('authoritativeEmptyConsecutiveRuns');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('resets a pending zero marker on the next successful non-empty publication', async () => {
    const plan = buildFustPublishPlan([crawled[0]]);
    let summaryState: Record<string, unknown> = {
      authoritativeEmptyConsecutiveRuns: 1,
      authoritativeEmptyPending: true,
    };
    await writeFustPublishPlan(plan, {
      writeVerified: async () => {},
      writeSummary: async (summary: Record<string, unknown>) => { summaryState = summary; },
      assemble: async () => {},
    });
    expect(summaryState).not.toHaveProperty('authoritativeEmptyConsecutiveRuns');
    expect(summaryState).not.toHaveProperty('authoritativeEmptyPending');
  });

  it('degrades to "no prior confirmation" instead of crashing on an unreadable summary slice', () => {
    const summaryPath = path.resolve(import.meta.dirname, '..', 'data', 'jobs-crawler-summaries', 'by-crawler', 'fust.json');
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exists = vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === summaryPath ? true : originalExistsSync(p)));
    const readFile = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, enc?: unknown) => {
      if (p === summaryPath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (originalReadFileSync as unknown as (p: fs.PathOrFileDescriptor, enc?: unknown) => unknown)(p, enc);
    }) as typeof fs.readFileSync);
    try {
      expect(readFustSummarySlice()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'));

      warn.mockClear();
      readFile.mockImplementation(((p: fs.PathOrFileDescriptor, enc?: unknown) => {
        if (p === summaryPath) return '{not valid json';
        return (originalReadFileSync as unknown as (p: fs.PathOrFileDescriptor, enc?: unknown) => unknown)(p, enc);
      }) as typeof fs.readFileSync);
      expect(readFustSummarySlice()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));

      warn.mockClear();
      readFile.mockImplementation(((p: fs.PathOrFileDescriptor, enc?: unknown) => {
        if (p === summaryPath) return JSON.stringify(['not', 'an', 'object']);
        return (originalReadFileSync as unknown as (p: fs.PathOrFileDescriptor, enc?: unknown) => unknown)(p, enc);
      }) as typeof fs.readFileSync);
      expect(readFustSummarySlice()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'));
    } finally {
      readFile.mockRestore();
      exists.mockRestore();
      warn.mockRestore();
    }
  });

  it('routes an uncaught Fust invariant failure to exit code 1', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'update-fust-jobs.mjs'), 'utf8');
    expect(source).toMatch(/main\(\)\.catch\(\(err\) => exitCrawlerOnError\(err, 'Fust'\)\)/);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() => exitCrawlerOnError(new Error('workplace invariant failed'), 'Fust')).toThrow('exit:1');
    exit.mockRestore();
  });

  it('keeps the verified shrink guard on every non-empty publication', async () => {
    const plan = buildFustPublishPlan([crawled[0]]);
    const calls: {
      verified?: VerifiedObservation;
      summary?: Pick<SummaryObservation, 'total'>;
      assembled?: boolean;
    } = {};

    const result = await writeFustPublishPlan(plan, {
      archive: () => {
        throw new Error('archive is reserved for an authoritative empty snapshot');
      },
      writeSlice: () => {
        throw new Error('raw slice writes are reserved for an authoritative empty snapshot');
      },
      writeVerified: async (key: string, jobs: object[], options: VerifiedObservation['options']) => {
        calls.verified = { key, jobs, options };
      },
      writeSummary: (summary: SummaryObservation) => {
        calls.summary = summary;
      },
      assemble: async () => {
        calls.assembled = true;
      },
    });

    expect(calls.verified!.key).toBe('fust');
    expect(calls.verified!.jobs).toEqual(plan.sliceJobs);
    expect(calls.verified!.options.isTargetJob(crawled[0])).toBe(true);
    expect(calls.summary!.total).toBe(1);
    expect(calls.assembled).toBe(true);
    expect(result).toEqual({ total: 1, archived: 0 });
  });
});
