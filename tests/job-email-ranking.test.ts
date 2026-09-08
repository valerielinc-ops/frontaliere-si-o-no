import { describe, expect, it } from 'vitest';
import {
  aggregateRankingStats,
  appendJobRankingParams,
  assignJobRankingVariant,
  buildEmbeddedRankingUpdate,
  computeSmoothedCtr,
  parseJobRankingClick,
  pseudonymousUserId,
  rankEmailJobs,
  rankingStatsKey,
  readJobEmailRankingConfig,
} from '../functions/src/lib/jobEmailRanking.js';

const CONFIG = {
  enabled: true,
  rollout: 1,
  alpha: 0.8,
  epsilon: 0.15,
  windowDays: 60,
  shrinkK: 25,
  minImpressions: 50,
  newJobBoost: 0.15,
  maxConsecutiveExposures: 3,
};

describe('job email ranking', () => {
  it('shrinks small-sample CTR towards the prior', () => {
    expect(computeSmoothedCtr(1, 1, 0.05, 25)).toBeCloseTo(0.0865, 4);
    expect(computeSmoothedCtr(50, 100, 0.05, 25)).toBeGreaterThan(0.3);
  });

  it('keeps rolling daily stats inside the configured window', () => {
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    const stats = aggregateRankingStats({
      days: {
        '2026-09-08': { impressions: 10, clicks: 2, position_sum: 10 },
        '2026-09-01': { impressions: 20, clicks: 4, position_sum: 30 },
        '2026-07-01': { impressions: 100, clicks: 80, position_sum: 100 },
      },
    }, { nowMs: now, windowDays: 7 });
    expect(stats.impressions).toBe(10);
    expect(stats.clicks).toBe(2);
  });

  it('preserves the existing order in control and ranks only matched jobs in treatment', () => {
    const jobs = [
      { slug: 'first', relevanceScore: 10 },
      { slug: 'second', relevanceScore: 8 },
      { slug: 'third', relevanceScore: 2 },
    ];
    const control = rankEmailJobs(jobs, { variant: 'control', limit: 2, config: CONFIG });
    expect(control.map((job) => job.slug)).toEqual(['first', 'second']);

    const treatment = rankEmailJobs(jobs, {
      variant: 'treatment',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      campaignId: 'weekly_2026-09-07',
      limit: 2,
      config: CONFIG,
    });
    expect(treatment).toHaveLength(2);
    expect(treatment.every((job) => job.ranking.relevanceScore > 0)).toBe(true);
    expect(treatment.every((job) => job.ranking.variant === 'treatment')).toBe(true);
  });

  it('assigns a stable treatment/control cohort and supports an instant kill switch', () => {
    const treatment = assignJobRankingVariant({
      subjectId: 'person@example.com',
      surface: 'newsletter',
      campaignId: 'weekly_2026-09-07',
      config: { ...CONFIG, rollout: 1 },
    });
    expect(treatment).toBe('treatment');
    expect(assignJobRankingVariant({
      subjectId: 'person@example.com',
      surface: 'newsletter',
      campaignId: 'weekly_2026-09-07',
      config: { ...CONFIG, rollout: 1 },
    })).toBe(treatment);
    expect(assignJobRankingVariant({
      subjectId: 'person@example.com',
      surface: 'newsletter',
      campaignId: 'weekly_2026-09-07',
      config: { ...CONFIG, enabled: false },
    })).toBe('control');
  });

  it('parses tracked clicks without exposing recipient identity', () => {
    const url = appendJobRankingParams('/cerca-lavoro-ticino/job-one/?utm_source=newsletter', {
      jobId: 'job-one',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      deliveryId: 'jer_newsletter_123',
      position: 2,
      variant: 'treatment',
      newsletterId: 'weekly_2026-09-07',
      rankingScore: 0.82,
      relevanceScore: 8,
      ctrShrink: 0.12,
      randomBoost: 0.4,
    });
    const click = parseJobRankingClick(url);
    expect(click).toMatchObject({
      jobId: 'job-one',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      deliveryId: 'jer_newsletter_123',
      position: 2,
      variant: 'treatment',
    });
    expect(url).not.toContain('person@example.com');
    expect(parseJobRankingClick('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/')).toBeNull();
  });

  it('uses a pseudonymous user id and safe nested Firestore paths', () => {
    const userId = pseudonymousUserId('Person@Example.com', 'ranking-secret');
    expect(userId).toHaveLength(32);
    expect(userId).not.toContain('@');
    const FieldValue = { increment: (amount: number) => ({ increment: amount }) };
    const update = buildEmbeddedRankingUpdate({
      jobId: 'job.with.dots',
      day: '2026-09-08',
      position: 3,
      variant: 'treatment',
      FieldValue,
    });
    expect(Object.keys(update).some((key) => key.includes('job.with.dots'))).toBe(false);
    expect(update).toMatchObject({
      [`ranking_stats.${rankingStatsKey('job.with.dots')}.days.2026-09-08.impressions`]: { increment: 1 },
    });
  });

  it('allows epsilon zero to disable exploration slots', () => {
    const jobs = [
      { slug: 'first', relevanceScore: 10 },
      { slug: 'second', relevanceScore: 8 },
      { slug: 'third', relevanceScore: 2 },
    ];
    const ranked = rankEmailJobs(jobs, {
      variant: 'treatment',
      statsByJob: new Map([
        ['first', { impressions: 100, clicks: 50 }],
        ['second', { impressions: 100, clicks: 50 }],
        ['third', { impressions: 0, clicks: 0 }],
      ]),
      limit: 2,
      config: { ...CONFIG, epsilon: 0 },
    });
    expect(ranked).toHaveLength(2);
    expect(ranked.map((job) => job.slug)).not.toContain('third');
  });

  it('clamps malformed environment settings to safe bounds', () => {
    expect(readJobEmailRankingConfig({
      JOB_EMAIL_RANKING_ENABLED: 'off',
      JOB_EMAIL_RANKING_ROLLOUT: 'not-a-number',
      JOB_EMAIL_RANKING_ALPHA: '4',
      JOB_EMAIL_RANKING_WINDOW_DAYS: '999',
    })).toMatchObject({ enabled: false, rollout: 0.15, alpha: 1, windowDays: 90 });
  });
});
