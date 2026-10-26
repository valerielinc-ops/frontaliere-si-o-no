import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_FACILITIES } from '../build-plugins/healthFacilitiesData';
import { aggregateHealthFacilityJobs, _resetHealthFacilityJobsAggregateCache } from '../build-plugins/healthFacilitiesJobsAggregate';
import { renderFacilityPage } from '../build-plugins/healthFacilitiesPlugin';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveFirstSeenPostingDate,
  resolveObservedPostingDate,
  resolveReportedPostingDate,
  resolveSchemaPostingDate,
} from '../scripts/lib/job-posting-date.mjs';
import { buildJobPostingFacts, buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { buildJobPostingFaqPairs } from '../build-plugins/shared/jobPostingFaq';
import { buildLocaleJobSlim, buildLocaleJob } from '../build-plugins/shared/slimJobIndex';

import { resolveRolloutPostingDate } from '../scripts/lib/job-posting-date-rollout.mjs';

const now = new Date();
const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
const today = now.toISOString().slice(0, 10);
const options = { locale: 'it', url: 'https://frontaliereticino.ch/jobs/example/', now };
const job = { company: 'Example SA', title: 'Infermiere', location: 'Lugano', postedDate: yesterday };

describe('employer publication date provenance', () => {
  it.each([undefined, null, 'unknown', 'existing', 'reported'] as const)('never evaluates the former legacy fallback for %s', (postingDateSource) => {
    const legacyDate = vi.fn(() => now.toISOString());
    const input = { ...job, postingDateSource };
    expect(resolveRolloutPostingDate(input, legacyDate, now)).toBe(postingDateSource === 'reported' ? yesterday : null);
    expect(legacyDate).not.toHaveBeenCalled();
  });
  it('never returns null: a record without any timestamp gets the build date', () => {
    expect(resolveSchemaPostingDate({ postingDateSource: 'unknown' }, now)).toEqual({
      value: today,
      provenance: 'build-clock',
    });
  });
  it.each([undefined, 'unknown', 'existing', 'scraped'])('never treats %s provenance as a reported date, yet still emits JobPosting', (postingDateSource) => {
    expect(resolveReportedPostingDate({ ...job, postingDateSource }, now)).toBeNull();
    const schema = buildJobPostingSchema({ ...job, postingDateSource }, options);
    expect(schema['@type']).toBe('JobPosting');
    expect(schema.datePosted).toBe(today);
  });
  it('uses firstSeenAt as a synthetic fallback while preserving a reported date', () => {
    const firstSeenAt = new Date(now.getTime() - 3 * 86400000).toISOString();
    expect(resolveFirstSeenPostingDate({ firstSeenAt }, now)).toBe(firstSeenAt);
    expect(resolveRolloutPostingDate({ ...job, postingDateSource: 'unknown', firstSeenAt }, vi.fn(), now)).toBe(firstSeenAt);
    expect(buildJobPostingSchema({ ...job, postingDateSource: 'unknown', firstSeenAt }, options)?.datePosted).toBe(firstSeenAt);
    expect(resolveRolloutPostingDate({ ...job, postingDateSource: 'reported', firstSeenAt }, vi.fn(), now)).toBe(yesterday);
    expect(buildJobPostingSchema({ ...job, postingDateSource: 'reported', firstSeenAt }, options)?.datePosted).toBe(yesterday);
  });
  it.each([undefined, null, 'unknown'])('falls back to the earliest crawler observation without firstSeenAt for %s', (postingDateSource) => {
    const older = new Date(now.getTime() - 5 * 86400000).toISOString();
    for (const clocks of [{ crawledAt: yesterday }, { scrapedAt: yesterday }, { updatedAt: yesterday }]) {
      expect(buildJobPostingSchema({ ...job, postingDateSource, ...clocks }, options).datePosted).toBe(yesterday);
      expect(buildJobPostingSchema({ postingDateSource, ...clocks }, options).datePosted).toBe(yesterday);
    }
    expect(resolveObservedPostingDate({ crawledAt: yesterday, scrapedAt: older }, now)).toBe(older);
    expect(resolveSchemaPostingDate({ postingDateSource, crawledAt: older }, now)).toEqual({ value: older, provenance: 'observed' });
  });
  it.each(['', 'not-a-date', '2025-02-29', '2024-04-31', '2024-01-01T24:00:00Z'])('rejects invalid firstSeenAt %s without dropping the schema', (firstSeenAt) => {
    expect(resolveFirstSeenPostingDate({ firstSeenAt }, now)).toBeNull();
    const schema = buildJobPostingSchema({ ...job, postingDateSource: 'unknown', firstSeenAt, crawledAt: yesterday }, options);
    expect(schema.datePosted).toBe(yesterday);
  });
  it.each(['', 'not-a-date', '2025-02-29', '2024-04-31', '2024-01-01T24:00:00Z'])('rejects invalid reported date %s', (postedDate) => {
    expect(resolveReportedPostingDate({ postedDate, postingDateSource: 'reported' }, now)).toBeNull();
  });
  it('rejects a future publication date and falls back to the observation, never to the future value', () => {
    const tomorrow = new Date(now.getTime() + 86400000).toISOString();
    expect(buildJobPostingSchema({ ...job, postingDateSource: 'reported', postedDate: tomorrow, crawledAt: yesterday, scrapedAt: yesterday }, options).datePosted).toBe(yesterday);
    expect(buildJobPostingSchema({ postingDateSource: 'reported', crawledAt: yesterday }, options).datePosted).toBe(yesterday);
    expect(resolveSchemaPostingDate({ postingDateSource: 'reported', postedDate: tomorrow, crawledAt: tomorrow }, now)).toEqual({ value: today, provenance: 'build-clock' });
  });
  it('preserves a verified original date and emits the required schema properties', () => {
    const schema = buildJobPostingSchema({ ...job, postingDateSource: 'reported' }, options);
    expect(schema).not.toBeNull();
    expect(schema?.datePosted).toBe(yesterday);
    expect(schema?.['@type']).toBe('JobPosting');
    expect(schema?.jobLocation.address.addressLocality).toBe('Lugano');
    // Missing non-critical values are filled by the canonical contract.
    expect(schema?.jobLocation.address.postalCode).toBe('6900');
    expect(schema?.jobLocation.address.streetAddress).toBe('Piazza Riforma 1');
    expect(schema?.baseSalary?.value.minValue).toBeGreaterThan(0);
    expect(schema?.employmentType).toBe('FULL_TIME');
    expect(schema?.validThrough).toBeTruthy();
  });
  it('keeps presentation FAQ facts separate from the JobPosting date', () => {
    const facts = buildJobPostingFacts(job, 'it');
    expect(facts).not.toHaveProperty('datePosted');
    expect(facts).not.toHaveProperty('@type');
    expect(buildJobPostingFaqPairs(facts, { locale: 'it', jobUrl: options.url, cantonDisplay: 'Ticino', isTicino: true })).toHaveLength(4);
    expect(buildJobPostingSchema(job, options)['@type']).toBe('JobPosting');
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
      expect(snapshot.featured[0]?.datePosted).toBe(kind === 'reported' ? yesterday : null);
      expect(snapshot.featured[0]?.postingDateSource).toBe(kind === 'legacy' ? undefined : kind === 'unknown' ? 'unknown' : 'reported');
      if (kind !== 'reported') {
        expect(snapshot.featured[0]?.postedDate).toBe('');
        expect(snapshot.featured[0]?.firstSeenAt).toBe(now.toISOString());
      }
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const html = renderFacilityPage(locale, facility, snapshot, today, root).html;
        if (kind === 'reported') expect(html).toMatch(new RegExp(`data-posted=["']?${yesterday}`));
        if (kind !== 'reported') expect(html).toMatch(new RegExp(`data-posted=["']?${today}`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      _resetHealthFacilityJobsAggregateCache();
    }
  });

});
