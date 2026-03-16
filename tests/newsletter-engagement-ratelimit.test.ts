import { describe, expect, it, beforeEach } from 'vitest';
import {
  calculateEngagementScore,
  checkSubscriptionRateLimit,
  recordSubscriptionAttempt,
} from '@/services/newsletterSubscribers';

describe('calculateEngagementScore (FRO-17)', () => {
  it('returns hot for high open+click rates with recent activity', () => {
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 9,
      click_count: 5,
      last_click_at: new Date().toISOString(),
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.level).toBe('hot');
  });

  it('returns warm for moderate engagement', () => {
    const result = calculateEngagementScore({
      send_count: 20,
      open_count: 6,
      click_count: 1,
      last_open_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(70);
    expect(['warm', 'cool']).toContain(result.level);
  });

  it('returns dormant for zero engagement', () => {
    const result = calculateEngagementScore({
      send_count: 20,
      open_count: 0,
      click_count: 0,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('dormant');
  });

  it('returns cold for old engagement', () => {
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 2,
      click_count: 0,
      last_open_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(result.level).toBe('cold');
  });

  it('handles missing data gracefully', () => {
    const result = calculateEngagementScore({});
    expect(result.score).toBe(0);
    expect(result.level).toBe('dormant');
  });

  it('caps score at 100', () => {
    const result = calculateEngagementScore({
      send_count: 1,
      open_count: 1,
      click_count: 1,
      last_click_at: new Date().toISOString(),
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe('checkSubscriptionRateLimit (FRO-19)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('allows first attempt', () => {
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('allows up to 3 attempts', () => {
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
  });

  it('blocks after 3 rapid attempts', () => {
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the time window expires', () => {
    // Manually set expired state
    window.sessionStorage.setItem(
      'newsletter_rate_limit',
      JSON.stringify({ attempts: 5, windowStart: Date.now() - 60_000 }),
    );
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
  });
});
