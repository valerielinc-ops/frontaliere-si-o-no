import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFustPublishPlan,
  deriveFustWorkplaceCanton,
  ensureUniqueFustSlugs,
  extractFustWorkplaceFromHtml,
  fetchFustJobUrls,
  isCanonicalFustDetailUrl,
  reconcileFustJobsWithDiscovery,
  writeFustPublishPlan,
} from '../scripts/update-fust-jobs.mjs';
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
    const stable = ensureUniqueFustSlugs(crawled, [crawled[0]]);
    expect(stable[0].slug).toBe(commonSlug);
    expect(stable[1].slug).toBe(`${commonSlug}-new002`);
    expect(stable[2].slug).toBe(`${commonSlug}-new003`);
    for (const scope of ['slug', 'it', 'de']) {
      const values = stable.map((job: typeof crawled[number]) => scope === 'slug'
        ? job.slug
        : job.slugByLocale[scope as keyof typeof job.slugByLocale]);
      expect(new Set(values).size).toBe(values.length);
    }
    expect(ensureUniqueFustSlugs(stable, [stable[0]])).toEqual(stable);
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
