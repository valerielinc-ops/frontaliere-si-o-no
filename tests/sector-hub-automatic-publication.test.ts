import { describe, expect, it } from 'vitest';
import {
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
import { buildAutoSectorHubPage } from '../build-plugins/autoSectorHubPagesPlugin';
import { SECTOR_HUB_SECTION } from '../build-plugins/shared/jobSectorPaths';

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
      expect(page.html).toContain('"@type":"BreadcrumbList"');
    }
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
