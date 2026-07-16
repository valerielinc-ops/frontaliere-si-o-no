import { describe, it, expect } from 'vitest';
import {
  classifyJobAlertEngagementTier,
  resolveEffectiveJobAlertTier,
  JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS,
  JOB_ALERT_ENGAGEMENT_TIERS,
} from '../scripts/lib/jobAlertEngagementTier.mjs';

const NOW = 1_700_000_000_000; // fixed reference; all fixtures are relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

function sub(overrides: Record<string, unknown> = {}) {
  return {
    last_open_at: null,
    last_click_at: null,
    ...overrides,
  };
}

describe('classifyJobAlertEngagementTier', () => {
  it('classifies a subscriber who clicked recently as daily', () => {
    const verdict = classifyJobAlertEngagementTier(sub({ last_click_at: daysAgo(1) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });

  it('classifies a subscriber who only opened recently as 36h', () => {
    const verdict = classifyJobAlertEngagementTier(sub({ last_open_at: daysAgo(2) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H);
  });

  it('classifies a never-engaged subscriber as weekly', () => {
    const verdict = classifyJobAlertEngagementTier(sub(), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('classifies a subscriber whose last engagement is outside the lookback as weekly', () => {
    const verdict = classifyJobAlertEngagementTier(
      sub({ last_open_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 1), last_click_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 1) }),
      NOW,
    );
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('treats engagement exactly at the lookback boundary as still-recent', () => {
    const verdict = classifyJobAlertEngagementTier(sub({ last_open_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H);
  });

  it('a click always wins over an open, regardless of which is more recent', () => {
    const clickOlderThanOpen = classifyJobAlertEngagementTier(
      sub({ last_click_at: daysAgo(10), last_open_at: daysAgo(1) }),
      NOW,
    );
    expect(clickOlderThanOpen.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });

  it('a stale click outside the lookback does not block a fresh open from scoring 36h', () => {
    const verdict = classifyJobAlertEngagementTier(
      sub({ last_click_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 5), last_open_at: daysAgo(1) }),
      NOW,
    );
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H);
  });

  it('honors the camelCase field spellings too', () => {
    const camel = { lastClickAt: daysAgo(1) };
    expect(classifyJobAlertEngagementTier(camel, NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });
});

describe('resolveEffectiveJobAlertTier', () => {
  it('defers to the engagement engine when the alert has no override', () => {
    const alert = { frequency: 'weekly' };
    const verdict = resolveEffectiveJobAlertTier(alert, sub({ last_click_at: daysAgo(1) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
    expect(verdict.manual).toBe(false);
  });

  it('defers to the engagement engine when frequencyOverride is explicitly false', () => {
    const alert = { frequency: 'daily', frequencyOverride: false };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    expect(verdict.manual).toBe(false);
  });

  it('honors a manual daily pin even for a disengaged subscriber', () => {
    const alert = { frequency: 'daily', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(), NOW);
    expect(verdict.tier).toBe('daily');
    expect(verdict.manual).toBe(true);
  });

  it('honors a manual weekly pin even for a highly engaged subscriber', () => {
    const alert = { frequency: 'weekly', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub({ last_click_at: daysAgo(1) }), NOW);
    expect(verdict.tier).toBe('weekly');
    expect(verdict.manual).toBe(true);
  });

  it('treats a pinned alert with a non-daily/weekly frequency value as weekly (conservative default)', () => {
    const alert = { frequency: '36h', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub({ last_click_at: daysAgo(1) }), NOW);
    expect(verdict.tier).toBe('weekly');
  });
});
