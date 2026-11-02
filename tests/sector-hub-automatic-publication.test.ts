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

  it('automatically recovers retired hubs after crossing the inventory hysteresis band', () => {
    const publication = {
      slug: 'tecnica',
      routeKind: 'dynamic' as const,
      label: 'Tecnica',
      labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'techniques' },
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
      const robots = page.html.match(/<meta name=robots content="([^"]+)"/)?.[1];

      expect(page.indexable).toBe(true);
      expect(page.html).not.toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
      expect(robots).toBeDefined();
      expect(robots).not.toMatch(/noindex/i);
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
    expect(isIndexableSectorHubPublication({ ...publication, status: 'retired' }, 8, 3, 'it')).toBe(true);
    expect(isIndexableSectorHubPublication({ ...publication, status: 'retired' }, 7, 3, 'it')).toBe(false);
    expect(isIndexableSectorHubPublication({
      ...publication,
      status: 'retired',
      retirementReason: 'Owner decision: duplicate hub.',
    }, 43, 10, 'it')).toBe(false);
  });

  it('requires two consecutive recovery weeks and 8 jobs / 3 employers after retirement', () => {
    const previous = {
      schemaVersion: 1 as const,
      generatedAt: '2026-10-30T21:53:11.196Z',
      sourceWeek: '2026-W44',
      hubs: [{
        slug: 'tecnica',
        routeKind: 'dynamic' as const,
        label: 'Tecnica',
        labelByLocale: { it: 'Tecnica' },
        sourceFields: ['category' as const],
        matchLabels: ['Tecnica'],
        firstPublishedAt: '2026-10-20T08:22:55.192Z',
        status: 'retired' as const,
      }],
    };
    const recover = (candidate: {
      activeJobCount: number;
      employerCount: number;
      consecutiveWeeks: number;
      automaticPromotionEligible?: boolean;
    }) => buildAutomaticSectorHubPublicationRegistry({
      previous,
      report: {
        generatedAt: '2026-11-09T06:00:00.000Z',
        week: '2026-W46',
        candidates: [{
          label: 'Tecnica',
          suggestedSlug: 'tecnica',
          sourceLocale: 'it',
          labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'techniques' },
          automaticPromotionEligible: candidate.automaticPromotionEligible ?? true,
          sourceFields: ['category'],
          alternateLabels: [],
          activeJobCount: candidate.activeJobCount,
          employerCount: candidate.employerCount,
          activeJobsWithViews: candidate.activeJobCount,
          viewsPerLiveDay: 1,
          ga4Sessions28d: 0,
          gscJobPageImpressions28d: 0,
          consecutiveWeeks: candidate.consecutiveWeeks,
          status: 'eligible-for-publication',
          slugConflict: false,
        }],
      },
    }).hubs[0];

    expect(recover({ activeJobCount: 7, employerCount: 3, consecutiveWeeks: 3 }).status).toBe('retired');
    expect(recover({ activeJobCount: 8, employerCount: 3, consecutiveWeeks: 1 }).status).toBe('retired');
    expect(recover({ activeJobCount: 8, employerCount: 3, consecutiveWeeks: 2 }).status).toBe('active');
    expect(recover({ activeJobCount: 43, employerCount: 10, consecutiveWeeks: 2 })?.labelByLocale)
      .toEqual({ it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'techniques' });
  });

  it('keeps explicit owner retirements locked even when inventory and traffic gates recover', () => {
    const previous = {
      schemaVersion: 1 as const,
      generatedAt: '2026-10-30T21:53:11.196Z',
      sourceWeek: '2026-W44',
      hubs: [{
        slug: 'tecnica',
        routeKind: 'dynamic' as const,
        label: 'Tecnica',
        labelByLocale: { it: 'Tecnica' },
        sourceFields: ['category' as const],
        matchLabels: ['Tecnica'],
        firstPublishedAt: '2026-10-20T08:22:55.192Z',
        status: 'retired' as const,
        retirementReason: 'Owner decision: duplicate of another dedicated hub.',
      }],
    };
    const registry = buildAutomaticSectorHubPublicationRegistry({
      previous,
      report: {
        generatedAt: '2026-11-09T06:00:00.000Z',
        week: '2026-W46',
        candidates: [{
          label: 'Tecnica',
          suggestedSlug: 'tecnica',
          sourceLocale: 'it',
          labelByLocale: { it: 'Tecnica' },
          automaticPromotionEligible: true,
          sourceFields: ['category'],
          alternateLabels: [],
          activeJobCount: 43,
          employerCount: 10,
          activeJobsWithViews: 43,
          viewsPerLiveDay: 1,
          ga4Sessions28d: 10,
          gscJobPageImpressions28d: 100,
          consecutiveWeeks: 20,
          status: 'eligible-for-publication',
          slugConflict: false,
        }],
      },
    });

    expect(registry.hubs[0]).toMatchObject({
      status: 'retired',
      retirementReason: 'Owner decision: duplicate of another dedicated hub.',
    });
  });

  it('emits recovered locale pages, sitemap alternates, build log and sector-directory links', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sector-hub-recovery-'));
    const distDir = path.join(rootDir, 'dist');
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const publication = {
      slug: 'tecnica',
      routeKind: 'dynamic' as const,
      label: 'Tecnica',
      labelByLocale: { it: 'Tecnica', en: 'Technical', de: 'Technik', fr: 'techniques' },
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
        expect(listIndexableAutoSectorHubLinks(inventory, locale)).toContainEqual({
          slug: 'tecnica',
          href: buildAutoSectorHubPath(locale, 'tecnica'),
          label: publication.labelByLocale[locale],
        });
      }

      const plugin = autoSectorHubPagesPlugin(rootDir);
      if (typeof plugin.closeBundle !== 'function') throw new Error('Expected closeBundle handler.');
      const closeBundle = plugin.closeBundle as () => Promise<void>;
      await closeBundle();

      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const localePath = buildAutoSectorHubPath(locale, 'tecnica');
        const html = fs.readFileSync(path.join(distDir, localePath.slice(1), 'index.html'), 'utf-8');
        const canonical = html.match(/<link rel=canonical href="([^"]+)"/)?.[1];
        const robots = html.match(/<meta name=robots content="([^"]+)"/)?.[1];
        expect(html).not.toContain(AUTO_SECTOR_HUB_NOINDEX_TARGET_MARKER);
        expect(robots).toBeDefined();
        expect(robots).not.toMatch(/noindex/i);
        expect(canonical).toBe(`${BASE_URL}${localePath}`);
        for (const alternateLocale of ['it', 'en', 'de', 'fr'] as const) {
          expect(html).toContain(`${BASE_URL}${buildAutoSectorHubPath(alternateLocale, 'tecnica')}`);
        }
      }
      const sitemap = fs.readFileSync(path.join(distDir, 'sitemap-auto-sector-hubs.xml'), 'utf-8');
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(sitemap).toContain(`<loc>${BASE_URL}${buildAutoSectorHubPath(locale, 'tecnica')}</loc>`);
        expect(sitemap).toContain(`hreflang="${locale}"`);
      }
      expect(log.mock.calls.flat().join('\n')).toContain('automatically reactivated 1 retired hub(s): tecnica (43 offers, 10 employers)');
    } finally {
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
