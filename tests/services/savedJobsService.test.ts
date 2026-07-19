/**
 * Unit tests for `services/savedJobsService.ts` (epic #4465, #4466/#4467).
 *
 * Covers the three pure surfaces of the service:
 *  - saved-list persistence: toggle add/remove, dedupe, cap, defensive load;
 *  - alert-criteria derivation: category/canton majority vote, tie-break on
 *    recency, canton-code validation;
 *  - nudge gating: threshold, dismiss cooldown (relative dates only — no
 *    absolute-date time bombs), terminal accept, immutability.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSavedJobs,
  toggleSavedJob,
  isJobSaved,
  deriveSavedJobsAlertCriteria,
  loadNudgeState,
  saveNudgeState,
  shouldShowSavedJobsNudge,
  recordNudgeDismissed,
  recordNudgeAccepted,
  SAVED_JOBS_STORAGE_KEY,
  SAVED_JOBS_CHANGED_EVENT,
  SAVED_JOBS_CAP,
  SAVED_JOBS_NUDGE_STORAGE_KEY,
  SAVED_JOBS_NUDGE_THRESHOLD,
  NUDGE_DISMISS_COOLDOWN_MS,
  type SavedJobEntry,
  type SavedJobsNudgeState,
} from '@/services/savedJobsService';

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(id: string, overrides: Partial<SavedJobEntry> = {}): Omit<SavedJobEntry, 'savedAt'> {
  return {
    id,
    slug: `${id}-slug`,
    title: `Job ${id}`,
    company: 'ACME SA',
    canton: 'TI',
    category: 'tech',
    ...overrides,
  };
}

function savedEntry(id: string, overrides: Partial<SavedJobEntry> = {}): SavedJobEntry {
  return { ...entry(id), savedAt: 0, ...overrides };
}

describe('savedJobsService — persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(loadSavedJobs()).toEqual([]);
    expect(isJobSaved('nope')).toBe(false);
  });

  it('toggle adds then removes a job', () => {
    expect(toggleSavedJob(entry('a'))).toBe(true);
    expect(loadSavedJobs().map((e) => e.id)).toEqual(['a']);
    expect(isJobSaved('a')).toBe(true);

    expect(toggleSavedJob(entry('a'))).toBe(false);
    expect(loadSavedJobs()).toEqual([]);
    expect(isJobSaved('a')).toBe(false);
  });

  it('preserves insertion order and snapshots fields', () => {
    toggleSavedJob(entry('a'));
    toggleSavedJob(entry('b', { canton: 'GR', category: 'health' }));
    const list = loadSavedJobs();
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ canton: 'GR', category: 'health', company: 'ACME SA' });
    expect(list[0].savedAt).toBeGreaterThan(0);
  });

  it('dispatches the changed event on every mutation', () => {
    let fired = 0;
    const onChanged = () => { fired += 1; };
    window.addEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
    try {
      toggleSavedJob(entry('a'));
      toggleSavedJob(entry('a'));
      expect(fired).toBe(2);
    } finally {
      window.removeEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
    }
  });

  it('caps the persisted list, dropping oldest first', () => {
    for (let i = 0; i < SAVED_JOBS_CAP + 5; i++) {
      toggleSavedJob(entry(`job-${i}`));
    }
    const list = loadSavedJobs();
    expect(list.length).toBe(SAVED_JOBS_CAP);
    expect(list[0].id).toBe('job-5'); // 0..4 dropped
    expect(list[list.length - 1].id).toBe(`job-${SAVED_JOBS_CAP + 4}`);
  });

  it('survives malformed persisted JSON', () => {
    localStorage.setItem(SAVED_JOBS_STORAGE_KEY, '{not-json');
    expect(loadSavedJobs()).toEqual([]);
  });

  it('ignores unknown envelope versions and junk entries', () => {
    localStorage.setItem(SAVED_JOBS_STORAGE_KEY, JSON.stringify({ version: 99, jobs: [{ id: 'x' }] }));
    expect(loadSavedJobs()).toEqual([]);
    localStorage.setItem(
      SAVED_JOBS_STORAGE_KEY,
      JSON.stringify({ version: 1, jobs: [{ id: 'ok' }, { nope: true }, 42, { id: 'ok' }] }),
    );
    const list = loadSavedJobs();
    expect(list.map((e) => e.id)).toEqual(['ok']); // junk + duplicate dropped
  });
});

describe('savedJobsService — deriveSavedJobsAlertCriteria', () => {
  it('returns nulls for an empty list', () => {
    expect(deriveSavedJobsAlertCriteria([])).toEqual({ category: null, cantonCode: null });
  });

  it('picks the majority category and canton', () => {
    const criteria = deriveSavedJobsAlertCriteria([
      savedEntry('a', { category: 'tech', canton: 'TI', savedAt: 1 }),
      savedEntry('b', { category: 'tech', canton: 'TI', savedAt: 2 }),
      savedEntry('c', { category: 'health', canton: 'GR', savedAt: 3 }),
    ]);
    expect(criteria).toEqual({ category: 'tech', cantonCode: 'TI' });
  });

  it('breaks ties toward the most recently saved value', () => {
    const criteria = deriveSavedJobsAlertCriteria([
      savedEntry('a', { category: 'tech', canton: 'TI', savedAt: 1 }),
      savedEntry('b', { category: 'health', canton: 'GR', savedAt: 2 }),
    ]);
    expect(criteria.category).toBe('health');
    expect(criteria.cantonCode).toBe('GR');
  });

  it('ignores missing fields and normalizes canton case', () => {
    const criteria = deriveSavedJobsAlertCriteria([
      savedEntry('a', { category: null, canton: 'ti', savedAt: 1 }),
      savedEntry('b', { category: 'tech', canton: null, savedAt: 2 }),
    ]);
    expect(criteria).toEqual({ category: 'tech', cantonCode: 'TI' });
  });

  it('rejects a dominant canton that is not a real canton code', () => {
    const criteria = deriveSavedJobsAlertCriteria([
      savedEntry('a', { canton: 'Lugano', savedAt: 1 }),
      savedEntry('b', { canton: 'Lugano', savedAt: 2 }),
    ]);
    expect(criteria.cantonCode).toBeNull();
  });
});

describe('savedJobsService — nudge gating', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const now = new Date();
  const fresh = (): SavedJobsNudgeState => ({ dismissedAt: null, acceptedAt: null });

  it('load returns defaults when empty or malformed', () => {
    expect(loadNudgeState()).toEqual(fresh());
    localStorage.setItem(SAVED_JOBS_NUDGE_STORAGE_KEY, '{not-json');
    expect(loadNudgeState()).toEqual(fresh());
  });

  it('save/load round-trips', () => {
    const state = recordNudgeDismissed(fresh(), now);
    saveNudgeState(state);
    expect(loadNudgeState()).toEqual(state);
  });

  it('hides below the saved-count threshold', () => {
    expect(shouldShowSavedJobsNudge(SAVED_JOBS_NUDGE_THRESHOLD - 1, fresh(), now)).toBe(false);
    expect(shouldShowSavedJobsNudge(SAVED_JOBS_NUDGE_THRESHOLD, fresh(), now)).toBe(true);
  });

  it('respects the dismiss cooldown with relative dates', () => {
    const dismissed = recordNudgeDismissed(fresh(), new Date(now.getTime() - DAY_MS));
    // 1 day ago < 14-day cooldown → suppressed
    expect(shouldShowSavedJobsNudge(5, dismissed, now)).toBe(false);
    // beyond cooldown → shown again
    const longAgo = recordNudgeDismissed(fresh(), new Date(now.getTime() - NUDGE_DISMISS_COOLDOWN_MS - DAY_MS));
    expect(shouldShowSavedJobsNudge(5, longAgo, now)).toBe(true);
  });

  it('accept is terminal — nudge never returns', () => {
    const accepted = recordNudgeAccepted(fresh(), new Date(now.getTime() - 365 * DAY_MS));
    expect(shouldShowSavedJobsNudge(99, accepted, now)).toBe(false);
  });

  it('state transitions are immutable', () => {
    const base = fresh();
    const dismissed = recordNudgeDismissed(base, now);
    const accepted = recordNudgeAccepted(base, now);
    expect(base).toEqual(fresh());
    expect(dismissed.dismissedAt).toBe(now.getTime());
    expect(accepted.acceptedAt).toBe(now.getTime());
  });
});
