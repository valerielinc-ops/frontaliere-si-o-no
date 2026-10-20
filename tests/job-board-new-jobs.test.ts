import { describe, expect, it } from 'vitest';
import {
  filterJobsNewSinceVisit,
  getJobBoardNewnessTimestampMs,
  hasJobBoardAlertOpenRequest,
  isJobBoardNewSinceVisit,
} from '@/services/jobBoardNewJobs';

const LAST_VISIT = Date.parse('2026-10-19T10:00:00.000Z');
const NOW = Date.parse('2026-10-20T10:00:00.000Z');

describe('job board return-visit newness', () => {
  it('uses the same firstSeenAt, crawledAt, postedDate precedence as the counter', () => {
    expect(getJobBoardNewnessTimestampMs({
      firstSeenAt: '2026-10-19T11:00:00.000Z',
      crawledAt: '2026-10-18T11:00:00.000Z',
      postedDate: '2026-10-17T11:00:00.000Z',
    })).toBe(Date.parse('2026-10-19T11:00:00.000Z'));
    expect(getJobBoardNewnessTimestampMs({
      firstSeenAt: '',
      crawledAt: '2026-10-19T12:00:00.000Z',
      postedDate: '2026-10-17T11:00:00.000Z',
    })).toBe(Date.parse('2026-10-19T12:00:00.000Z'));
    expect(getJobBoardNewnessTimestampMs({
      firstSeenAt: 'not-a-date',
      crawledAt: '2026-10-19T12:00:00.000Z',
      postedDate: '2026-10-17T11:00:00.000Z',
    })).toBeNull();
  });

  it('rejects old, boundary-equal, invalid and future timestamps', () => {
    expect(isJobBoardNewSinceVisit({ firstSeenAt: '2026-10-19T09:59:59.999Z' }, LAST_VISIT, NOW)).toBe(false);
    expect(isJobBoardNewSinceVisit({ firstSeenAt: '2026-10-19T10:00:00.000Z' }, LAST_VISIT, NOW)).toBe(false);
    expect(isJobBoardNewSinceVisit({ firstSeenAt: 'not-a-date' }, LAST_VISIT, NOW)).toBe(false);
    expect(isJobBoardNewSinceVisit({ firstSeenAt: '2026-10-20T10:00:00.001Z' }, LAST_VISIT, NOW)).toBe(false);
    expect(isJobBoardNewSinceVisit({ firstSeenAt: '2026-10-20T09:00:00.000Z' }, NOW + 1, NOW)).toBe(false);
  });

  it('counts only new jobs inside the already-filtered context', () => {
    const contextResults = [
      { id: 'nurse-lugano-part-time-new', firstSeenAt: '2026-10-20T09:00:00.000Z' },
      { id: 'nurse-lugano-part-time-old', firstSeenAt: '2026-10-19T09:00:00.000Z' },
    ];
    expect(filterJobsNewSinceVisit(contextResults, LAST_VISIT, NOW).map((job) => job.id))
      .toEqual(['nurse-lugano-part-time-new']);
  });
});

describe('job-board alert open query', () => {
  it('uses alert=1 in the query even when the URL hash is absent', () => {
    expect(hasJobBoardAlertOpenRequest('?q=infermiere&alert=1')).toBe(true);
    expect(hasJobBoardAlertOpenRequest('q=infermiere&alert=1')).toBe(true);
    expect(hasJobBoardAlertOpenRequest('?q=infermiere&alert=0')).toBe(false);
    expect(hasJobBoardAlertOpenRequest('?q=infermiere#job-alert-form')).toBe(false);
  });
});
