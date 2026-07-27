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

import { describe, it, expect, beforeEach, vi } from 'vitest';

// `services/savedJobsService.ts` now writes to Firestore behind auth
// (account-gating follow-up to #4466/#4467). The persistence describe block
// below drives the real `toggleSavedJob`/`subscribeSavedJobsFirestore` code
// paths. `firebase/firestore` ships conditional exports (`node` vs `browser`
// entry points) that defeat `vi.mock`'s interception of the dynamic
// `import('firebase/firestore')` inside the service under jsdom — so the
// fake module is injected directly via `__setFirestoreModuleForTests`
// instead of relying on module-registry mocking.
const firestoreStore = new Map<string, Record<string, unknown>>();

const setDocMock = vi.fn(async (...args: unknown[]) => {
  const ref = args[0] as { id: string; isSavedJobDoc: boolean };
  const data = args[1] as Record<string, unknown>;
  if (ref.isSavedJobDoc) firestoreStore.set(ref.id, data);
});
const deleteDocMock = vi.fn(async (...args: unknown[]) => {
  const ref = args[0] as { id: string };
  firestoreStore.delete(ref.id);
});
const getDocMock = vi.fn(async (..._args: unknown[]) => ({ exists: () => false }));
const commitMock = vi.fn(async () => undefined);
const batchSetMock = vi.fn((...args: unknown[]) => {
  const ref = args[0] as { id: string };
  const data = args[1] as Record<string, unknown>;
  firestoreStore.set(ref.id, data);
});

const mockFirestoreModule = {
  doc: vi.fn((...args: unknown[]) => {
    const segments = args.slice(1) as string[];
    return {
      id: segments[segments.length - 1],
      // `doc(db, 'users', uid, 'savedJobs', jobId)` vs the shorter
      // `doc(db, 'users', uid)` profile-doc ref — keeps profile writes out
      // of the fake savedJobs collection below.
      isSavedJobDoc: segments.length === 4 && segments[2] === 'savedJobs',
    };
  }),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  deleteDoc: (...args: unknown[]) => deleteDocMock(...args),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  collection: vi.fn(() => ({})),
  query: vi.fn(() => ({})),
  orderBy: vi.fn(() => ({})),
  writeBatch: vi.fn(() => ({ set: batchSetMock, commit: commitMock })),
  onSnapshot: vi.fn((...args: unknown[]) => {
    const onNext = args[1] as (snap: {
      forEach: (cb: (docSnap: { id: string; data: () => Record<string, unknown> }) => void) => void;
    }) => void;
    onNext({
      forEach: (cb) => {
        for (const [id, data] of firestoreStore.entries()) cb({ id, data: () => data });
      },
    });
    return vi.fn();
  }),
  getFirestore: vi.fn(() => ({})),
} as unknown as typeof import('firebase/firestore');

import {
  loadSavedJobs,
  toggleSavedJob,
  isJobSaved,
  subscribeSavedJobsFirestore,
  __resetSavedJobsCacheForTests,
  __setFirestoreModuleForTests,
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
    firestoreStore.clear();
    setDocMock.mockClear();
    deleteDocMock.mockClear();
    getDocMock.mockClear();
    commitMock.mockClear();
    batchSetMock.mockClear();
    __resetSavedJobsCacheForTests();
    __setFirestoreModuleForTests(mockFirestoreModule);
  });

  it('starts empty', () => {
    expect(loadSavedJobs()).toEqual([]);
    expect(isJobSaved('nope')).toBe(false);
  });

  it('refuses to save without a uid, cache stays untouched', () => {
    expect(toggleSavedJob(entry('a'), null)).toBe('auth_required');
    expect(loadSavedJobs()).toEqual([]);
    expect(isJobSaved('a')).toBe(false);
  });

  it('toggle adds then removes a job for a signed-in user', async () => {
    expect(toggleSavedJob(entry('a'), 'test-uid')).toBe('saved');
    expect(loadSavedJobs().map((e) => e.id)).toEqual(['a']);
    expect(isJobSaved('a')).toBe(true);

    expect(toggleSavedJob(entry('a'), 'test-uid')).toBe('unsaved');
    expect(loadSavedJobs()).toEqual([]);
    expect(isJobSaved('a')).toBe(false);

    // Drain the fire-and-forget Firestore writes (see the "caps" test below for why).
    await vi.waitFor(() => expect(setDocMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deleteDocMock).toHaveBeenCalledTimes(1));
  });

  it('preserves insertion order and snapshots fields', async () => {
    toggleSavedJob(entry('a'), 'test-uid');
    toggleSavedJob(entry('b', { canton: 'GR', category: 'health' }), 'test-uid');
    const list = loadSavedJobs();
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ canton: 'GR', category: 'health', company: 'ACME SA' });
    expect(list[0].savedAt).toBeGreaterThan(0);

    await vi.waitFor(() => expect(setDocMock).toHaveBeenCalledTimes(2));
  });

  it('dispatches the changed event on every mutation', async () => {
    let fired = 0;
    const onChanged = () => { fired += 1; };
    window.addEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
    try {
      toggleSavedJob(entry('a'), 'test-uid');
      toggleSavedJob(entry('a'), 'test-uid');
      expect(fired).toBe(2);
    } finally {
      window.removeEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
    }

    await vi.waitFor(() => expect(setDocMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deleteDocMock).toHaveBeenCalledTimes(1));
  });

  it('caps the persisted list, dropping oldest first', async () => {
    for (let i = 0; i < SAVED_JOBS_CAP + 5; i++) {
      toggleSavedJob(entry(`job-${i}`), 'test-uid');
    }
    const list = loadSavedJobs();
    expect(list.length).toBe(SAVED_JOBS_CAP);
    expect(list[0].id).toBe('job-5'); // 0..4 dropped
    expect(list[list.length - 1].id).toBe(`job-${SAVED_JOBS_CAP + 4}`);
    // Drain the fire-and-forget `void writeSavedJobDoc(...)`/`void deleteSavedJobDoc(...)`
    // calls before the next test's `beforeEach` clears firestoreStore — otherwise these
    // pending writes land mid-flight in the next test and pollute its onSnapshot read.
    await vi.waitFor(() => expect(setDocMock).toHaveBeenCalledTimes(SAVED_JOBS_CAP + 5));
    await vi.waitFor(() => expect(deleteDocMock).toHaveBeenCalledTimes(5));
  });

  it('migration: carries forward pre-existing localStorage saves into Firestore on first subscribe', async () => {
    localStorage.setItem(
      SAVED_JOBS_STORAGE_KEY,
      JSON.stringify({ version: 1, jobs: [savedEntry('x1', { savedAt: 111 })] }),
    );
    const unsubscribe = subscribeSavedJobsFirestore('test-uid', { email: 'a@b.ch', locale: 'it' });
    await vi.waitFor(() => expect(loadSavedJobs().map((e) => e.id)).toEqual(['x1']));
    expect(localStorage.getItem(SAVED_JOBS_STORAGE_KEY)).toBeNull();
    unsubscribe();
  });

  it('migration: filters junk entries and dedupes by id before writing to Firestore', async () => {
    localStorage.setItem(
      SAVED_JOBS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        jobs: [savedEntry('ok', { savedAt: 111 }), { nope: true }, 42, savedEntry('ok', { savedAt: 222 })],
      }),
    );
    const unsubscribe = subscribeSavedJobsFirestore('test-uid', { email: 'a@b.ch', locale: 'it' });
    await vi.waitFor(() => expect(loadSavedJobs().map((e) => e.id)).toEqual(['ok'])); // junk + duplicate dropped
    unsubscribe();
  });

  it('migration: survives corrupt localStorage without writing to Firestore', async () => {
    localStorage.setItem(SAVED_JOBS_STORAGE_KEY, '{not-json');
    const unsubscribe = subscribeSavedJobsFirestore('test-uid', { email: 'a@b.ch', locale: 'it' });
    await vi.waitFor(() => expect(getDocMock).toHaveBeenCalled());
    expect(commitMock).not.toHaveBeenCalled();
    expect(loadSavedJobs()).toEqual([]);
    unsubscribe();
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
