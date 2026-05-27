import { describe, expect, it, vi } from 'vitest';
import {
  calculateEngagementScore,
  scoreToLevel,
  refreshEngagementScore,
  ENGAGEMENT_THRESHOLDS,
} from '../functions/src/lib/engagementScore.js';

describe('shared engagementScore module (functions/src/lib)', () => {
  describe('calculateEngagementScore', () => {
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

    it('returns dormant for zero engagement', () => {
      const result = calculateEngagementScore({
        send_count: 20,
        open_count: 0,
        click_count: 0,
      });
      expect(result.score).toBe(0);
      expect(result.level).toBe('dormant');
    });

    it('handles camelCase field aliases (sendCount, openCount, clickCount)', () => {
      const result = calculateEngagementScore({
        sendCount: 10,
        openCount: 9,
        clickCount: 5,
        lastClickAt: new Date().toISOString(),
      });
      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('handles Firestore Timestamp objects via toDate()', () => {
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const fakeTimestamp = { toDate: () => past };
      const result = calculateEngagementScore({
        send_count: 5,
        open_count: 5,
        click_count: 0,
        last_open_at: fakeTimestamp,
      });
      // 5/5 = 100% open rate → openScore = min(40, 80) = 40
      // No clicks → 0
      // Recency 3d → 30
      // Total = 70 → hot
      expect(result.score).toBe(70);
      expect(result.level).toBe('hot');
    });

    it('clamps score at 100', () => {
      const result = calculateEngagementScore({
        send_count: 10,
        open_count: 100,
        click_count: 100,
        last_click_at: new Date().toISOString(),
      });
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('returns 0 score with no engagement data', () => {
      const result = calculateEngagementScore({});
      expect(result.score).toBe(0);
      expect(result.level).toBe('dormant');
    });

    it('handles invalid date strings gracefully', () => {
      const result = calculateEngagementScore({
        send_count: 10,
        open_count: 5,
        last_open_at: 'not-a-date',
      });
      // Open rate 50% → openScore = 40 (capped). Recency NaN → 0
      expect(result.score).toBe(40);
      expect(result.level).toBe('cool');
    });
  });

  describe('scoreToLevel boundaries', () => {
    it('maps boundary scores to the correct tier', () => {
      expect(scoreToLevel(100)).toBe('hot');
      expect(scoreToLevel(70)).toBe('hot');
      expect(scoreToLevel(69)).toBe('warm');
      expect(scoreToLevel(50)).toBe('warm');
      expect(scoreToLevel(49)).toBe('cool');
      expect(scoreToLevel(30)).toBe('cool');
      expect(scoreToLevel(29)).toBe('cold');
      expect(scoreToLevel(10)).toBe('cold');
      expect(scoreToLevel(9)).toBe('dormant');
      expect(scoreToLevel(0)).toBe('dormant');
    });

    it('exposes threshold constants', () => {
      expect(ENGAGEMENT_THRESHOLDS.HOT).toBe(70);
      expect(ENGAGEMENT_THRESHOLDS.WARM).toBe(50);
      expect(ENGAGEMENT_THRESHOLDS.COOL).toBe(30);
      expect(ENGAGEMENT_THRESHOLDS.COLD).toBe(10);
    });
  });

  describe('refreshEngagementScore', () => {
    function makeRef(initialData) {
      const writes = [];
      let stored = { ...initialData };
      const ref = {
        get: vi.fn(async () => ({
          exists: stored !== null,
          data: () => stored,
        })),
        set: vi.fn(async (update, options) => {
          writes.push({ update, options });
          if (options?.merge) stored = { ...stored, ...update };
          else stored = { ...update };
        }),
      };
      return { ref, writes, getStored: () => stored };
    }

    const mockFieldValue = {
      serverTimestamp: () => '__SERVER_TS__',
    };

    it('writes a fresh score when raw counters change', async () => {
      const { ref, writes } = makeRef({
        send_count: 10,
        open_count: 9,
        click_count: 5,
        last_click_at: new Date().toISOString(),
        engagement_score: 0,
        engagement_level: 'dormant',
      });
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(true);
      expect(result.level).toBe('hot');
      expect(writes).toHaveLength(1);
      expect(writes[0].update.engagement_score).toBeGreaterThanOrEqual(70);
      expect(writes[0].update.engagement_level).toBe('hot');
      expect(writes[0].options.merge).toBe(true);
    });

    it('skips the write when score is already correct', async () => {
      const { ref, writes } = makeRef({
        send_count: 0,
        open_count: 0,
        click_count: 0,
        engagement_score: 0,
        engagement_level: 'dormant',
      });
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(false);
      expect(writes).toHaveLength(0);
    });

    it('returns updated=false when document does not exist', async () => {
      const ref = {
        get: vi.fn(async () => ({ exists: false, data: () => null })),
        set: vi.fn(),
      };
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(false);
      expect(ref.set).not.toHaveBeenCalled();
    });

    it('swallows errors and never throws', async () => {
      const ref = {
        get: vi.fn(async () => { throw new Error('firestore unavailable'); }),
        set: vi.fn(),
      };
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(false);
      expect(ref.set).not.toHaveBeenCalled();
    });
  });
});
