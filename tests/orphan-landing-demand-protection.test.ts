// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countHtmlBodyWords, MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import {
  buildOrphanLandingHubPath,
  orphanQueryLandingPlugin,
} from '../build-plugins/orphanQueryLandingPlugin';
import { buildOrphanLandingPath, type OrphanCountableJob, type OrphanQueryCluster } from '../build-plugins/orphanQueryData';
import {
  _resetForTests as resetTrafficEvidence,
  GSC_DEMAND_MIN_IMPRESSED_PATHS,
  GSC_DEMAND_WINDOW_DAYS,
} from '../build-plugins/shared/trafficEvidenceFilter';

const wordCountOverride = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock('../build-plugins/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/constants')>();
  return {
    ...actual,
    countHtmlBodyWords: (html: string) => wordCountOverride.value ?? actual.countHtmlBodyWords(html),
  };
});

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-demand-protection-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
};

afterEach(() => {
  wordCountOverride.value = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  resetTrafficEvidence();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const longDescription = 'This job description contains more than fifty words so that the activity gate passes during the filterMatchingJobs invocation; it describes the role, the responsibilities, the benefits, the requirements, the schedule, the compensation bracket, the ideal candidate profile, and the onboarding process along with details about training, tenure, mobility, equipment, relocation, and career development pathways.';

interface ClusterFixture {
  locale: OrphanQueryCluster['locale'];
  slug: string;
  roleTokens: string[];
  regionTokens: string[];
}

function cluster(fixture: ClusterFixture): OrphanQueryCluster {
  const query = fixture.slug.replace(/-/g, ' ');
  return {
    clusterId: `${fixture.locale}-${fixture.slug}`,
    locale: fixture.locale,
    canonicalQuery: query,
    canonicalSlug: fixture.slug,
    roleTokens: fixture.roleTokens,
    regionTokens: fixture.regionTokens,
    totalImpressions: 12,
    totalClicks: 0,
    queries: [{ query, clicks: 0, impressions: 12 }],
  };
}

function job(opts: {
  slug: string;
  title: string;
  location: string;
  canton?: string;
}): OrphanCountableJob {
  return {
    title: opts.title,
    titleByLocale: { it: opts.title, en: opts.title, de: opts.title, fr: opts.title },
    company: 'Fixture AG',
    location: opts.location,
    addressLocality: opts.location,
    canton: opts.canton ?? 'TI',
    description: longDescription,
    descriptionByLocale: { it: longDescription, en: longDescription, de: longDescription, fr: longDescription },
    slug: opts.slug,
    postedDate: daysAgo(2),
  };
}

function writeEvidence(root: string, impressedPaths: readonly string[], active = true): void {
  const pages: Record<string, number> = Object.fromEntries(impressedPaths.map((urlPath) => [urlPath, 1]));
  const targetSize = active ? GSC_DEMAND_MIN_IMPRESSED_PATHS : GSC_DEMAND_MIN_IMPRESSED_PATHS - 1;
  let filler = 0;
  while (Object.keys(pages).length < targetSize) pages[`/synthetic-gsc-path-${filler++}/`] = 1;
  fs.writeFileSync(
    path.join(root, 'data', 'evidence-index.json'),
    JSON.stringify({ windowDays: GSC_DEMAND_WINDOW_DAYS, gsc: { pages } }),
  );
}

async function emit(root: string, clusters: OrphanQueryCluster[], jobs: OrphanCountableJob[]): Promise<void> {
  fs.writeFileSync(path.join(root, 'data', 'gsc-orphan-queries-clusters.json'), JSON.stringify({ clusters }));
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify(jobs));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  vi.stubEnv('SKIP_ORPHAN_LANDINGS', '0');
  vi.stubEnv('MAX_ORPHAN_LANDINGS', '0');
  const closeBundle = orphanQueryLandingPlugin(root).closeBundle;
  if (typeof closeBundle !== 'function') throw new Error('Expected orphan query closeBundle hook');
  await closeBundle.call({} as never);
}

const robotsOf = (html: string): string =>
  html.match(/<meta[^>]*\bname=["']?robots["']?[^>]*\bcontent=["']?([^"'>]+)/i)?.[1]?.replace(/\s+/g, '') ?? '';

function readPage(root: string, urlPath: string): string {
  return fs.readFileSync(path.join(root, 'dist', urlPath.replace(/^\/+/, ''), 'index.html'), 'utf8');
}

const exactRemovedWithImpressions: Array<ClusterFixture & { urlPath: string; title: string; location: string }> = [
  { locale: 'it', slug: 'lavoro-balerna', urlPath: '/ricerca/lavoro-balerna/', roleTokens: ['lavoro'], regionTokens: ['balerna'], title: 'Lavoro offerte attive', location: 'Balerna' },
  { locale: 'de', slug: 'coop-jobs-winterthur', urlPath: '/de/suche/coop-jobs-winterthur/', roleTokens: ['coop'], regionTokens: ['winterthur'], title: 'Coop Verkaufsmitarbeiter', location: 'Winterthur' },
  { locale: 'de', slug: 'jobs-in-zurich', urlPath: '/de/suche/jobs-in-zurich/', roleTokens: ['jobs'], regionTokens: ['zurich'], title: 'Jobs Stellenangebot', location: 'Zurich' },
  { locale: 'fr', slug: 'graphisme-emploi', urlPath: '/fr/recherche/graphisme-emploi/', roleTokens: ['graphisme'], regionTokens: [], title: 'Graphisme professionnel', location: 'Geneve' },
];

describe('orphan landing 90-day GSC demand protection', () => {
  it('keeps the four shown publisher URLs indexable and the other 14 removed URLs noindex', async () => {
    const root = temporaryRoot();
    const shownClusters = exactRemovedWithImpressions.map(cluster);
    const shownJobs = exactRemovedWithImpressions.map((fixture, index) => job({
      slug: `shown-${index}`,
      title: fixture.title,
      location: fixture.location,
      canton: fixture.locale === 'de' && fixture.location === 'Zurich' ? 'ZH' : 'TI',
    }));
    const absentFixtures: ClusterFixture[] = [
      'alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
      'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november',
    ].map((token, index) => ({
      locale: 'it', slug: `removed-no-demand-${index}`, roleTokens: [token], regionTokens: [],
    }));
    const absentJobs = absentFixtures.map((fixture, index) => job({
      slug: `no-demand-${index}`,
      title: `${fixture.roleTokens[0]} specialist`,
      location: 'Lugano',
    }));
    const threeJobClusters = [
      cluster({ locale: 'en', slug: 'engineer-demand-control', roleTokens: ['engineer'], regionTokens: [] }),
      cluster({ locale: 'en', slug: 'engineer-no-demand-control', roleTokens: ['engineer'], regionTokens: [] }),
    ];
    const engineerJobs = Array.from({ length: 6 }, (_, index) => job({
      slug: `engineer-${index}`,
      title: `Engineer position ${index}`,
      location: 'Bern',
      canton: 'ZH',
    }));
    const supportEnPath = buildOrphanLandingPath('en', 'engineer-no-demand-control');
    const demandControlPath = buildOrphanLandingPath('en', 'engineer-demand-control');
    const impressedPaths = [
      ...exactRemovedWithImpressions.map((fixture) => fixture.urlPath),
      demandControlPath,
    ];
    writeEvidence(root, impressedPaths);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await emit(root, [...shownClusters, ...absentFixtures.map(cluster), ...threeJobClusters], [...shownJobs, ...absentJobs, ...engineerJobs]);
    const buildLog = log.mock.calls.flat().join('\n');

    const sitemapPath = path.join(root, 'dist', 'sitemap-orphan-landings.xml');
    const sitemap = fs.readFileSync(sitemapPath, 'utf8');
    for (const fixture of exactRemovedWithImpressions) {
      const html = readPage(root, fixture.urlPath);
      expect(countHtmlBodyWords(html), fixture.urlPath).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
      expect(robotsOf(html), fixture.urlPath).toMatch(/^index,follow(?:,|$)/);
      expect(sitemap, fixture.urlPath).toContain(`<loc>https://frontaliereticino.ch${fixture.urlPath}</loc>`);
    }
    expect(buildLog).toMatch(/4 demand-protected by GSC 90d/);
    for (const fixture of absentFixtures) {
      const urlPath = buildOrphanLandingPath(fixture.locale, fixture.slug);
      expect(robotsOf(readPage(root, urlPath)), urlPath).toBe('noindex,follow');
      expect(sitemap, urlPath).not.toContain(`<loc>https://frontaliereticino.ch${urlPath}</loc>`);
    }

    // The same shared render decision feeds both hub listing and its cross-locale availability.
    const itHub = readPage(root, buildOrphanLandingHubPath('it'));
    expect(itHub).toContain('href="/ricerca/lavoro-balerna/"');
    const enHub = readPage(root, buildOrphanLandingHubPath('en'));
    expect(enHub).toContain(`href="${supportEnPath}"`);
    expect(enHub).toMatch(/hreflang=["']?it(?:["'\s>])/);
    expect(enHub).toMatch(/hreflang=["']?de(?:["'\s>])/);
    expect(enHub).toMatch(/hreflang=["']?fr(?:["'\s>])/);

    // Three or more jobs keep the pre-existing indexability result with and without demand.
    for (const fixturePath of [demandControlPath, supportEnPath]) {
      expect(robotsOf(readPage(root, fixturePath)), fixturePath).toMatch(/^index,follow(?:,|$)/);
      expect(sitemap).toContain(`<loc>https://frontaliereticino.ch${fixturePath}</loc>`);
    }
  });

  it('keeps the current floor behavior when demand evidence is dormant, even if the URL is present', async () => {
    const root = temporaryRoot();
    const fixture = exactRemovedWithImpressions[0];
    const urlPath = fixture.urlPath;
    writeEvidence(root, [urlPath], false);
    await emit(root, [cluster(fixture)], [job({ slug: 'balerna-one', title: fixture.title, location: fixture.location })]);

    expect(robotsOf(readPage(root, urlPath))).toBe('noindex,follow');
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-orphan-landings.xml'))).toBe(false);
  });

  it('does not let impressions bypass regional relevance or the one-job minimum', async () => {
    const root = temporaryRoot();
    const region = cluster({ locale: 'it', slug: 'architect-ticino-two-jobs', roleTokens: ['architect'], regionTokens: ['ticino'] });
    const empty = cluster({ locale: 'it', slug: 'zero-matching-jobs', roleTokens: ['zerojob'], regionTokens: [] });
    const regionPath = buildOrphanLandingPath(region.locale, region.canonicalSlug);
    const emptyPath = buildOrphanLandingPath(empty.locale, empty.canonicalSlug);
    writeEvidence(root, [regionPath, emptyPath]);
    await emit(root, [region, empty], [
      job({ slug: 'architect-zh', title: 'Architect', location: 'Zurich', canton: 'ZH' }),
      job({ slug: 'architect-ge', title: 'Architect', location: 'Geneve', canton: 'GE' }),
    ]);

    expect(robotsOf(readPage(root, regionPath))).toBe('noindex,follow');
    expect(robotsOf(readPage(root, emptyPath))).toBe('noindex,follow');
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-orphan-landings.xml'))).toBe(false);
  });

  it('still applies the 50-word gate after a demand-protected job-floor decision', async () => {
    const root = temporaryRoot();
    const fixture = exactRemovedWithImpressions[0];
    writeEvidence(root, [fixture.urlPath]);
    wordCountOverride.value = MIN_INDEXABLE_WORDS - 1;
    await emit(root, [cluster(fixture)], [job({ slug: 'balerna-short-copy', title: fixture.title, location: fixture.location })]);

    expect(robotsOf(readPage(root, fixture.urlPath))).toBe('noindex,follow');
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-orphan-landings.xml'))).toBe(false);
  });
});
