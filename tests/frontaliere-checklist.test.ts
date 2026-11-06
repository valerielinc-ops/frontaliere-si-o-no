import { describe, it, expect, beforeEach } from 'vitest';
import {
  CHECKLIST_STEPS,
  XP_PER_STEP,
  CHECKLIST_COMPLETE_ACHIEVEMENT,
  loadChecklistState,
  saveChecklistState,
  doneCount,
  isAllDone,
} from '@/services/frontaliereChecklist';
import { buildPath } from '@/services/router';
import { ACHIEVEMENTS } from '@/services/gamificationService';
import itCalc from '@/services/locales/it-calculator';
import enCalc from '@/services/locales/en-calculator';
import deCalc from '@/services/locales/de-calculator';
import frCalc from '@/services/locales/fr-calculator';

const LOCALE_CHUNKS: Record<string, Record<string, string>> = {
  it: itCalc,
  en: enCalc,
  de: deCalc,
  fr: frCalc,
};

beforeEach(() => {
  localStorage.clear();
});

describe('CHECKLIST_STEPS', () => {
  it('has a coherent set of steps with unique ids', () => {
    expect(CHECKLIST_STEPS.length).toBeGreaterThanOrEqual(6);
    const ids = CHECKLIST_STEPS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every step route builds a canonical trailing-slash path', () => {
    for (const step of CHECKLIST_STEPS) {
      const href = buildPath(step.route, 'it');
      expect(href.startsWith('/'), `${step.id} path must be root-relative: ${href}`).toBe(true);
      expect(href.endsWith('/'), `${step.id} path must end with a trailing slash: ${href}`).toBe(true);
    }
  });

  it('every step title/desc key exists in all 4 locale chunks', () => {
    const missing: string[] = [];
    for (const step of CHECKLIST_STEPS) {
      for (const key of [step.titleKey, step.descKey]) {
        for (const [locale, chunk] of Object.entries(LOCALE_CHUNKS)) {
          if (!chunk[key]) missing.push(`${key} missing in '${locale}'`);
        }
      }
    }
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it('shared checklist UI keys exist in all 4 locale chunks', () => {
    const uiKeys = [
      'checklist.badge', 'checklist.title', 'checklist.subtitle', 'checklist.progress',
      'checklist.xpHint', 'checklist.completedBanner', 'checklist.markDone',
      'checklist.markUndone', 'checklist.stepCta', 'checklist.footerNote', 'checklist.reset',
    ];
    const missing: string[] = [];
    for (const key of uiKeys) {
      for (const [locale, chunk] of Object.entries(LOCALE_CHUNKS)) {
        if (!chunk[key]) missing.push(`${key} missing in '${locale}'`);
      }
    }
    expect(missing, missing.join(', ')).toEqual([]);
  });
});

describe('completion achievement', () => {
  it('is registered in the shared gamification service', () => {
    expect(ACHIEVEMENTS.some(a => a.id === CHECKLIST_COMPLETE_ACHIEVEMENT)).toBe(true);
  });

  it('has a title + description in all 4 locale chunks', () => {
    const keys = [
      `gamification.achievement.${CHECKLIST_COMPLETE_ACHIEVEMENT}`,
      `gamification.achievementDesc.${CHECKLIST_COMPLETE_ACHIEVEMENT}`,
    ];
    for (const key of keys) {
      for (const [locale, chunk] of Object.entries(LOCALE_CHUNKS)) {
        expect(chunk[key], `${key} missing in '${locale}'`).toBeTruthy();
      }
    }
  });
});

describe('checklist state', () => {
  it('returns an empty state when storage is empty', () => {
    const state = loadChecklistState();
    expect(doneCount(state)).toBe(0);
    expect(isAllDone(state)).toBe(false);
  });

  it('round-trips saved progress', () => {
    const first = CHECKLIST_STEPS[0].id;
    saveChecklistState({ done: { [first]: Date.now() }, awarded: { [first]: true } });
    const state = loadChecklistState();
    expect(doneCount(state)).toBe(1);
    expect(state.awarded[first]).toBe(true);
  });

  it('filters invalid persisted step records to known, valid values', () => {
    const [first, second, third] = CHECKLIST_STEPS.map(step => step.id);
    localStorage.setItem('frontaliere_checklist_v1', JSON.stringify({
      done: {
        [first]: 123,
        [second]: 'bad',
        [third]: 0,
        unknown: 456,
      },
      awarded: {
        [first]: true,
        [second]: 'yes',
        [third]: false,
        unknown: true,
      },
      completedAt: -1,
    }));

    const state = loadChecklistState();

    expect(state.done).toEqual({ [first]: 123 });
    expect(state.awarded).toEqual({ [first]: true });
    expect(state.completedAt).toBeUndefined();
    expect(doneCount(state)).toBe(1);
  });

  it('isAllDone is true only when every step is checked', () => {
    const done: Record<string, number> = {};
    for (const step of CHECKLIST_STEPS) done[step.id] = Date.now();
    expect(isAllDone({ done, awarded: {} })).toBe(true);
    delete done[CHECKLIST_STEPS[0].id];
    expect(isAllDone({ done, awarded: {} })).toBe(false);
  });

  it('handles corrupted JSON gracefully', () => {
    localStorage.setItem('frontaliere_checklist_v1', 'NOT_JSON');
    expect(() => loadChecklistState()).not.toThrow();
    expect(doneCount(loadChecklistState())).toBe(0);
  });

  it('grants a positive XP amount per step', () => {
    expect(XP_PER_STEP).toBeGreaterThan(0);
  });

  it('filters unknown steps and invalid persisted values', () => {
    localStorage.setItem('frontaliere_checklist_v1', JSON.stringify({
      done: { unknown: Date.now(), [CHECKLIST_STEPS[0].id]: 'yes', [CHECKLIST_STEPS[1].id]: Date.now() },
      awarded: { unknown: true, [CHECKLIST_STEPS[0].id]: 'true', [CHECKLIST_STEPS[1].id]: true },
      completedAt: Number.POSITIVE_INFINITY,
    }));

    const state = loadChecklistState();
    expect(state.done).toEqual({ [CHECKLIST_STEPS[1].id]: expect.any(Number) });
    expect(state.awarded).toEqual({ [CHECKLIST_STEPS[1].id]: true });
    expect(state.completedAt).toBeUndefined();
    expect(doneCount(state)).toBe(1);
  });
});
