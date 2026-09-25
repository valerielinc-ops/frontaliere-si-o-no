import { describe, expect, it } from 'vitest';
import {
  isJobNewAt,
  isJobWithinDateRange,
  normalizeIncomingJob,
} from '../../components/community/JobBoard';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

describe('JobBoard date filters', () => {
  it('excludes a listing published 18 days ago even when it was crawled recently', () => {
    const recrawledOldListing = {
      postedDate: '2026-08-28',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    };

    expect(isJobWithinDateRange(recrawledOldListing, NOW - SEVEN_DAYS)).toBe(false);
  });

  it('uses firstSeenAt when the source has no publication date', () => {
    const discoveredOldListing = {
      postedDate: '',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    };

    expect(isJobWithinDateRange(discoveredOldListing, NOW - SEVEN_DAYS)).toBe(false);
  });

  it('normalizes a missing publication date from firstSeenAt, not from the recrawl date', () => {
    const normalized = normalizeIncomingJob({
      id: 'old-undated-listing',
      title: 'Old listing',
      description: 'Description',
      postedDate: '',
      firstSeenAt: '2026-08-28T05:27:13.245Z',
      crawledAt: '2026-09-13T14:02:16.761Z',
    });

    expect(normalized.postedDate).toBe('2026-08-28T05:27:13.245Z');
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
