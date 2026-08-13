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

    // #5767 — same anti-pattern the job-alert channel had: an opt-out click
    // must never read as engagement.
    it('does not let a fresh opt-out click buy recency points', () => {
      const withOptOut = calculateEngagementScore({
        send_count: 20,
        open_count: 0,
        click_count: 1,
        last_click_at: new Date().toISOString(),
        last_clicked_url: 'https://frontaliereticino.ch/disiscriviti/?id=abc',
      });
      const withoutClick = calculateEngagementScore({
        send_count: 20,
        open_count: 0,
        click_count: 0,
      });
      expect(withOptOut.score).toBe(withoutClick.score);
      expect(withOptOut.level).toBe('dormant');
    });

    it('does not count the opt-out click toward the click-rate component', () => {
      const result = calculateEngagementScore({
        send_count: 10,
        open_count: 0,
        click_count: 1,
        last_click_at: new Date().toISOString(),
        last_clicked_url: '/newsletter/disiscriviti/',
      });
      expect(result.score).toBe(0);
    });

    it('falls back to last_open_at recency when the last click was opt-out', () => {
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const result = calculateEngagementScore({
        send_count: 10,
        open_count: 1,
        click_count: 1,
        last_open_at: past,
        last_click_at: new Date().toISOString(),
        last_clicked_url: 'https://frontaliereticino.ch/disiscriviti/',
      });
      // Recency comes from the 3d-old open, not the fresh opt-out click:
      // openScore 8 (1/10 open rate) + recency 30, no click contribution.
      expect(result.score).toBe(38);
      expect(result.level).toBe('cool');
    });

    it('recognizes the alert-suffix and unsubscribe_all opt-out forms too', () => {
      const alertSuffix = calculateEngagementScore({
        send_count: 10,
        open_count: 5,
        click_count: 3,
        last_click_at: new Date().toISOString(),
        last_clicked_url: '/disiscrivi-alert/?id=x',
      });
      const unsubAll = calculateEngagementScore({
        send_count: 10,
        open_count: 5,
        click_count: 3,
        last_click_at: new Date().toISOString(),
        last_clicked_url: '/preferenze/?action=unsubscribe_all',
      });
      // Both should NOT count the opt-out click, unlike a genuine click.
      const genuine = calculateEngagementScore({
        send_count: 10,
        open_count: 5,
        click_count: 3,
        last_click_at: new Date().toISOString(),
        last_clicked_url: '/lavoro/qualche-annuncio/',
      });
      expect(alertSuffix.score).toBeLessThan(genuine.score);
      expect(unsubAll.score).toBeLessThan(genuine.score);
    });

    it('a genuine click still counts as engagement', () => {
      const result = calculateEngagementScore({
        send_count: 10,
        open_count: 0,
        click_count: 1,
        last_click_at: new Date().toISOString(),
        last_clicked_url: '/lavoro/qualche-annuncio/',
      });
      expect(result.score).toBeGreaterThan(0);
      expect(result.level).not.toBe('dormant');
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
      // Minimal `db.runTransaction` shim (same idiom as the fake used in
      // tests/bounce-classification.test.ts) — refreshEngagementScore now
      // reads/writes through a transaction, not `ref.get()`/`ref.set()` directly.
      ref.firestore = {
        runTransaction: async (updateFunction) => {
          const tx = {
            get: async (r) => r.get(),
            set: (r, update, options) => {
              // fire-and-forget is fine here: ref.set has no internal await
              // before it mutates `stored`, so this resolves synchronously.
              r.set(update, options);
            },
          };
          return updateFunction(tx);
        },
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
      const { ref } = makeRef(null);
      ref.get = vi.fn(async () => ({ exists: false, data: () => null }));
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(false);
      expect(ref.set).not.toHaveBeenCalled();
    });

    it('swallows errors and never throws', async () => {
      const { ref } = makeRef({});
      ref.get = vi.fn(async () => { throw new Error('firestore unavailable'); });
      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);
      expect(result.updated).toBe(false);
      expect(ref.set).not.toHaveBeenCalled();
    });

    // Race-condition regression coverage for #3206 item 3's sibling class: a
    // plain read-then-write here could persist a stale derived score if
    // another concurrent webhook delivery (e.g. open+click landing together)
    // bumps the counters between the read and the write. A retry-capable
    // transaction fake (mirrors real Firestore's optimistic-concurrency
    // contract, same idiom as tests/bounce-classification.test.ts) proves the
    // fix re-evaluates against the fresh counters instead of the stale ones.
    it('re-evaluates against a concurrent counter update instead of persisting a stale score', async () => {
      let data: Record<string, unknown> = {
        send_count: 10,
        open_count: 0,
        click_count: 0,
        engagement_score: 0,
        engagement_level: 'dormant',
      };
      let version = 0;
      let armed = false;
      const writes: Array<Record<string, unknown>> = [];

      const ref: any = {
        set: async (update: Record<string, unknown>, opts?: { merge?: boolean }) => {
          data = opts?.merge ? { ...data, ...update } : { ...update };
          version += 1;
        },
      };
      ref.get = async () => ({ exists: true, data: () => ({ ...data }) });
      ref.firestore = {
        runTransaction: async (updateFunction: (tx: any) => Promise<unknown>) => {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const versionAtStart = version;
            const snapshot = { ...data };
            let pendingWrite: Record<string, unknown> | null = null;
            const tx = {
              get: async () => {
                if (!armed) {
                  armed = true;
                  // Concurrent webhook delivery lands between this
                  // transaction's read and its commit.
                  data = { ...data, open_count: 9, click_count: 5, last_click_at: new Date().toISOString() };
                  version += 1;
                }
                return { exists: true, data: () => ({ ...snapshot }) };
              },
              set: (_ref: unknown, update: Record<string, unknown>, opts?: { merge?: boolean }) => {
                pendingWrite = opts?.merge ? { ...snapshot, ...update } : { ...update };
              },
            };
            const result = await updateFunction(tx);
            if (version !== versionAtStart) continue; // conflicting write mid-transaction — retry
            if (pendingWrite) {
              data = pendingWrite;
              version += 1;
              writes.push(pendingWrite);
            }
            return result;
          }
          throw new Error('too many transaction retries');
        },
      };

      const result = await refreshEngagementScore(ref as never, mockFieldValue as never);

      expect(result.updated).toBe(true);
      // Reflects the concurrently-landed counters (hot), not a stale score
      // computed from the pre-race snapshot.
      expect(result.level).toBe('hot');
      expect(writes).toHaveLength(1);
    });
  });
});
