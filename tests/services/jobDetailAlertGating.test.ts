/**
 * Unit tests for `services/jobDetailAlertGating.ts`.
 *
 * Covers all three decision branches in `shouldShowPrompt`:
 *  - session "shown this session" flag short-circuits true → false.
 *  - dismiss cap with 30-day cooldown.
 *  - per-category 7-day cooldown.
 *
 * Also locks in the recordDismiss/recordAccept side-effect contract
 * (immutable, ISO timestamps, dismiss bumps counter, accept doesn't).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGatingState,
  saveGatingState,
  shouldShowPrompt,
  recordAccept,
  recordDismiss,
  markShownThisSession,
  STORAGE_KEY,
  SESSION_KEY,
  __testing,
  type JobDetailAlertPromptState,
} from '@/services/jobDetailAlertGating';

const DAY_MS = 24 * 60 * 60 * 1000;

const emptyState = (): JobDetailAlertPromptState => ({
  dismissCount: 0,
  lastDismissAt: null,
  perCategorySeenAt: {},
});

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
        dismissCount: 1,
        lastDismissAt: '2026-01-01T00:00:00.000Z',
        perCategorySeenAt: { sanita: '2026-01-02T00:00:00.000Z' },
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
        JSON.stringify({ dismissCount: 'oops', lastDismissAt: 42, perCategorySeenAt: null }),
      );
      expect(loadGatingState()).toEqual(emptyState());
    });
  });

  describe('saveGatingState', () => {
    it('persists JSON', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: 2,
        lastDismissAt: '2026-02-01T00:00:00.000Z',
        perCategorySeenAt: { 'it sector': '2026-02-02T00:00:00.000Z' },
      };
      saveGatingState(state);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toEqual(state);
    });
  });

  describe('shouldShowPrompt', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');

    it('returns false for empty category', () => {
      expect(shouldShowPrompt(emptyState(), now, '')).toBe(false);
    });

    it('returns true on a fresh state with a real category', () => {
      expect(shouldShowPrompt(emptyState(), now, 'sanita')).toBe(true);
    });

    it('returns false if the session flag is set', () => {
      markShownThisSession();
      expect(shouldShowPrompt(emptyState(), now, 'sanita')).toBe(false);
    });

    it('returns true if dismissCount < cap', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: __testing.DISMISS_CAP - 1,
        lastDismissAt: new Date(now.getTime() - DAY_MS).toISOString(),
        perCategorySeenAt: {},
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(true);
    });

    it('returns false when dismiss cap hit and within 30-day cooldown', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: __testing.DISMISS_CAP,
        lastDismissAt: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
        perCategorySeenAt: {},
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(false);
    });

    it('returns true when dismiss cap hit but cooldown elapsed', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: __testing.DISMISS_CAP,
        lastDismissAt: new Date(now.getTime() - 31 * DAY_MS).toISOString(),
        perCategorySeenAt: {},
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(true);
    });

    it('returns false when category was seen within 7 days', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: 0,
        lastDismissAt: null,
        perCategorySeenAt: { sanita: new Date(now.getTime() - 3 * DAY_MS).toISOString() },
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(false);
    });

    it('returns true when category was seen more than 7 days ago', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: 0,
        lastDismissAt: null,
        perCategorySeenAt: { sanita: new Date(now.getTime() - 8 * DAY_MS).toISOString() },
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(true);
    });

    it('per-category cooldown only blocks the matching category', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: 0,
        lastDismissAt: null,
        perCategorySeenAt: { sanita: new Date(now.getTime() - 1 * DAY_MS).toISOString() },
      };
      expect(shouldShowPrompt(state, now, 'sanita')).toBe(false);
      expect(shouldShowPrompt(state, now, 'finanza')).toBe(true);
    });
  });

  describe('recordDismiss', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');

    it('increments dismissCount and stamps lastDismissAt', () => {
      const next = recordDismiss(emptyState(), now, 'sanita');
      expect(next.dismissCount).toBe(1);
      expect(next.lastDismissAt).toBe(now.toISOString());
      expect(next.perCategorySeenAt).toEqual({ sanita: now.toISOString() });
    });

    it('does not mutate input state', () => {
      const input = emptyState();
      recordDismiss(input, now, 'sanita');
      expect(input.dismissCount).toBe(0);
      expect(input.lastDismissAt).toBeNull();
      expect(input.perCategorySeenAt).toEqual({});
    });
  });

  describe('recordAccept', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');

    it('does not bump dismissCount but stamps perCategorySeenAt', () => {
      const next = recordAccept(emptyState(), now, 'sanita');
      expect(next.dismissCount).toBe(0);
      expect(next.lastDismissAt).toBeNull();
      expect(next.perCategorySeenAt).toEqual({ sanita: now.toISOString() });
    });

    it('preserves prior per-category entries', () => {
      const state: JobDetailAlertPromptState = {
        dismissCount: 1,
        lastDismissAt: '2026-01-01T00:00:00.000Z',
        perCategorySeenAt: { other: '2026-04-01T00:00:00.000Z' },
      };
      const next = recordAccept(state, now, 'sanita');
      expect(next.dismissCount).toBe(1);
      expect(next.lastDismissAt).toBe('2026-01-01T00:00:00.000Z');
      expect(next.perCategorySeenAt).toEqual({
        other: '2026-04-01T00:00:00.000Z',
        sanita: now.toISOString(),
      });
    });
  });

  describe('markShownThisSession', () => {
    it('writes the sentinel value', () => {
      markShownThisSession();
      expect(sessionStorage.getItem(SESSION_KEY)).toBe('1');
    });
  });
});
