import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOB_ALERT_LOOKBACK_MS,
  isOpenJobAlertJob,
  jobInventoryTimestampMs,
  resolveJobAlertCursor,
  selectJobAlertCandidates,
} from '../scripts/lib/job-alert-newness.mjs';

const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function job(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    firstSeenAt: new Date(NOW - 10 * DAY).toISOString(),
    crawledAt: new Date(NOW - DAY).toISOString(),
    active: true,
    status: 'open',
    ...overrides,
  };
}

describe('JobAlert candidate window', () => {
  it('uses the recipient last send as the catch-up cursor, not a fixed 24h window', () => {
    const result = selectJobAlertCandidates([
      job('before', { crawledAt: new Date(NOW - 8 * DAY).toISOString() }),
      job('inside', { crawledAt: new Date(NOW - 6 * DAY).toISOString() }),
      job('today', { crawledAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }),
    ], {
      recipientLastSentAt: new Date(NOW - 7 * DAY).toISOString(),
      alertCreatedAt: new Date(NOW - 30 * DAY).toISOString(),
      nowMs: NOW,
    });

    expect(result.reason).toBe('recipient-last-sent');
    expect(result.jobs.map((item) => item.id)).toEqual(['inside', 'today']);
    expect(result.cursorMs).toBe(NOW - 7 * DAY);
  });

  it('does not mistake a recrawl for a newly published job', () => {
    const result = selectJobAlertCandidates([
      job('recrawled-old', {
        firstSeenAt: new Date(NOW - 30 * DAY).toISOString(),
        crawledAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      }),
    ], {
      recipientLastSentAt: new Date(NOW - 7 * DAY).toISOString(),
      nowMs: NOW,
    });

    expect(result.jobs.map((item) => item.id)).toEqual(['recrawled-old']);
    // The candidate is valid catch-up work, but the sender's existing freshness
    // predicate must still keep it out of NEW copy/badge treatment.
    expect(Date.parse(String(result.jobs[0].firstSeenAt))).toBeLessThan(NOW - 7 * DAY);
  });

  it('starts a new alert at creation time and never sends the whole history', () => {
    const result = selectJobAlertCandidates([
      job('before-subscription', { crawledAt: new Date(NOW - 2 * DAY).toISOString() }),
      job('after-subscription', { crawledAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }),
    ], {
      alertCreatedAt: new Date(NOW - 12 * 60 * 60 * 1000).toISOString(),
      nowMs: NOW,
    });

    expect(result.reason).toBe('alert-created');
    expect(result.jobs.map((item) => item.id)).toEqual(['after-subscription']);
  });

  it('fails closed on a future cursor and does not fall back to historical jobs', () => {
    const result = selectJobAlertCandidates([
      job('old', { crawledAt: new Date(NOW - DAY).toISOString() }),
    ], {
      recipientLastSentAt: new Date(NOW + DAY).toISOString(),
      nowMs: NOW,
    });

    expect(result.reason).toBe('future-last-sent');
    expect(result.jobs).toEqual([]);
  });

  it('excludes explicitly closed or expired jobs before matching', () => {
    const result = selectJobAlertCandidates([
      job('closed', { status: 'expired' }),
      job('inactive', { active: false }),
      job('past-valid-through', { validThrough: new Date(NOW - 1).toISOString() }),
      job('open'),
    ], {
      recipientLastSentAt: new Date(NOW - 2 * DAY).toISOString(),
      nowMs: NOW,
    });

    expect(result.jobs.map((item) => item.id)).toEqual(['open']);
    expect(result.excluded.closed).toBe(3);
  });

  it('uses compatibility fallbacks only for legacy rows with no crawledAt', () => {
    expect(jobInventoryTimestampMs({ postedDate: '2026-09-20' })).toBe(Date.parse('2026-09-20'));
    expect(jobInventoryTimestampMs({ firstSeenAt: '2026-09-20T00:00:00Z' })).toBe(Date.parse('2026-09-20T00:00:00Z'));
    expect(jobInventoryTimestampMs({})).toBe(0);
  });

  it('keeps the initial lookback explicit and accepts timestamp-like values', () => {
    const cursor = resolveJobAlertCursor({ nowMs: NOW });
    expect(cursor.reason).toBe('initial-lookback');
    expect(cursor.cursorMs).toBe(NOW - DEFAULT_JOB_ALERT_LOOKBACK_MS);
    expect(resolveJobAlertCursor({
      recipientLastSentAt: { toMillis: () => NOW - 3 * DAY },
      nowMs: NOW,
    }).cursorMs).toBe(NOW - 3 * DAY);
  });

  it('treats missing expiry metadata as open for legacy crawler rows', () => {
    expect(isOpenJobAlertJob(job('legacy'), NOW)).toBe(true);
  });

  it('treats a date-only validThrough as inclusive through that UTC day', () => {
    expect(isOpenJobAlertJob(job('deadline-today', { validThrough: '2026-09-21' }), NOW)).toBe(true);
    expect(isOpenJobAlertJob(job('deadline-yesterday', { validThrough: '2026-09-20' }), NOW)).toBe(false);
  });

  it('quarantines an explicit malformed expiry instead of treating it as open', () => {
    expect(isOpenJobAlertJob(job('bad-expiry', { validThrough: 'not-a-date' }), NOW)).toBe(false);
  });
});
