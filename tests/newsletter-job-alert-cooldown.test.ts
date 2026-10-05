/**
 * The newsletter's job-alert cooldown must defer, not starve: daily job-alert
 * recipients always have a < 36h `last_sent_at`, so an unbounded cooldown kept
 * 520 eligible subscribers out of weekly_2026-09-28.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS,
  jobAlertCooldownApplies,
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
