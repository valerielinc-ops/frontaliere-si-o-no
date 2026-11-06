import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { prioritizeSubscribers } from '../services/newsletter-priority.mjs';

describe('prioritizeSubscribers — engagement-based send order', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function makeSub(overrides) {
    return {
      email: 'x@example.com',
      sendCount: 5,
      engagementScore: 0,
      engagementLevel: 'dormant',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('returns hot subscribers before warm before cool before cold before dormant', () => {
    const input = [
      makeSub({ email: 'dormant@example.com', engagementLevel: 'dormant', engagementScore: 5 }),
      makeSub({ email: 'cold@example.com', engagementLevel: 'cold', engagementScore: 20 }),
      makeSub({ email: 'cool@example.com', engagementLevel: 'cool', engagementScore: 40 }),
      makeSub({ email: 'warm@example.com', engagementLevel: 'warm', engagementScore: 60 }),
      makeSub({ email: 'hot@example.com', engagementLevel: 'hot', engagementScore: 90 }),
    ];
    const result = prioritizeSubscribers(input);
    expect(result.map((s) => s.email)).toEqual([
      'hot@example.com',
      'warm@example.com',
      'cool@example.com',
      'cold@example.com',
      'dormant@example.com',
    ]);
  });

  it('places "new" subscribers (low send_count + recent) ahead of cool/cold/dormant', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const input = [
      makeSub({ email: 'cool@example.com', engagementLevel: 'cool', engagementScore: 40 }),
      makeSub({
        email: 'newbie@example.com',
        engagementLevel: 'dormant', // not yet engaged but recent
        engagementScore: 0,
        sendCount: 1,
        createdAt: recent,
      }),
      makeSub({ email: 'cold@example.com', engagementLevel: 'cold', engagementScore: 20 }),
    ];
    const result = prioritizeSubscribers(input);
    // cool comes before new (because cool=tier 3, new=tier 2... wait let me check)
    // TIER_RANK: hot=0, warm=1, new=2, cool=3, cold=4, dormant=5
    // So new comes BEFORE cool
    expect(result.map((s) => s.email)).toEqual([
      'newbie@example.com',
      'cool@example.com',
      'cold@example.com',
    ]);
  });

  it('does not classify long-time low-engagement users as "new"', () => {
    const oldSubscriber = new Date('2024-01-01T00:00:00Z');
    const input = [
      makeSub({
        email: 'old-dormant@example.com',
        engagementLevel: 'dormant',
        engagementScore: 0,
        sendCount: 1, // low send_count BUT old createdAt
        createdAt: oldSubscriber,
      }),
      makeSub({ email: 'cool@example.com', engagementLevel: 'cool', engagementScore: 40 }),
    ];
    const result = prioritizeSubscribers(input);
    // old dormant should NOT jump ahead of cool
    expect(result.map((s) => s.email)).toEqual([
      'cool@example.com',
      'old-dormant@example.com',
    ]);
  });

  it('sorts by engagement_score DESC within the same tier', () => {
    const input = [
      makeSub({ email: 'hot-low@example.com', engagementLevel: 'hot', engagementScore: 71 }),
      makeSub({ email: 'hot-high@example.com', engagementLevel: 'hot', engagementScore: 95 }),
      makeSub({ email: 'hot-mid@example.com', engagementLevel: 'hot', engagementScore: 80 }),
    ];
    const result = prioritizeSubscribers(input);
    expect(result.map((s) => s.email)).toEqual([
      'hot-high@example.com',
      'hot-mid@example.com',
      'hot-low@example.com',
    ]);
  });

  it('breaks ties by createdAt DESC (newer first) within same tier and score', () => {
    const input = [
      makeSub({
        email: 'old@example.com',
        engagementLevel: 'warm',
        engagementScore: 60,
        createdAt: new Date('2024-01-01'),
      }),
      makeSub({
        email: 'new@example.com',
        engagementLevel: 'warm',
        engagementScore: 60,
        createdAt: new Date('2025-12-01'),
      }),
    ];
    const result = prioritizeSubscribers(input);
    expect(result[0].email).toBe('new@example.com');
  });

  it('handles missing engagementLevel by defaulting to dormant', () => {
    const input = [
      makeSub({ email: 'hot@example.com', engagementLevel: 'hot', engagementScore: 90 }),
      makeSub({ email: 'unknown@example.com', engagementLevel: undefined, engagementScore: 0 }),
    ];
    const result = prioritizeSubscribers(input);
    expect(result[0].email).toBe('hot@example.com');
    expect(result[1].email).toBe('unknown@example.com');
  });

  it('logs tier distribution', () => {
    const input = [
      makeSub({ engagementLevel: 'hot', engagementScore: 80 }),
      makeSub({ engagementLevel: 'hot', engagementScore: 75 }),
      makeSub({ engagementLevel: 'warm', engagementScore: 55 }),
      makeSub({ engagementLevel: 'cold', engagementScore: 15 }),
    ];
    prioritizeSubscribers(input);
    const logged = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toMatch(/hot=2/);
    expect(logged).toMatch(/warm=1/);
    expect(logged).toMatch(/cold=1/);
  });

  it('handles empty input', () => {
    expect(prioritizeSubscribers([])).toEqual([]);
  });

  it('preserves all subscribers (no drops)', () => {
    const input = Array.from({ length: 50 }, (_, i) => makeSub({
      email: `s${i}@example.com`,
      engagementScore: i * 2,
      engagementLevel: ['hot', 'warm', 'cool', 'cold', 'dormant'][i % 5],
    }));
    const result = prioritizeSubscribers(input);
    expect(result).toHaveLength(50);
    expect(new Set(result.map((s) => s.email)).size).toBe(50);
  });
});
