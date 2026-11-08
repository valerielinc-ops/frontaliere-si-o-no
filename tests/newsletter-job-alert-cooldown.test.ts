/**
 * The newsletter's job-alert cooldown must defer, not starve: daily job-alert
 * recipients always have a < 36h `last_sent_at`, so an unbounded cooldown kept
 * 520 eligible subscribers out of weekly_2026-09-28.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS,
  jobAlertCooldownApplies,
  loadRecentJobAlertCooldownEmails,
} from '../scripts/lib/newsletterJobAlertCooldown.mjs';

const HOUR = 60 * 60 * 1000;
const monday = Date.parse('2026-09-28T00:00:00Z');

describe('jobAlertCooldownApplies', () => {
  it('holds the cooldown during the deferral window of the campaign week', () => {
    expect(JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS).toBe(2);
    expect(jobAlertCooldownApplies({ campaignId: 'weekly_2026-09-28', nowMs: monday + 6 * HOUR })).toBe(true);
    expect(jobAlertCooldownApplies({ campaignId: 'weekly_2026-09-28', nowMs: monday + 47 * HOUR })).toBe(true);
  });

  it('lifts it afterwards so the subscribers still pending get the issue', () => {
    expect(jobAlertCooldownApplies({ campaignId: 'weekly_2026-09-28', nowMs: monday + 48 * HOUR })).toBe(false);
    expect(jobAlertCooldownApplies({ campaignId: 'weekly_2026-09-28', nowMs: monday + 6 * 24 * HOUR })).toBe(false);
  });

  it('keeps the cooldown for an id it cannot date', () => {
    expect(jobAlertCooldownApplies({ campaignId: 'daily-brief-2026-09-28', nowMs: monday + 6 * 24 * HOUR })).toBe(true);
    expect(jobAlertCooldownApplies({ campaignId: '', nowMs: monday })).toBe(true);
  });
});

describe('loadRecentJobAlertCooldownEmails', () => {
  it('queries only the 36-hour window and preserves timestamp and legacy ISO recipients', async () => {
    const cutoff = Date.parse('2026-09-28T12:00:00Z');
    const rows = [
      { id: 'recent@example.com', data: { last_sent_at: new Date(cutoff + 1) } },
      { id: 'legacy@example.com', data: { last_sent_at: new Date(cutoff + 2).toISOString() } },
      { id: 'old@example.com', data: { last_sent_at: new Date(cutoff - 1).toISOString() } },
      { id: 'bad@example.com', data: { last_sent_at: 'not a date' } },
    ];
    const filters: Array<[string, string, unknown]> = [];
    const db = {
      collection(name: string) {
        expect(name).toBe('job_alert_subscribers');
        return {
          where(field: string, operator: string, value: unknown) {
            filters.push([field, operator, value]);
            return {
              get: async () => ({
                docs: rows.filter((row) => {
                  const sentAt = row.data.last_sent_at;
                  if (value instanceof Date) return sentAt instanceof Date && sentAt >= value;
                  return typeof sentAt === 'string' && sentAt >= String(value);
                }).map((row) => ({ id: row.id, data: () => row.data })),
              }),
            };
          },
        };
      },
    } as any;

    const emails = await loadRecentJobAlertCooldownEmails(db, cutoff);

    expect([...emails].sort()).toEqual(['legacy@example.com', 'recent@example.com']);
    expect(filters).toEqual([
      ['last_sent_at', '>=', new Date(cutoff)],
      ['last_sent_at', '>=', new Date(cutoff).toISOString()],
    ]);
  });
});
