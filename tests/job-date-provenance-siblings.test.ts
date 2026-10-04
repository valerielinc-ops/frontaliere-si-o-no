import { aggregateProfessionJobs, _resetProfessionJobsAggregateCache } from '../build-plugins/professionJobsAggregate';
import { aggregateNursingJobs, _resetNursingJobsAggregateCache } from '../build-plugins/nursingJobsAggregate';
import { aggregateCityJobs, _resetCityJobsAggregateCache } from '../build-plugins/cityJobsAggregate';
import { aggregateCareerLandings, _resetCareerJobsAggregateCache } from '../build-plugins/careerJobsAggregate';
import { aggregateHealthFacilityJobs, _resetHealthFacilityJobsAggregateCache } from '../build-plugins/healthFacilitiesJobsAggregate';
import { HEALTH_FACILITIES } from '../build-plugins/healthFacilitiesData';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { buildCompanyCityStats, renderCompanyCityPage } from '../build-plugins/weeklyEmployersPlugin';
import { jobSectorPagesPlugin } from '../build-plugins/jobSectorPagesPlugin';
import { filterMatchingJobs } from '../build-plugins/orphanQueryData';
import { buildSectorHubPath, filterSectorJobs } from '../build-plugins/jobSectorLanding';

const locales = ['it', 'en', 'de', 'fr'] as const;
const yesterday = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const description = 'Assistenza infermieristica ai pazienti nel reparto clinico. '.repeat(14);
const jobs = Array.from({ length: 36 }, (_, i) => ({
  id: `date-sibling-${i}`, slug: `date-sibling-${i}`, title: 'Infermiere diplomato',
  titleByLocale: Object.fromEntries(locales.map((locale) => [locale, 'Infermiere diplomato'])),
  description, descriptionByLocale: Object.fromEntries(locales.map((locale) => [locale, description])),
  company: 'Example SA', companyKey: 'example-sa', location: 'Lugano', addressLocality: 'Lugano', canton: 'TI',
  postingDateSource: i < 15 ? 'unknown' : i < 30 ? 'reported' : undefined,
  // Five explicitly reported future dates must not become eligible by falling
  // back to the valid observation or by choosing a date-only build bound.
  datePosted: i >= 15 && i < 20 ? future : yesterday,
  postedDate: i >= 15 && i < 20 ? future : yesterday,
  firstSeenAt: yesterday,
}));

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'date-provenance-siblings-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/jobs.json'), JSON.stringify(jobs));
  return root;
}

describe('publication provenance through remaining listing consumers', () => {
  it('keeps unknown publication out of fresh counts and featured ordering in all five aggregate families', () => {
    const root = temporaryRoot();
    const facility = HEALTH_FACILITIES.find((item) => item.companyKeys.length > 0)!;
    expect(facility).toBeDefined();
    const records = jobs.map((job) => ({ ...job, companyKey: facility.companyKeys[0], employmentType: 'INTERN' }));
    writeFileSync(join(root, 'data/jobs.json'), JSON.stringify(records));
    try {
      const now = Date.now();
      const snapshots = [
        aggregateProfessionJobs(root, now).infermiere,
        aggregateNursingJobs(root, now).nurses,
        aggregateCityJobs(root, 'lugano', now),
        aggregateCareerLandings(root, now)['stage-lugano'],
        aggregateHealthFacilityJobs(root, now).get(facility.slug)!,
      ];
      for (const snapshot of snapshots) {
        expect(snapshot.liveCount).toBe(36);
        expect(snapshot.fresh30Count).toBe(16);
        expect(snapshot.featured.slice(0, 3).map((job) => job.id)).toEqual(['date-sibling-20', 'date-sibling-21', 'date-sibling-22']);
      }
    } finally {
      _resetProfessionJobsAggregateCache();
      _resetNursingJobsAggregateCache();
      _resetCityJobsAggregateCache();
      _resetCareerJobsAggregateCache();
      _resetHealthFacilityJobsAggregateCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(locales)('preserves explicit provenance through weekly aggregation and %s cards', (locale) => {
    const stats = buildCompanyCityStats({ city: 'lugano', companySlug: 'example-sa', employerKey: 'example-sa', locale, jobs, limitJobs: 100 });
    expect(stats).not.toBeNull();
    expect(stats!.activeJobs).toHaveLength(36);
    expect(stats!.activeJobs.filter((job) => job.postedDate)).toHaveLength(16);
    const html = renderCompanyCityPage({ locale, city: 'lugano', companySlug: 'example-sa', variant: 'current', weekNum: 1, year: new Date().getUTCFullYear(), stats: stats!, hasHistoricalDelta: false, canonicalPath: '/aziende-che-assumono/lugano/example-sa/settimana-corrente/', today: new Date(), indexable: true });
    const document = new JSDOM(html).window.document;
    expect(document.querySelectorAll('[data-posted]')).toHaveLength(16);
    for (const badge of document.querySelectorAll('[data-posted]')) expect(badge.getAttribute('data-posted')).toBe(yesterday.slice(0, 10));
  });

  it('does not let unknown or future dates displace verified listings in limited result slices', () => {
    const stats = buildCompanyCityStats({ city: 'lugano', companySlug: 'example-sa', employerKey: 'example-sa', locale: 'it', jobs, limitJobs: 3 });
    const sector = filterSectorJobs(jobs, 'infermieri', 'it', 3);
    const orphan = filterMatchingJobs(jobs, { clusterId: 'nurses', locale: 'it', canonicalQuery: 'infermiere lugano', canonicalSlug: 'infermiere-lugano', roleTokens: ['infermiere'], regionTokens: ['lugano'], totalImpressions: 100, totalClicks: 1, queries: [] }, 3);
    for (const result of [stats!.activeJobs, sector, orphan]) {
      expect(result).toHaveLength(3);
      expect(result.map((job) => job.slug)).toEqual(['date-sibling-20', 'date-sibling-21', 'date-sibling-22']);
    }
  });

  it('counts only eligible explicit dates plus transitional legacy in emitted sector freshness tiles', async () => {
    const root = temporaryRoot();
    try {
      const hook = jobSectorPagesPlugin(root).closeBundle;
      expect(typeof hook).toBe('function');
      await (hook as () => Promise<void>)();
      const labels = { it: 'Nuove · 7gg', en: 'New · 7d', de: 'Neu · 7T', fr: 'Récent · 7j' };
      for (const locale of locales) {
        const html = readFileSync(join(root, 'dist', buildSectorHubPath(locale, 'infermieri'), 'index.html'), 'utf8');
        const document = new JSDOM(html).window.document;
        const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent?.trim() === labels[locale]);
        expect(label).toBeTruthy();
        expect(label!.parentElement?.textContent).toContain('+16');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the marker in weekly snapshots and never stores an unknown publication as postedAt', () => {
    const root = temporaryRoot();
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      for (const file of ['snapshot-jobs-weekly.mjs', 'lib/job-posting-date.mjs', 'lib/job-posting-date-rollout.mjs']) {
        cpSync(join(process.cwd(), 'scripts', file), join(root, 'scripts', file));
      }
      execFileSync(process.execPath, [join(root, 'scripts/snapshot-jobs-weekly.mjs')], { encoding: 'utf8' });
      const dir = join(root, 'data/jobs-snapshots-history');
      const snapshot = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
      expect(snapshot.jobs).toHaveLength(36);
      expect(snapshot.jobs.filter((job: { postedAt?: string }) => job.postedAt)).toHaveLength(16);
      expect(snapshot.jobs.filter((job: { postingDateSource?: string }) => job.postingDateSource === 'unknown')).toHaveLength(15);
      expect(snapshot.jobs[35]).not.toHaveProperty('postingDateSource');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
