/**
 * Unit tests for `services/jobDetailAlertGating.ts`.
 *
 * Post-2026-05-19 relaxation: the gating module only enforces a daily
 * dismiss cap. All previous cooldowns (30-day, 7-day per-category,
 * per-session) were removed because PostHog data showed only 4 `shown`
 * events in 30 days under the old rules — too aggressive to learn from.
 *
 * Locks in the rewritten contract:
 *  - shouldShowPrompt is true unless the daily cap is hit for today.
 *  - recordDismiss bumps the daily counter (rolling over on new day).
 *  - recordAccept pins the counter to the cap (no re-prompt same day).
 *  - All side-effects are immutable.
 *  - loadGatingState gracefully ignores the legacy persisted shape.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGatingState,
  saveGatingState,
  shouldShowPrompt,
  recordAccept,
  recordDismiss,
  STORAGE_KEY,
  __testing,
  type JobDetailAlertPromptState,
} from '@/services/jobDetailAlertGating';

const emptyState = (): JobDetailAlertPromptState => ({
  dismissDay: null,
  dismissesToday: 0,
});

const today = new Date('2026-05-19T12:00:00.000Z');
const tomorrow = new Date('2026-05-20T08:00:00.000Z');
const todayKey = __testing.todayKey(today);
const tomorrowKey = __testing.todayKey(tomorrow);

describe('jobDetailAlertGating', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('loadGatingState', () => {
    it('returns defaults when storage is empty', () => {
      expect(loadGatingState()).toEqual(emptyState());
    });

    it('parses valid JSON from localStorage', () => {
      const persisted: JobDetailAlertPromptState = {
        dismissDay: '2026-01-01',
        dismissesToday: 1,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      expect(loadGatingState()).toEqual(persisted);
    });

    it('falls back to defaults when JSON is malformed', () => {
      localStorage.setItem(STORAGE_KEY, '{not-json');
      expect(loadGatingState()).toEqual(emptyState());
    });

    it('falls back to defaults when shape is wrong', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['not-an-object']));
      expect(loadGatingState()).toEqual(emptyState());
    });

    it('coerces invalid fields to defaults', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ dismissDay: 42, dismissesToday: 'oops' }),
      );
      expect(loadGatingState()).toEqual(emptyState());
    });

    it('discards the legacy shape (forward migration)', () => {
      // Before 2026-05-19 the shape was { dismissCount, lastDismissAt,
      // perCategorySeenAt }. None of those fields are valid keys in the
      // new shape, so loadGatingState should return defaults rather than
      // surface stale state (which would prevent prompts indefinitely).
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          dismissCount: 99,
          lastDismissAt: '2026-04-01T00:00:00.000Z',
          perCategorySeenAt: { sanita: '2026-04-01T00:00:00.000Z' },
        }),
      );
      expect(loadGatingState()).toEqual(emptyState());
    });
  });

  describe('saveGatingState', () => {
    it('persists JSON', () => {
      const state: JobDetailAlertPromptState = {
        dismissDay: todayKey,
        dismissesToday: 2,
      };
      saveGatingState(state);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toEqual(state);
    });
  });

  describe('shouldShowPrompt', () => {
    it('returns false for empty category', () => {
      expect(shouldShowPrompt(emptyState(), today, '')).toBe(false);
    });

    it('returns true on a fresh state with a real category', () => {
      expect(shouldShowPrompt(emptyState(), today, 'sanita')).toBe(true);
    });

    it('returns true when below the daily cap', () => {
      const state: JobDetailAlertPromptState = {
        dismissDay: todayKey,
        dismissesToday: __testing.DAILY_DISMISS_CAP - 1,
      };
      expect(shouldShowPrompt(state, today, 'sanita')).toBe(true);
    });

    it('returns false when the daily cap is hit today', () => {
      const state: JobDetailAlertPromptState = {
        dismissDay: todayKey,
        dismissesToday: __testing.DAILY_DISMISS_CAP,
      };
      expect(shouldShowPrompt(state, today, 'sanita')).toBe(false);
    });

    it('returns true after the day rolls over even when prior counter was at cap', () => {
      const state: JobDetailAlertPromptState = {
        dismissDay: todayKey,
        dismissesToday: __testing.DAILY_DISMISS_CAP,
      };
      expect(shouldShowPrompt(state, tomorrow, 'sanita')).toBe(true);
    });

    it('is category-agnostic — no per-category cooldown anymore', () => {
      // Before 2026-05-19 each category had its own 7-day cooldown. After
      // the relaxation, only the daily cap matters: every category is
      // gated by the same counter.
      const state: JobDetailAlertPromptState = {
        dismissDay: todayKey,
        dismissesToday: __testing.DAILY_DISMISS_CAP,
      };
      expect(shouldShowPrompt(state, today, 'sanita')).toBe(false);
      expect(shouldShowPrompt(state, today, 'finanza')).toBe(false);
    });
  });

  describe('recordDismiss', () => {
    it('starts the daily counter when no prior state for today', () => {
      const next = recordDismiss(emptyState(), today, 'sanita');
      expect(next).toEqual({ dismissDay: todayKey, dismissesToday: 1 });
    });

    it('bumps the counter for same-day dismisses', () => {
      const next = recordDismiss(
        { dismissDay: todayKey, dismissesToday: 1 },
        today,
        'sanita',
      );
      expect(next).toEqual({ dismissDay: todayKey, dismissesToday: 2 });
    });

    it('rolls over to a fresh counter on a new day', () => {
      const next = recordDismiss(
        { dismissDay: todayKey, dismissesToday: __testing.DAILY_DISMISS_CAP },
        tomorrow,
        'sanita',
      );
      expect(next).toEqual({ dismissDay: tomorrowKey, dismissesToday: 1 });
    });

    it('does not mutate input state', () => {
      const input = emptyState();
      recordDismiss(input, today, 'sanita');
      expect(input).toEqual({ dismissDay: null, dismissesToday: 0 });
    });
  });

  describe('recordAccept', () => {
    it('pins the counter to the daily cap to suppress further prompts today', () => {
      const next = recordAccept(emptyState(), today, 'sanita');
      expect(next).toEqual({
        dismissDay: todayKey,
        dismissesToday: __testing.DAILY_DISMISS_CAP,
      });
    });

    it('lets the user be prompted again tomorrow', () => {
      const afterAccept = recordAccept(emptyState(), today, 'sanita');
      expect(shouldShowPrompt(afterAccept, tomorrow, 'altro')).toBe(true);
    });

    it('does not mutate input state', () => {
      const input = emptyState();
      recordAccept(input, today, 'sanita');
      expect(input).toEqual({ dismissDay: null, dismissesToday: 0 });
    });
  });
});
