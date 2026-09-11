import { describe, expect, it, vi } from 'vitest';
import { collapseTechnicalDuplicates } from '../scripts/build-employer-insights.mjs';

/**
 * V6 §1 — the page-view identity is bound to the history entry at the instant
 * the navigation is observed, synchronously, by the code that observes it.
 *
 * This module is the single place that decides that identity. It is a leaf on
 * purpose: the lazy analytics proxy must be able to call it without pulling in
 * Firebase, so the binding happens at call time instead of inside the `.then()`
 * of a dynamic import — which is where the identity used to be re-derived from
 * whatever entry happened to be current by then.
 *
 * The invariant is symmetric and both directions are defects:
 *   - two emissions of the SAME navigation share the id  → one observed unit;
 *   - two REAL distinct navigations never share it       → two observed units.
 * When the entry is not determinable the answer is `null` — "dedup non
 * disponibile" — never a guessed id.
 */

/**
 * A History that models entries: `pushState` opens a NEW entry, so a state
 * written after it cannot be read back from the previous one. A single-entry
 * mock cannot tell a synchronous capture apart from a late one.
 */
function createHistoryStack(initialState: unknown) {
  const entries: { state: unknown }[] = [{ state: initialState }];
  let index = 0;
  return {
    get length() { return entries.length; },
    get state() { return entries[index].state; },
    get entryCount() { return entries.length; },
    pushState(state: unknown) {
      entries.splice(index + 1);
      entries.push({ state });
      index = entries.length - 1;
    },
    replaceState(state: unknown) {
      entries[index].state = state;
    },
  };
}

function stubWindowWith(history: unknown) {
  vi.stubGlobal('window', { history, location: { origin: 'https://example.test', pathname: '/' } });
}

const loadEntryModule = async () =>
  vi.importActual<typeof import('@/services/pageViewHistoryEntry')>('@/services/pageViewHistoryEntry');

describe('page-view history entry identity', () => {
  it('gives two real navigations two distinct ids, captured synchronously', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();
    const history = createHistoryStack({ route: { activeTab: 'job-board' } });
    stubWindowWith(history);

    try {
      // Two real navigations to the same route. Each capture happens while its
      // own entry is current — not after the next one has already opened.
      history.pushState({ route: { activeTab: 'job-board' } });
      const first = ensureCurrentPageViewHistoryEntryId();
      history.pushState({ route: { activeTab: 'job-board' } });
      const second = ensureCurrentPageViewHistoryEntryId();

      expect(first).toEqual(expect.any(String));
      expect(second).toEqual(expect.any(String));
      expect(second).not.toBe(first);

      const result = collapseTechnicalDuplicates([
        { event: '$pageview', observed: 1, emissionId: first as string },
        { event: '$pageview', observed: 1, emissionId: second as string },
      ]);
      expect(result).toMatchObject({ observed: 2, removed: 0, dedupUnavailable: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives one navigation the same id however many times it is captured', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();
    const history = createHistoryStack({ route: { activeTab: 'job-board' } });
    stubWindowWith(history);

    try {
      history.pushState({ route: { activeTab: 'job-board' } });
      const first = ensureCurrentPageViewHistoryEntryId();
      const dualEmission = ensureCurrentPageViewHistoryEntryId();
      const identityRetry = ensureCurrentPageViewHistoryEntryId();

      expect(first).toEqual(expect.any(String));
      expect(dualEmission).toBe(first);
      expect(identityRetry).toBe(first);

      const result = collapseTechnicalDuplicates([
        { event: '$pageview', observed: 1, emissionId: first as string },
        { event: '$pageview', observed: 1, emissionId: dualEmission as string },
      ]);
      expect(result).toMatchObject({ observed: 1, removed: 1, dedupUnavailable: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves the application state already on the entry', async () => {
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule();
    const history = createHistoryStack({ route: { activeTab: 'job-board', jobSlug: 'a-role' } });
    stubWindowWith(history);

    try {
      const entryId = ensureCurrentPageViewHistoryEntryId();
      expect(history.state).toEqual({
        route: { activeTab: 'job-board', jobSlug: 'a-role' },
        [PAGE_VIEW_HISTORY_STATE_KEY]: entryId,
      });
      // Allocating an identity must not open a history entry.
      expect(history.entryCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allocates on a null state without inventing application state', async () => {
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule();
    const history = createHistoryStack(null);
    stubWindowWith(history);

    try {
      const entryId = ensureCurrentPageViewHistoryEntryId();
      expect(entryId).toEqual(expect.any(String));
      expect(history.state).toEqual({ [PAGE_VIEW_HISTORY_STATE_KEY]: entryId });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" for a primitive state it must not overwrite', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();
    // Another navigation owner holds this entry's state. Overwriting it would
    // break that owner; guessing an id would fabricate an observation.
    stubWindowWith({ length: 2, state: 'owned-by-another-navigation', replaceState: vi.fn() });

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" for an array state', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();
    stubWindowWith({ length: 2, state: [1, 2, 3], replaceState: vi.fn() });

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" when replaceState is missing or refuses', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();

    stubWindowWith({ length: 2, state: null });
    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    stubWindowWith({
      length: 2,
      state: null,
      replaceState: () => { throw new Error('SecurityError: history is not writable here'); },
    });
    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" when replaceState silently does not take', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();
    // A host that accepts the call and keeps its own state: reporting the id we
    // tried to write would claim an identity the entry does not carry.
    stubWindowWith({ length: 2, state: null, replaceState: vi.fn() });

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" without a window or a history', async () => {
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule();

    vi.stubGlobal('window', undefined);
    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal('window', { location: { origin: 'https://example.test', pathname: '/' } });
    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads back an id already on the entry instead of allocating a new one', async () => {
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule();
    const history = createHistoryStack({ route: { activeTab: 'stats' }, [PAGE_VIEW_HISTORY_STATE_KEY]: 'already-here' });
    const replaceState = vi.spyOn(history, 'replaceState');
    stubWindowWith(history);

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBe('already-here');
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      replaceState.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
