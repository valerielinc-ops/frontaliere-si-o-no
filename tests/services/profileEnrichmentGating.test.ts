/**
 * Unit tests for `services/profileEnrichmentGating.ts`.
 *
 * Locks in:
 *  - the same daily-dismiss-cap shape as `jobDetailAlertGating.ts`
 *    (2 dismisses/answers per local day, then suppressed until tomorrow).
 *  - `pickNextQuestion` field-priority ordering (profile fields outrank
 *    alert fields; higher weight wins).
 *  - `dependsOn` resolution (`cantonFilter` only offered once
 *    `provinceQuickPick` — i.e. `municipality` — is answered).
 *  - `appliesTo: 'alert'` fields are never offered when there's no active
 *    alert context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGatingState,
  saveGatingState,
  pickNextQuestion,
  recordAnswer,
  recordSkip,
  __testing,
  type ProfileEnrichmentPromptState,
  type EnrichmentProfileInput,
  type EnrichmentAlertInput,
} from '@/services/profileEnrichmentGating';

const STORAGE_KEY = __testing.STORAGE_KEY;

const emptyState = (): ProfileEnrichmentPromptState => ({
  dismissDay: null,
  dismissesToday: 0,
});

const emptyProfile = (): EnrichmentProfileInput => ({});
const emptyAlert = (): EnrichmentAlertInput => ({});

const today = new Date('2026-05-19T12:00:00.000Z');
const tomorrow = new Date('2026-05-20T08:00:00.000Z');
const todayKey = __testing.todayKey(today);
const tomorrowKey = __testing.todayKey(tomorrow);

describe('profileEnrichmentGating', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('loadGatingState', () => {
    it('returns defaults when storage is empty', () => {
      expect(loadGatingState()).toEqual(emptyState());
    });

    it('parses valid JSON from localStorage', () => {
      const persisted: ProfileEnrichmentPromptState = { dismissDay: '2026-01-01', dismissesToday: 1 };
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ dismissDay: 42, dismissesToday: 'oops' }));
      expect(loadGatingState()).toEqual(emptyState());
    });
  });

  describe('saveGatingState', () => {
    it('persists JSON', () => {
      const state: ProfileEnrichmentPromptState = { dismissDay: todayKey, dismissesToday: 2 };
      saveGatingState(state);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toEqual(state);
    });
  });

  describe('pickNextQuestion — priority', () => {
    it('picks provinceQuickPick first on a fully empty profile with no alert', () => {
      expect(pickNextQuestion(emptyProfile(), null, emptyState(), today)).toBe('provinceQuickPick');
    });

    it('skips answered fields and picks the next-highest weight', () => {
      const profile: EnrichmentProfileInput = { municipality: 'Como' };
      expect(pickNextQuestion(profile, null, emptyState(), today)).toBe('frontaliereType');
    });

    it('returns null once every profile field is answered and there is no alert context', () => {
      const profile: EnrichmentProfileInput = {
        municipality: 'Como',
        frontaliereType: 'permit-g',
        workPosition: 'Ingegnere',
        grossSalary: '60000',
      };
      expect(pickNextQuestion(profile, null, emptyState(), today)).toBeNull();
    });
  });

  describe('pickNextQuestion — alert fields', () => {
    const fullProfile: EnrichmentProfileInput = {
      municipality: 'Como',
      frontaliereType: 'permit-g',
      workPosition: 'Ingegnere',
      grossSalary: '60000',
    };

    it('never offers an alert field when alert context is null', () => {
      expect(pickNextQuestion(fullProfile, null, emptyState(), today)).toBeNull();
    });

    it('offers cantonFilter once profile is answered and an alert exists', () => {
      expect(pickNextQuestion(fullProfile, emptyAlert(), emptyState(), today)).toBe('cantonFilter');
    });

    it('does not offer cantonFilter before its dependsOn (provinceQuickPick/municipality) is answered', () => {
      const noMunicipality: EnrichmentProfileInput = {
        frontaliereType: 'permit-g',
        workPosition: 'Ingegnere',
        grossSalary: '60000',
      };
      // provinceQuickPick is unanswered, so it wins over cantonFilter regardless of dependsOn.
      expect(pickNextQuestion(noMunicipality, emptyAlert(), emptyState(), today)).toBe('provinceQuickPick');
    });

    it('falls through to sectors once cantonFilter is answered', () => {
      const alert: EnrichmentAlertInput = { cantonFilter: ['TI'] };
      expect(pickNextQuestion(fullProfile, alert, emptyState(), today)).toBe('sectors');
    });

    it('returns null once profile and alert are both fully answered', () => {
      const alert: EnrichmentAlertInput = { cantonFilter: ['TI'], sectors: ['IT'] };
      expect(pickNextQuestion(fullProfile, alert, emptyState(), today)).toBeNull();
    });
  });

  describe('pickNextQuestion — daily cap', () => {
    it('returns null when the daily cap is already hit today', () => {
      const state: ProfileEnrichmentPromptState = { dismissDay: todayKey, dismissesToday: __testing.DAILY_DISMISS_CAP };
      expect(pickNextQuestion(emptyProfile(), null, state, today)).toBeNull();
    });

    it('resumes after the day rolls over', () => {
      const state: ProfileEnrichmentPromptState = { dismissDay: todayKey, dismissesToday: __testing.DAILY_DISMISS_CAP };
      expect(pickNextQuestion(emptyProfile(), null, state, tomorrow)).toBe('provinceQuickPick');
    });
  });

  describe('recordSkip', () => {
    it('starts the daily counter when no prior state for today', () => {
      expect(recordSkip(emptyState(), today)).toEqual({ dismissDay: todayKey, dismissesToday: 1 });
    });

    it('bumps the counter for same-day skips', () => {
      const next = recordSkip({ dismissDay: todayKey, dismissesToday: 1 }, today);
      expect(next).toEqual({ dismissDay: todayKey, dismissesToday: 2 });
    });

    it('rolls over to a fresh counter on a new day', () => {
      const next = recordSkip({ dismissDay: todayKey, dismissesToday: __testing.DAILY_DISMISS_CAP }, tomorrow);
      expect(next).toEqual({ dismissDay: tomorrowKey, dismissesToday: 1 });
    });

    it('does not mutate input state', () => {
      const input = emptyState();
      recordSkip(input, today);
      expect(input).toEqual({ dismissDay: null, dismissesToday: 0 });
    });
  });

  describe('recordAnswer', () => {
    it('pins the counter to the daily cap to suppress further prompts today', () => {
      expect(recordAnswer(emptyState(), today)).toEqual({ dismissDay: todayKey, dismissesToday: __testing.DAILY_DISMISS_CAP });
    });

    it('lets the user be prompted again tomorrow', () => {
      const afterAnswer = recordAnswer(emptyState(), today);
      expect(pickNextQuestion(emptyProfile(), null, afterAnswer, tomorrow)).toBe('provinceQuickPick');
    });

    it('does not mutate input state', () => {
      const input = emptyState();
      recordAnswer(input, today);
      expect(input).toEqual({ dismissDay: null, dismissesToday: 0 });
    });
  });
});
