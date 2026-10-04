import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_FACILITIES } from '../build-plugins/healthFacilitiesData';
import { aggregateHealthFacilityJobs, _resetHealthFacilityJobsAggregateCache } from '../build-plugins/healthFacilitiesJobsAggregate';
import { renderFacilityPage } from '../build-plugins/healthFacilitiesPlugin';
import { describe, expect, it } from 'vitest';
import { resolveReportedPostingDate } from '../scripts/lib/job-posting-date.mjs';
import { buildJobPostingFacts, buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { buildJobPostingFaqPairs } from '../build-plugins/shared/jobPostingFaq';
import { buildLocaleJobSlim, buildLocaleJob } from '../build-plugins/shared/slimJobIndex';

const now = new Date();
const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
const options = { locale: 'it', url: 'https://frontaliereticino.ch/jobs/example/', now };
const job = { company: 'Example SA', title: 'Infermiere', location: 'Lugano', postedDate: yesterday };

describe('employer publication date provenance', () => {
  it.each([undefined, 'unknown', 'existing', 'scraped'])('keeps %s out of reported publication dates', (postingDateSource) => {
    expect(resolveReportedPostingDate({ ...job, postingDateSource }, now)).toBeNull();
    if (postingDateSource === 'unknown') {
      const schema = buildJobPostingSchema({ ...job, postingDateSource }, options);
      expect(schema?.datePosted).toBe(now.toISOString());
    } else if (postingDateSource !== undefined) {
      expect(buildJobPostingSchema({ ...job, postingDateSource }, options)).toBeNull();
    }
  });
  it('uses a collection clock only as the schema fallback for unknown provenance', () => {
    const schema = buildJobPostingSchema({ ...job, postingDateSource: 'unknown', crawledAt: yesterday }, options);
    expect(schema?.datePosted).toBe(new Date(yesterday).toISOString());
  });
  it('preserves legacy behavior only during the measured migration', () => {
    expect(resolveReportedPostingDate(job, now)).toBeNull();
    expect(buildJobPostingSchema(job, options)?.datePosted).toBe(new Date(yesterday).toISOString());
    expect(buildJobPostingSchema({}, options)?.datePosted).toBe(now.toISOString());
    expect(buildJobPostingSchema({ postingDateSource: null }, options)?.datePosted).toBe(now.toISOString());
  });
  it.each(['', 'not-a-date', '2025-02-29', '2024-04-31', '2024-01-01T24:00:00Z'])('rejects invalid reported date %s', (postedDate) => {
    expect(resolveReportedPostingDate({ postedDate, postingDateSource: 'reported' }, now)).toBeNull();
  });
  it('rejects future publication and never substitutes collection timestamps', () => {
    const tomorrow = new Date(now.getTime() + 86400000).toISOString();
    expect(buildJobPostingSchema({ ...job, postingDateSource: 'reported', postedDate: tomorrow, crawledAt: yesterday, scrapedAt: yesterday }, options)).toBeNull();
    expect(buildJobPostingSchema({ postingDateSource: 'reported', crawledAt: yesterday }, options)).toBeNull();
  });
  it('preserves a verified original date and emits all mandatory schema properties', () => {
    const schema = buildJobPostingSchema({ ...job, postingDateSource: 'reported' }, options);
    expect(schema).not.toBeNull();
    expect(schema?.datePosted).toBe(yesterday);
    expect(schema?.['@type']).toBe('JobPosting');
    expect(schema?.jobLocation.address.postalCode).toBeTruthy();
    expect(schema?.baseSalary.value.minValue).toBeGreaterThan(0);
  });
  it('keeps presentation FAQ available without manufacturing a JobPosting', () => {
    const facts = buildJobPostingFacts(job, 'it');
    expect(facts).not.toHaveProperty('datePosted');
    expect(facts).not.toHaveProperty('@type');
    expect(buildJobPostingFaqPairs(facts, { locale: 'it', jobUrl: options.url, cantonDisplay: 'Ticino', isTicino: true })).toHaveLength(4);
  });
  it('retains explicit provenance in locale payloads and slim hydration records', () => {
    const localized = buildLocaleJob({ ...job, postingDateSource: 'reported' }, 'it');
    expect(localized.postingDateSource).toBe('reported');
    expect(buildLocaleJobSlim(localized).postingDateSource).toBe('reported');
  });
  it.each(['reported', 'invalid-reported', 'unknown', 'legacy'] as const)('preserves publication provenance %s through healthcare aggregation and cards', (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'publication-date-'));
    try {
      mkdirSync(join(root, 'data'));
      const facility = HEALTH_FACILITIES.find((entry) => entry.companyKeys.length > 0)!;
      const today = now.toISOString().slice(0, 10);
      writeFileSync(join(root, 'data/jobs.json'), JSON.stringify([{
        id: 'reported-health-date', slug: 'reported-health-date', title: 'Infermiere diplomato',
        company: facility.name, companyKey: facility.companyKeys[0], canton: facility.canton,
        addressLocality: facility.city, postingDateSource: kind === 'legacy' ? undefined : kind === 'unknown' ? 'unknown' : 'reported',
        datePosted: kind === 'reported' ? yesterday : undefined,
        firstSeenAt: now.toISOString(),
      }]));
      const snapshot = aggregateHealthFacilityJobs(root).get(facility.slug)!;
      expect(snapshot.featured[0]?.datePosted).toBe(kind === 'reported' ? yesterday : kind === 'unknown' ? now.toISOString() : null);
      expect(snapshot.featured[0]?.postingDateSource).toBe(kind === 'legacy' ? undefined : kind === 'unknown' ? 'unknown' : 'reported');
      if (kind === 'invalid-reported' || kind === 'unknown') expect(snapshot.featured[0]?.postedDate).toBe('');
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const html = renderFacilityPage(locale, facility, snapshot, today, root).html;
        if (kind === 'reported') expect(html).toMatch(new RegExp(`data-posted=["']?${yesterday}`));
        if (kind === 'legacy') expect(html).toMatch(new RegExp(`data-posted=["']?${today}`));
        else expect(html).not.toMatch(new RegExp(`data-posted=["']?${today}`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      _resetHealthFacilityJobsAggregateCache();
    }
  });

});
