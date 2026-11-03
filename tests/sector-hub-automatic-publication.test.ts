import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_SECTOR_HUB_REACTIVATION_MIN_EMPLOYERS,
  AUTO_SECTOR_HUB_REACTIVATION_MIN_JOBS,
  AUTO_SECTOR_HUB_REACTIVATION_MIN_WEEKS,
  AUTO_SECTOR_HUB_MIN_EMPLOYERS,
  AUTO_SECTOR_HUB_MIN_JOBS,
  isIndexableSectorHubPublication,
} from '../data/sector-hub-publications';
import {
  buildAutomaticSectorHubPublicationRegistry,
  buildSectorHubDiscoveryReport,
  type DiscoveryJob,
  type PreviousSectorHubCandidate,
  type TrafficSnapshot,
} from '../scripts/lib/sector-hub-discovery';
import {
  JOB_CATEGORY_KEYS,
  autoSectorHubPathOwner,
  buildAutoSectorHubPath,
  buildJobCategoryPath,
} from '../build-plugins/shared/autoSectorHubPaths';
import {
  autoSectorHubPagesPlugin,
  buildAutoSectorHubPage,
} from '../build-plugins/autoSectorHubPagesPlugin';
import {
  listIndexableAutoSectorHubLinks,
  readAutoSectorHubInventory,
} from '../build-plugins/shared/autoSectorHubPublicationData';
import { emitSeoHubs } from '../build-plugins/seoHubsPlugin';
import { AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER } from '../build-plugins/shared/autoSectorHubNoindexTargetMarker.mjs';
import { SECTOR_HUB_SECTION } from '../build-plugins/shared/jobSectorPaths';
import { BASE_URL } from '../build-plugins/constants';

const DESCRIPTION = Array.from({ length: 60 }, () => 'contenuto').join(' ');

function jobsForCategory(
  category: string,
  prefix: string,
  count: number,
  employerCount: number,
  now: Date,
): DiscoveryJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    slug: `${prefix}-${index}`,
    title: 'Specialista operativo',
    description: DESCRIPTION,
    category,
    company: `Datore ${index % employerCount}`,
    canton: 'TI',
    sourceLang: 'it',
    firstSeenAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  }));
}

function discoveryReportForWeek(
  now: Date,
  jobCount = 8,
  employerCount = 3,
  previousCandidates: PreviousSectorHubCandidate[] = [],
) {
  const jobs = jobsForCategory('analisi oceanografica', 'ocean', jobCount, employerCount, now);
  const popularity = Object.fromEntries(jobs.map((job) => [job.slug!, 10]));
  const traffic: TrafficSnapshot = {
    generatedAt: now.toISOString(),
    window: { startDate: '2026-09-28', endDate: now.toISOString().slice(0, 10) },
    gsc: { queries: {}, pages: {} },
    ga4: { pages: {}, coverage: { complete: true } },
  };
  return buildSectorHubDiscoveryReport({
    jobs,
    popularity,
    popularityScannedAt: now.toISOString(),
    traffic,
    previous: { candidates: previousCandidates },
    now,
  });
}

function retiredSectorHub(reason?: string) {
  return {
    schemaVersion: 1 as const,
    generatedAt: '2026-10-19T12:00:00.000Z',
    sourceWeek: '2026-W43',
    hubs: [{
      slug: 'analisi-oceanografica',
      routeKind: 'dynamic' as const,
      label: 'Analisi oceanografica',
      labelByLocale: { it: 'Analisi oceanografica' },
      sourceFields: ['category' as const],
      matchLabels: ['analisi oceanografica'],
      firstPublishedAt: '2026-10-05T12:00:00.000Z',
      status: 'retired' as const,
      ...(reason ? { retirementReason: reason } : {}),
    }],
  };
}

describe('automatic sector hub publication', () => {
  it('emits BreadcrumbList JSON-LD on indexable dynamic sector pages', () => {
    const publication = {
      slug: 'sanita-ospedali',
      routeKind: 'dynamic' as const,
      label: 'Sanità ospedali',
      labelByLocale: {
        it: 'Sanità ospedali',
        en: 'Hospital healthcare',
        de: 'Spitalwesen',
        fr: 'Santé hospitalière',
      },
      sourceFields: ['category' as const],
      matchLabels: ['sanità ospedali'],
      firstPublishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      status: 'active' as const,
    } as Parameters<typeof buildAutoSectorHubPage>[2];
    const jobs = Array.from({ length: 5 }, (_, index) => ({
      id: `sanita-ospedali-${index}`,
      slug: `sanita-ospedali-${index}`,
      title: 'Operatore sanitario',
      company: index % 2 === 0 ? 'EOC' : 'Clinica Ticino',
      companyKey: index % 2 === 0 ? 'eoc' : 'clinica-ticino',
      location: 'Bellinzona',
      canton: 'TI',
      category: 'health',
      firstSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    })) as unknown as Parameters<typeof buildAutoSectorHubPage>[3];

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const page = buildAutoSectorHubPage('', locale, publication, jobs, '2026-10-20');
      expect(page.indexable).toBe(true);
      expect(page.html).not.toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
      expect(page.html).toContain('"@type":"BreadcrumbList"');
      expect(page.html).toMatch(/<a\b[^>]*href="\/"[^>]*class(?:="s-bcl"|=s-bcl)[^>]*>/);
      const jsonLdBlocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map((match) => JSON.parse(match[1]));
      const breadcrumb = jsonLdBlocks.find((block) => block['@type'] === 'BreadcrumbList') as {
        itemListElement?: Array<{ item?: string }>;
      } | undefined;
      expect(breadcrumb?.itemListElement?.[0]?.item).toBe(`${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`);
    }
  });

  it('keeps retired hubs nonindexable above recovery thresholds until the writer updates the registry', () => {
    const publication = {
      slug: 'tecnica',
      routeKind: 'dynamic' as const,
      label: 'Tecnica',
      labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'Technique' },
      sourceFields: ['category' as const],
      matchLabels: ['tecnica'],
      firstPublishedAt: '2026-10-20T08:22:55.192Z',
      status: 'retired' as const,
    } as Parameters<typeof buildAutoSectorHubPage>[2];
    const jobs = jobsForCategory('tecnica', 'tecnica', 43, 10, new Date('2026-11-02T00:00:00.000Z')) as unknown as Parameters<typeof buildAutoSectorHubPage>[3];

    expect(AUTO_SECTOR_HUB_REACTIVATION_MIN_JOBS).toBe(8);
    expect(AUTO_SECTOR_HUB_REACTIVATION_MIN_EMPLOYERS).toBe(3);
    expect(AUTO_SECTOR_HUB_REACTIVATION_MIN_WEEKS).toBe(2);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const page = buildAutoSectorHubPage('', locale, publication, jobs, '2026-11-02');
      const canonicalUrl = `${BASE_URL}${buildAutoSectorHubPath(locale, 'tecnica')}`;
      const canonical = page.html.match(/<link rel=canonical href="([^"]+)"/)?.[1];

      expect(page.indexable).toBe(false);
      expect(page.html).toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
      expect(page.html).toContain('noindex,follow');
      expect(canonical).toBe(canonicalUrl);
      for (const alternateLocale of ['it', 'en', 'de', 'fr'] as const) {
        expect(page.html).toContain(`${BASE_URL}${buildAutoSectorHubPath(alternateLocale, 'tecnica')}`);
      }
    }

    const nearFloorJobs = jobsForCategory(
      'tecnica', 'tecnica-near-floor', AUTO_SECTOR_HUB_REACTIVATION_MIN_JOBS - 1,
      AUTO_SECTOR_HUB_REACTIVATION_MIN_EMPLOYERS, new Date('2026-11-02T00:00:00.000Z'),
    ) as unknown as Parameters<typeof buildAutoSectorHubPage>[3];
    const bridge = buildAutoSectorHubPage('', 'it', publication, nearFloorJobs, '2026-11-02');
    expect(bridge.indexable).toBe(false);
    expect(bridge.html).toContain('noindex,follow');
    expect(bridge.html).toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);

    const explicitlyRetired = { ...publication, retirementReason: 'Owner decision: duplicate hub.' };
    const explicitBridge = buildAutoSectorHubPage('', 'it', explicitlyRetired, jobs, '2026-11-02');
    expect(explicitBridge.indexable).toBe(false);
    expect(explicitBridge.html).toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
  });

  it('keeps static category paths owned by the job-board emitter in every locale', () => {
    const locales = ['it', 'en', 'de', 'fr'] as const;
    const cantonSections = {
      it: ['cerca-lavoro-ticino', 'cerca-lavoro-zurigo'],
      en: ['find-jobs-ticino', 'find-jobs-zurich'],
      de: ['jobs-im-tessin', 'jobs-in-zurich'],
      fr: ['trouver-emploi-tessin', 'trouver-emploi-zurich'],
    } as const;

    expect(autoSectorHubPathOwner('static-category')).toBe('jobsSeoPagesPlugin');
    expect(autoSectorHubPathOwner('dynamic')).toBe('autoSectorHubPagesPlugin');

    for (const locale of locales) {
      for (const category of JOB_CATEGORY_KEYS) {
        expect(buildAutoSectorHubPath(locale, category, 'static-category'))
          .toBe(buildJobCategoryPath(locale, SECTOR_HUB_SECTION[locale], category));
        for (const section of cantonSections[locale]) {
          const path = buildJobCategoryPath(locale, section, category);
          expect(path).toMatch(/^\/[^\s]+\/$/);
          expect(path).not.toContain('//');
        }
      }
    }
  });

  it('publishes every candidate meeting the 5-ad, 2-employer and measured-traffic gates in the first report', () => {
    const now = new Date('2026-10-19T12:00:00.000Z');
    const jobs = [
      ...jobsForCategory('analisi oceanografica', 'ocean', 5, 2, now),
      ...jobsForCategory('geologia applicata', 'geologia', 5, 2, now),
      ...jobsForCategory('fotografia astronomica', 'foto', 4, 2, now),
      ...jobsForCategory('analisi mineraria', 'miniera', 5, 1, now),
      ...jobsForCategory('telecomunicazioni alpine', 'telecom', 5, 2, now),
    ];
    const popularity = Object.fromEntries(jobs
      .filter((job) => !job.id?.startsWith('telecom-'))
      .map((job) => [job.slug!, 1]));
    const traffic: TrafficSnapshot = {
      generatedAt: now.toISOString(),
      window: { startDate: '2026-09-21', endDate: '2026-10-19' },
      gsc: { queries: {}, pages: {} },
      ga4: { pages: {}, coverage: { complete: true } },
    };

    const report = buildSectorHubDiscoveryReport({
      jobs,
      popularity,
      popularityScannedAt: now.toISOString(),
      traffic,
      now,
    });
    const registry = buildAutomaticSectorHubPublicationRegistry({ report });

    expect(AUTO_SECTOR_HUB_MIN_JOBS).toBe(5);
    expect(AUTO_SECTOR_HUB_MIN_EMPLOYERS).toBe(2);
    expect(registry.hubs.map((hub) => hub.slug)).toEqual(['analisi-oceanografica', 'geologia-applicata']);
    expect(registry.hubs.every((hub) => hub.status === 'active')).toBe(true);
    expect(registry.hubs.every((hub) => hub.labelByLocale.it === hub.label)).toBe(true);
    expect(report.candidates.find((candidate) => candidate.suggestedSlug === 'fotografia-astronomica'))
      .toMatchObject({ activeJobCount: 4, employerCount: 2, automaticPromotionEligible: false });
    expect(report.candidates.find((candidate) => candidate.suggestedSlug === 'analisi-mineraria'))
      .toMatchObject({ activeJobCount: 5, employerCount: 1, automaticPromotionEligible: false });
    expect(report.candidates.find((candidate) => candidate.suggestedSlug === 'telecomunicazioni-alpine'))
      .toMatchObject({ activeJobCount: 5, employerCount: 2, automaticPromotionEligible: false });
  });

  it('uses the same 5-ad and 2-employer minimum for indexability', () => {
    const publication = {
      slug: 'analisi-oceanografica',
      routeKind: 'dynamic' as const,
      label: 'Analisi oceanografica',
      labelByLocale: { it: 'Analisi oceanografica' },
      sourceFields: ['category' as const],
      matchLabels: ['analisi oceanografica'],
      firstPublishedAt: '2026-10-19T12:00:00.000Z',
      status: 'active' as const,
    };

    expect(isIndexableSectorHubPublication(publication, 5, 2, 'it')).toBe(true);
    expect(isIndexableSectorHubPublication(publication, 4, 2, 'it')).toBe(false);
    expect(isIndexableSectorHubPublication(publication, 5, 1, 'it')).toBe(false);
    expect(isIndexableSectorHubPublication({ ...publication, status: 'retired' }, 8, 3, 'it')).toBe(false);
    expect(isIndexableSectorHubPublication({ ...publication, status: 'retired' }, 7, 3, 'it')).toBe(false);
    expect(isIndexableSectorHubPublication({
      ...publication,
      status: 'retired',
      retirementReason: 'Owner decision: duplicate hub.',
    }, 43, 10, 'it')).toBe(false);

    const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/sector-hub-publications.json'), 'utf8')) as {
      hubs: Array<typeof publication & { status: 'active' | 'retired' }>;
    };
    const tecnica = registry.hubs.find((hub) => hub.slug === 'tecnica');
    expect(tecnica?.status).toBe('active');
    expect(isIndexableSectorHubPublication(tecnica!, 43, 10, 'it')).toBe(true);
  });

  it('reactivates a retired hub only after two consecutive weeks meeting inventory and traffic gates', () => {
    const previous = retiredSectorHub();
    const staleHistory: PreviousSectorHubCandidate[] = [{
      suggestedSlug: 'analisi-oceanografica',
      observedWeeks: ['2026-W42', '2026-W43'],
      firstSeenAt: '2026-10-05T12:00:00.000Z',
      lastSeenAt: '2026-10-19T12:00:00.000Z',
    }];
    const first = discoveryReportForWeek(new Date('2026-10-26T12:00:00.000Z'), 8, 3, staleHistory);
    const firstCandidate = first.candidates.find((candidate) => candidate.suggestedSlug === 'analisi-oceanografica')!;
    const afterFirstWeek = buildAutomaticSectorHubPublicationRegistry({ previous, report: first });

    expect(firstCandidate.trafficEvidence).toBe(true);
    expect(firstCandidate.consecutiveWeeks).toBeGreaterThan(1);
    expect(firstCandidate.consecutiveEligibleWeeks).toBe(1);
    expect(afterFirstWeek.hubs[0].status).toBe('retired');

    const second = discoveryReportForWeek(new Date('2026-11-02T12:00:00.000Z'), 8, 3, first.candidates);
    const secondCandidate = second.candidates.find((candidate) => candidate.suggestedSlug === 'analisi-oceanografica')!;
    const afterSecondWeek = buildAutomaticSectorHubPublicationRegistry({ previous: afterFirstWeek, report: second });

    expect(secondCandidate.consecutiveEligibleWeeks).toBe(2);
    expect(afterSecondWeek.hubs[0].status).toBe('active');
  });

  it('resets the recovery streak on the first ineligible week', () => {
    const previous = retiredSectorHub();
    const week1 = discoveryReportForWeek(new Date('2026-10-26T12:00:00.000Z'));
    const registry1 = buildAutomaticSectorHubPublicationRegistry({ previous, report: week1 });
    expect(week1.candidates[0].consecutiveEligibleWeeks).toBe(1);
    expect(registry1.hubs[0].status).toBe('retired');

    const week2 = discoveryReportForWeek(new Date('2026-11-02T12:00:00.000Z'), 5, 2, week1.candidates);
    const registry2 = buildAutomaticSectorHubPublicationRegistry({ previous: registry1, report: week2 });
    expect(week2.candidates[0].consecutiveEligibleWeeks).toBe(0);
    expect(registry2.hubs[0].status).toBe('retired');

    const week3 = discoveryReportForWeek(new Date('2026-11-09T12:00:00.000Z'), 8, 3, week2.candidates);
    const registry3 = buildAutomaticSectorHubPublicationRegistry({ previous: registry2, report: week3 });
    expect(week3.candidates[0].consecutiveEligibleWeeks).toBe(1);
    expect(registry3.hubs[0].status).toBe('retired');

    const week4 = discoveryReportForWeek(new Date('2026-11-16T12:00:00.000Z'), 8, 3, week3.candidates);
    const registry4 = buildAutomaticSectorHubPublicationRegistry({ previous: registry3, report: week4 });
    expect(week4.candidates[0].consecutiveEligibleWeeks).toBe(2);
    expect(registry4.hubs[0].status).toBe('active');
  });

  it('never reactivates retirements with an owner retirement reason', () => {
    const reason = 'Owner decision: duplicate of another dedicated hub.';
    const previous = retiredSectorHub(reason);
    const previousCandidates: PreviousSectorHubCandidate[] = [{
      suggestedSlug: 'analisi-oceanografica',
      consecutiveEligibleWeeks: 1,
      lastEligibleWeek: '2026-W43',
    }];
    const report = discoveryReportForWeek(new Date('2026-10-26T12:00:00.000Z'), 8, 3, previousCandidates);
    const registry = buildAutomaticSectorHubPublicationRegistry({ previous, report });

    expect(report.candidates[0].consecutiveEligibleWeeks).toBe(2);
    expect(registry.hubs[0]).toMatchObject({ status: 'retired', retirementReason: reason });
  });

  it('uses registry status for index pages, sitemap and directory links above the inventory threshold', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sector-hub-recovery-'));
    const distDir = path.join(rootDir, 'dist');
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const publication = {
      slug: 'tecnica',
      routeKind: 'dynamic' as const,
      label: 'Tecnica',
      labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'Technique' },
      sourceFields: ['category' as const],
      matchLabels: ['Tecnica'],
      firstPublishedAt: '2026-10-20T08:22:55.192Z',
      status: 'retired' as const,
    };
    const jobs = jobsForCategory('Tecnica', 'tecnica', 43, 10, new Date('2026-11-02T00:00:00.000Z'));
    fs.writeFileSync(path.join(dataDir, 'sector-hub-publications.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-30T21:53:11.196Z',
      sourceWeek: '2026-W44',
      hubs: [publication],
    }));
    fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify(jobs));
    const inventory = readAutoSectorHubInventory(rootDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(listIndexableAutoSectorHubLinks(inventory, locale)).toEqual([]);
      }

      const plugin = autoSectorHubPagesPlugin(rootDir);
      if (typeof plugin.closeBundle !== 'function') throw new Error('Expected closeBundle handler.');
      const closeBundle = plugin.closeBundle as () => Promise<void>;
      await closeBundle();

      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const localePath = buildAutoSectorHubPath(locale, 'tecnica');
        const html = fs.readFileSync(path.join(distDir, localePath.slice(1), 'index.html'), 'utf-8');
        const canonical = html.match(/<link rel=canonical href="([^"]+)"/)?.[1];
        expect(html).toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
        expect(html).toContain('noindex,follow');
        expect(canonical).toBe(`${BASE_URL}${localePath}`);
      }
      expect(fs.existsSync(path.join(distDir, 'sitemap-auto-sector-hubs.xml'))).toBe(false);
      expect(log.mock.calls.flat().join('\n')).not.toContain('automatically reactivated');

      const activePublication = { ...publication, status: 'active' as const };
      fs.writeFileSync(path.join(dataDir, 'sector-hub-publications.json'), JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-11-02T00:00:00.000Z',
        sourceWeek: '2026-W45',
        hubs: [activePublication],
      }));
      const activeInventory = readAutoSectorHubInventory(rootDir);
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(listIndexableAutoSectorHubLinks(activeInventory, locale)).toContainEqual({
          slug: 'tecnica',
          href: buildAutoSectorHubPath(locale, 'tecnica'),
          label: activePublication.labelByLocale[locale],
        });
      }
      await closeBundle();

      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const localePath = buildAutoSectorHubPath(locale, 'tecnica');
        const html = fs.readFileSync(path.join(distDir, localePath.slice(1), 'index.html'), 'utf-8');
        expect(html).not.toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
        expect(html).toMatch(/index,\s*follow/);
      }
      const sitemap = fs.readFileSync(path.join(distDir, 'sitemap-auto-sector-hubs.xml'), 'utf-8');
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(sitemap).toContain(`<loc>${BASE_URL}${buildAutoSectorHubPath(locale, 'tecnica')}</loc>`);
        expect(sitemap).toContain(`hreflang="${locale}"`);
      }
    } finally {
      log.mockRestore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps every active indexable hub in the generated directory and shared sitemap across locale legs', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sector-hub-full-flow-'));
    const distDir = path.join(rootDir, 'dist');
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'services'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'services', 'jobDataNormalization.ts'), 'export const CRAWLED_COMPANY_LOGOS = {\n};\n');
    const now = new Date();
    const publications = [
      {
        slug: 'tecnica', routeKind: 'dynamic', label: 'Tecnica',
        labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'Technique' },
        matchLabel: 'Tecnica',
      },
      {
        slug: 'public-admin', routeKind: 'dynamic', label: 'Amministrazione pubblica',
        labelByLocale: { it: 'Amministrazione pubblica', en: 'Public administration', de: 'Öffentliche Verwaltung', fr: 'Administration publique' },
        matchLabel: 'Amministrazione pubblica',
      },
      {
        slug: 'admin', routeKind: 'dynamic', label: 'Amministrazione',
        labelByLocale: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
        matchLabel: 'Amministrazione',
      },
      {
        slug: 'sotto-soglia', routeKind: 'dynamic', label: 'Sotto soglia',
        labelByLocale: { it: 'Sotto soglia', en: 'Below threshold', de: 'Unter dem Schwellenwert', fr: 'Sous le seuil' },
        matchLabel: 'Sotto soglia',
      },
    ].map(({ matchLabel, ...publication }) => ({
      ...publication,
      sourceFields: ['category'],
      matchLabels: [matchLabel],
      firstPublishedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'active',
    }));
    const publishableJobs = [
      ...jobsForCategory('Tecnica', 'tecnica', 6, 3, now),
      ...jobsForCategory('Amministrazione pubblica', 'public-admin', 6, 3, now),
      ...jobsForCategory('Amministrazione', 'admin', 6, 3, now),
      ...jobsForCategory('Sotto soglia', 'sotto-soglia', 4, 2, now),
    ];
    const registryFile = path.join(dataDir, 'sector-hub-publications.json');
    const jobsFile = path.join(dataDir, 'jobs.json');
    fs.writeFileSync(registryFile, JSON.stringify({
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      sourceWeek: 'fixture',
      hubs: publications,
    }));
    fs.writeFileSync(jobsFile, JSON.stringify(publishableJobs));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Generate the actual sector directory HTML from the same registry and
      // inventory that the automatic page/sitemap plugin reads.
      emitSeoHubs({
        rootDir,
        distDir,
        fs,
        np: path,
        entryJs: '',
        entryCss: '',
        hasSpaBundle: false,
        qw(filePath, html) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, html);
        },
      });
      const inventory = readAutoSectorHubInventory(rootDir);
      const directoryPaths = {
        it: 'cerca-lavoro-ticino/settori/index.html',
        en: 'en/find-jobs-ticino/sectors/index.html',
        de: 'de/jobs-im-tessin/branchen/index.html',
        fr: 'fr/trouver-emploi-tessin/secteurs/index.html',
      } as const;

      vi.stubEnv('BUILD_LOCALE', 'it');
      vi.resetModules();
      const { autoSectorHubPagesPlugin: makeItPlugin } = await import('../build-plugins/autoSectorHubPagesPlugin');
      const { reconcileRemainingSitemapsWithDist } = await import('../build-plugins/sitemapAliasPlugin');
      const itPlugin = makeItPlugin(rootDir);
      if (typeof itPlugin.closeBundle !== 'function') throw new Error('Expected closeBundle handler.');
      await (itPlugin.closeBundle as () => Promise<void>)();
      await reconcileRemainingSitemapsWithDist(distDir, { ignoreShardOwnership: true });

      const sitemapFile = path.join(distDir, 'sitemap-auto-sector-hubs.xml');
      const sitemap = fs.readFileSync(sitemapFile, 'utf-8');
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const links = listIndexableAutoSectorHubLinks(inventory, locale);
        expect(links.map((link) => link.slug).sort()).toEqual(['admin', 'public-admin', 'tecnica']);
        const directoryHtml = fs.readFileSync(path.join(distDir, directoryPaths[locale]), 'utf-8');
        for (const link of links) {
          expect(directoryHtml).toContain(`href="${link.href}"`);
          expect(sitemap).toContain(`<loc>${BASE_URL}${link.href}</loc>`);
        }
        expect(directoryHtml).not.toContain(buildAutoSectorHubPath(locale, 'sotto-soglia'));
        expect(sitemap).not.toContain(buildAutoSectorHubPath(locale, 'sotto-soglia'));
      }

      // A later non-IT leg sees an active but below-floor inventory snapshot.
      // It emits its locale pages, but must leave the IT-owned root sitemap
      // intact rather than replacing it with an empty view of that snapshot.
      const belowFloorJobs = [
        ...jobsForCategory('Tecnica', 'tecnica-small', 4, 2, now),
        ...jobsForCategory('Amministrazione pubblica', 'public-admin-small', 4, 2, now),
        ...jobsForCategory('Amministrazione', 'admin-small', 4, 2, now),
        ...jobsForCategory('Sotto soglia', 'sotto-soglia-small', 4, 2, now),
      ];
      fs.writeFileSync(jobsFile, JSON.stringify(belowFloorJobs));
      vi.stubEnv('BUILD_LOCALE', 'en');
      vi.resetModules();
      const { autoSectorHubPagesPlugin: makeEnPlugin } = await import('../build-plugins/autoSectorHubPagesPlugin');
      const enPlugin = makeEnPlugin(rootDir);
      if (typeof enPlugin.closeBundle !== 'function') throw new Error('Expected closeBundle handler.');
      await (enPlugin.closeBundle as () => Promise<void>)();
      expect(fs.readFileSync(sitemapFile, 'utf-8')).toBe(sitemap);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      log.mockRestore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('drops prior locale labels when a candidate source label changes', () => {
    const previous = {
      schemaVersion: 1 as const,
      generatedAt: '2026-10-12T12:00:00.000Z',
      sourceWeek: '2026-W42',
      hubs: [{
        slug: 'nuovo-slug',
        routeKind: 'dynamic' as const,
        label: 'Etichetta precedente',
        labelByLocale: { it: 'Etichetta precedente', en: 'Old translation' },
        sourceFields: ['category' as const],
        matchLabels: ['Etichetta precedente'],
        firstPublishedAt: '2026-10-12T12:00:00.000Z',
        status: 'active' as const,
      }],
    };
    const registry = buildAutomaticSectorHubPublicationRegistry({
      previous,
      report: {
        generatedAt: '2026-10-19T12:00:00.000Z',
        week: '2026-W43',
        candidates: [{
          label: 'Etichetta aggiornata',
          suggestedSlug: 'nuovo-slug',
          sourceLocale: 'it',
          labelByLocale: { it: 'Etichetta aggiornata' },
          automaticPromotionEligible: true,
          sourceFields: ['category'],
          alternateLabels: [],
          activeJobCount: 5,
          employerCount: 2,
          activeJobsWithViews: 5,
          viewsPerLiveDay: 1,
          ga4Sessions28d: 0,
          gscJobPageImpressions28d: 0,
          consecutiveWeeks: 1,
          status: 'eligible-for-publication',
          slugConflict: false,
        }],
      },
    });

    expect(registry.hubs[0].labelByLocale).toEqual({ it: 'Etichetta aggiornata' });
  });
});
