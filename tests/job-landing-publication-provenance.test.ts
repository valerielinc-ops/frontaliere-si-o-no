import { describe, expect, it } from 'vitest';
import { buildJobTodayLandingModel } from '../build-plugins/jobEditorialLanding';
import { buildJobRecencyLandingModel } from '../build-plugins/jobRecencyLanding';
import { buildJobIntentLandingModel } from '../build-plugins/jobIntentLanding';

const now = new Date();
const recent = new Date(now.getTime() - 2 * 3600000).toISOString();
const future = new Date(now.getTime() + 86400000).toISOString();
const records = [
  { slug: 'unknown', postingDateSource: 'unknown', postedDate: recent, datePosted: recent },
  { slug: 'invalid-reported', postingDateSource: 'reported', postedDate: future, datePosted: future },
  { slug: 'reported', postingDateSource: 'reported', postedDate: recent, datePosted: recent },
  { slug: 'legacy', postingDateSource: undefined, postedDate: now.toISOString(), datePosted: now.toISOString() },
].map((job) => ({ ...job, title: 'Customer support Deutsch Teilzeit 50%', company: 'Example SA', location: 'Lugano', canton: 'TI', contract: 'part-time', crawledAt: now.toISOString(), updatedAt: now.toISOString() }));

describe('publication provenance in editorial and intent landing models', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s preserves mixed provenance without promoting observations into publication', (locale) => {
    const options = { jobs: records, locale, now, localizedSlug: (job: Record<string, unknown>) => String(job.slug), baseUrl: 'https://frontaliereticino.ch', sectionSlug: 'cerca-lavoro-ticino', localePrefix: locale === 'it' ? '' : `/${locale}` };
    for (const variant of ['last-3-days', 'since-yesterday'] as const) {
      const recency = buildJobRecencyLandingModel({ ...options, variant, maxJobs: 1 });
      expect(recency.totalJobs).toBe(1);
      expect(recency.jobs).toHaveLength(1);
      expect(recency.jobs[0].href).toContain('/reported/');
    }
    const editorial = buildJobTodayLandingModel(options);
    expect(editorial.sections.last24Hours.jobs.map((job) => job.href.split('/').at(-2))).toEqual(['reported']);
    expect(editorial.sections.last3Days.jobs).toHaveLength(1);
    const intent = buildJobIntentLandingModel({ ...options, intentKey: 'german-speaking' });
    for (const feed of [editorial.sections.partTime.jobs, intent.feed.jobs]) {
      expect(feed).toHaveLength(4);
      expect(feed.slice(0, 1).map((job) => job.href.split('/').at(-2))).toEqual(['reported']);
      for (const slug of ['unknown', 'invalid-reported', 'legacy']) {
        const item = feed.find((job) => job.href.endsWith(`/${slug}/`));
        expect(item).toBeTruthy();
        expect(item!.datePosted).toBeUndefined();
        expect(item!.postingDateSource).toBe(slug === 'legacy' ? undefined : slug === 'unknown' ? 'unknown' : 'reported');
      }
      expect(feed.find((job) => job.href.endsWith('/reported/'))?.datePosted).toBe(recent);
      expect(feed.find((job) => job.href.endsWith('/legacy/'))?.postingDateSource).toBeUndefined();
    }
  });
});
