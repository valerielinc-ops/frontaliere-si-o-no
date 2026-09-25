/**
 * Frontaliere Checklist — Pure data & state management (no React, no Analytics).
 *
 * Mirrors the intentionally dependency-free shape of `gamificationService.ts`:
 * this module owns the "Percorso frontaliere" step definitions and the
 * localStorage-backed progress state, so it can be unit-tested in Node and
 * imported without pulling React/vendor chunks. The React view
 * (`components/community/FrontaliereChecklist.tsx`) owns side effects
 * (XP awards via gamificationService, PostHog events).
 *
 * Each step links to an EXISTING guide/tool route (progressive disclosure over
 * the funnel — the checklist is a page with links, not a standalone app).
 */

import type { AppRoute } from '@/services/router';

// ─── Step definitions ────────────────────────────────────────────────────────

export interface ChecklistStep {
  /** Stable id — persisted in localStorage and used as the i18n key segment. */
  id: string;
  /** Router route the step links to (buildPath adds the canonical trailing slash). */
  route: AppRoute;
  /** i18n key for the step title (defined in all 4 locale `-calculator` chunks). */
  titleKey: string;
  /** i18n key for the step description. */
  descKey: string;
}

/**
 * The frontaliere onboarding journey, ordered as a new cross-border worker
 * would tackle it. Every route already exists in the app (verified against
 * `components/pages/SiteMapPage.tsx` / `services/internalLinks.ts`).
 */
export const CHECKLIST_STEPS: ChecklistStep[] = [
  {
    id: 'permesso_g',
    route: { activeTab: 'guida', guidaSubTab: 'permits' },
    titleKey: 'checklist.step.permesso_g.title',
    descKey: 'checklist.step.permesso_g.desc',
  },
  {
    id: 'contratto',
    route: { activeTab: 'contracts' },
    titleKey: 'checklist.step.contratto.title',
    descKey: 'checklist.step.contratto.desc',
  },
  {
    id: 'conto_chf',
    route: { activeTab: 'confronti', confrontiSubTab: 'banks' },
    titleKey: 'checklist.step.conto_chf.title',
    descKey: 'checklist.step.conto_chf.desc',
  },
  {
    id: 'lamal',
    route: { activeTab: 'confronti', confrontiSubTab: 'health' },
    titleKey: 'checklist.step.lamal.title',
    descKey: 'checklist.step.lamal.desc',
  },
  {
    id: 'dogana_targa',
    route: { activeTab: 'guida', guidaSubTab: 'car-transfer' },
    titleKey: 'checklist.step.dogana_targa.title',
    descKey: 'checklist.step.dogana_targa.desc',
  },
  {
    id: 'imposta_fonte',
    route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' },
    titleKey: 'checklist.step.imposta_fonte.title',
    descKey: 'checklist.step.imposta_fonte.desc',
  },
  {
    id: 'prima_busta',
    route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
    titleKey: 'checklist.step.prima_busta.title',
    descKey: 'checklist.step.prima_busta.desc',
  },
  {
    id: 'primo_giorno',
    route: { activeTab: 'guida', guidaSubTab: 'first-day' },
    titleKey: 'checklist.step.primo_giorno.title',
    descKey: 'checklist.step.primo_giorno.desc',
  },
];

/** XP granted the first time each step is checked (monotonic — never re-awarded). */
export const XP_PER_STEP = 15;

/**
 * Achievement unlocked when every step is checked. Defined in
 * `gamificationService.ts` ACHIEVEMENTS so the toast/progress UI render it and
 * the standard +50 XP reward applies.
 */
export const CHECKLIST_COMPLETE_ACHIEVEMENT = 'frontaliere_path';

const STORAGE_KEY = 'frontaliere_checklist_v1';

// ─── State management ────────────────────────────────────────────────────────

export interface ChecklistState {
  /** stepId → timestamp of the current checked state (removed when unchecked). */
  done: Record<string, number>;
  /** stepId → true once XP has ever been granted (anti-farm; survives uncheck). */
  awarded: Record<string, true>;
  /** Timestamp when all steps were first completed (guards the completion reward). */
  completedAt?: number;
}

export function loadChecklistState(): ChecklistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        done: parsed.done || {},
        awarded: parsed.awarded || {},
        completedAt: typeof parsed.completedAt === 'number' ? parsed.completedAt : undefined,
      };
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return { done: {}, awarded: {} };
}

export function saveChecklistState(state: ChecklistState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
}

/** Number of steps currently checked. */
export function doneCount(state: ChecklistState): number {
  return CHECKLIST_STEPS.reduce((n, step) => n + (state.done[step.id] ? 1 : 0), 0);
}

/** Whether every step is currently checked. */
export function isAllDone(state: ChecklistState): boolean {
  return CHECKLIST_STEPS.every(step => !!state.done[step.id]);
}
