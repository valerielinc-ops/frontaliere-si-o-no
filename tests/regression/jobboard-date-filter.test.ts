import { describe, expect, it } from 'vitest';
import {
  isJobNewAt,
  isJobWithinDateRange,
  normalizeIncomingJob,
} from '../../components/community/JobBoard';
import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import { resolveRolloutSchemaPostingDate } from '../../scripts/lib/job-posting-date-rollout.mjs';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

describe('JobBoard date filters', () => {
  it('excludes a listing published 18 days ago even when it was crawled recently', () => {
    const recrawledOldListing = {
      postingDateSource: 'reported',
      postedDate: '2026-08-28',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    };

    expect(isJobWithinDateRange(recrawledOldListing, NOW - SEVEN_DAYS)).toBe(false);
  });

  it('does not use firstSeenAt as publication when the source date is missing', () => {
    const discoveredOldListing = {
      postedDate: '',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    };

    expect(isJobWithinDateRange(discoveredOldListing, NOW - SEVEN_DAYS)).toBe(false);
  });

  it('uses firstSeenAt for display while preserving date-filter semantics', () => {
    const normalized = normalizeIncomingJob({
      id: 'old-undated-listing',
      title: 'Old listing',
      description: 'Description',
      postedDate: '',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    });

    expect(normalized.postedDate).toBe('');
    expect(normalized.datePosted).toBeUndefined();
    expect(normalized.displayPostingDate).toBe('2026-08-28T05:27:13.245Z');
    expect(normalized.firstSeenAt).toBe('2026-08-28T05:27:13.245Z');
  });

  it('preserves the original reported datePosted when firstSeenAt is also present', () => {
    const normalized = normalizeIncomingJob({
      id: 'reported-with-first-seen',
      title: 'Reported listing',
      postingDateSource: 'reported',
      datePosted: '2026-09-01',
      postedDate: '',
      firstSeenAt: '2026-09-10T05:27:13.245Z',
    });

    expect(normalized.datePosted).toBe('2026-09-01');
    expect(normalized.postedDate).toBe('');
    expect(normalized.displayPostingDate).toBe('2026-09-01');
    expect(normalized.firstSeenAt).toBe('2026-09-10T05:27:13.245Z');
  });

  it('keeps invalid reported aliases out of publication provenance', () => {
    const normalized = normalizeIncomingJob({
      postingDateSource: 'reported',
      datePosted: 'bad',
      postedDate: 'bad',
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    const now = new Date('2026-01-02T00:00:00Z');

    expect(normalized.datePosted).toBe('bad');
    expect(normalized.postedDate).toBe('bad');
    expect(normalized.displayPostingDate).toBe('2026-01-01T00:00:00Z');
    expect(resolveReportedPostingDate(normalized, now)).toBeNull();
    expect(resolveRolloutSchemaPostingDate(normalized, now)).toEqual({
      value: '2026-01-01T00:00:00Z',
      provenance: 'first-seen',
    });
  });

  it.each(['unknown', 'reported', undefined] as const)('normalizes mixed provenance %s without promoting collection clocks', (postingDateSource) => {
    const datePosted = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const firstSeenAt = new Date(Date.now() - 86400000).toISOString();
    const normalized = normalizeIncomingJob({
      id: 'publication-migration', title: 'Infermiere', description: 'Assistenza sanitaria',
      postingDateSource, datePosted: postingDateSource === 'reported' ? datePosted : '',
      postedDate: '', firstSeenAt, crawledAt: new Date().toISOString(),
    });
    expect(normalized.postingDateSource).toBe(postingDateSource);
    expect(isJobWithinDateRange(normalized, Date.now() - 7 * 86400000)).toBe(postingDateSource === 'reported');
    expect(normalized.postedDate).toBe('');
    expect(normalized.datePosted).toBe(postingDateSource === 'reported' ? datePosted : '');
    expect(normalized.displayPostingDate).toBe(postingDateSource === 'reported' ? datePosted : firstSeenAt);
  });

  it.each([undefined, 'unknown', 'reported'] as const)('separates first observation from publication for %s', (postingDateSource) => {
    const firstSeenAt = new Date(Date.now() - 3600000).toISOString();
    const record = { postingDateSource, firstSeenAt, postedDate: firstSeenAt };
    expect(isJobWithinDateRange(record, Date.now() - SEVEN_DAYS)).toBe(postingDateSource === 'reported');
    expect(isJobWithinDateRange(record, 0)).toBe(true);
    expect(isJobNewAt(record, Date.now())).toBe(true);
    expect(isJobNewAt({ postingDateSource, postedDate: firstSeenAt }, Date.now())).toBe(false);
  });

  it('defines “new” from firstSeenAt, not from a later recrawl', () => {
    const recrawledOldListing = {
      postedDate: '2026-08-28',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-15T11:00:00.000Z',
    };

    expect(isJobNewAt(recrawledOldListing, NOW)).toBe(false);
  });
});
