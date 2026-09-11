import { describe, expect, it, vi } from 'vitest';
import { collapseTechnicalDuplicates } from '../scripts/build-employer-insights.mjs';

/**
 * V8 D1 — the page-view identity is coined when its History entry is opened by
 * the eager `pushState`/`replaceState` wrappers in the leaf module.
 *
 * This module is the single place that decides that identity. It is a leaf on
 * purpose: the lazy analytics proxy must be able to call it without pulling in
 * Firebase, while the wrapper itself is installed before navigation can happen.
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

const loadEntryModule = async (history?: unknown) => {
  vi.resetModules();
  if (history !== undefined) stubWindowWith(history);
  return vi.importActual<typeof import('@/services/pageViewHistoryEntry')>('@/services/pageViewHistoryEntry');
};

describe('page-view history entry identity', () => {
  it('does not let a copied state inherit the id of a newly pushed entry', async () => {
    const entries: { state: unknown }[] = [{ state: { route: { activeTab: 'job-board' } } }];
    let index = 0;
    const history = {
      get length() { return entries.length; },
      get state() { return entries[index].state; },
      pushState(state: unknown) {
        entries.splice(index + 1);
        entries.push({ state: structuredClone(state) });
        index = entries.length - 1;
      },
      replaceState(state: unknown) {
        entries[index].state = state;
      },
    };
    stubWindowWith(history);

    try {
      // Load after installing the browser mock: the real browser module must
      // patch History eagerly, before this first navigation can happen.
      vi.resetModules();
      const { ensureCurrentPageViewHistoryEntryId } = await import('@/services/pageViewHistoryEntry');
      const first = ensureCurrentPageViewHistoryEntryId();
      history.pushState(history.state);
      const second = ensureCurrentPageViewHistoryEntryId();

      expect({ entryCount: entries.length, sameId: first === second }).toEqual({ entryCount: 2, sameId: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not trust an id already present when the wrapper cannot install', async () => {
    const key = '__frontaliere_page_view_entry_id';
    const history = {
      state: { route: { activeTab: 'job-board' }, [key]: 'inherited-id' },
      replaceState: vi.fn(),
      pushState: vi.fn(),
    };
    Object.defineProperty(history, 'pushState', { writable: false });
    stubWindowWith(history);

    try {
      vi.resetModules();
      const { ensureCurrentPageViewHistoryEntryId } = await import('@/services/pageViewHistoryEntry');
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives two real navigations two distinct ids, captured synchronously', async () => {
    const history = createHistoryStack({ route: { activeTab: 'job-board' } });
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(history);

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
    const history = createHistoryStack({ route: { activeTab: 'job-board' } });
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(history);

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
    const history = createHistoryStack({ route: { activeTab: 'job-board', jobSlug: 'a-role' } });
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule(history);

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
    const history = createHistoryStack(null);
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule(history);

    try {
      const entryId = ensureCurrentPageViewHistoryEntryId();
      expect(entryId).toEqual(expect.any(String));
      expect(history.state).toEqual({ [PAGE_VIEW_HISTORY_STATE_KEY]: entryId });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" for a primitive state it must not overwrite', async () => {
    // Another navigation owner holds this entry's state. Overwriting it would
    // break that owner; guessing an id would fabricate an observation.
    const history = { length: 2, state: 'owned-by-another-navigation', replaceState: vi.fn(), pushState: vi.fn() };
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(history);

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" for an array state', async () => {
    const history = { length: 2, state: [1, 2, 3], replaceState: vi.fn(), pushState: vi.fn() };
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(history);

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" when replaceState is missing or refuses', async () => {
    const missingReplaceState = { length: 2, state: null, pushState: vi.fn() };
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(missingReplaceState);
    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    const refusingReplaceState = {
      length: 2,
      state: null,
      pushState: vi.fn(),
      replaceState: () => { throw new Error('SecurityError: history is not writable here'); },
    };
    const refusingModule = await loadEntryModule(refusingReplaceState);
    try {
      expect(refusingModule.ensureCurrentPageViewHistoryEntryId()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers "not determinable" when replaceState silently does not take', async () => {
    // A host that accepts the call and keeps its own state: reporting the id we
    // tried to write would claim an identity the entry does not carry.
    const history = { length: 2, state: null, pushState: vi.fn(), replaceState: vi.fn() };
    const { ensureCurrentPageViewHistoryEntryId } = await loadEntryModule(history);

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
    const history = createHistoryStack({ route: { activeTab: 'stats' }, __frontaliere_page_view_entry_id: 'already-here' });
    const replaceState = vi.spyOn(history, 'replaceState');
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule(history);

    try {
      expect(ensureCurrentPageViewHistoryEntryId()).toBe('already-here');
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      replaceState.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('preserves the current id when replaceState updates the same entry', async () => {
    const history = createHistoryStack({ route: { activeTab: 'stats' } });
    const { ensureCurrentPageViewHistoryEntryId, PAGE_VIEW_HISTORY_STATE_KEY } = await loadEntryModule(history);

    try {
      const first = ensureCurrentPageViewHistoryEntryId();
      history.replaceState({ route: { activeTab: 'job-board' }, [PAGE_VIEW_HISTORY_STATE_KEY]: 'stale-id' });

      expect(history.state).toMatchObject({
        route: { activeTab: 'job-board' },
        [PAGE_VIEW_HISTORY_STATE_KEY]: first,
      });
      expect(ensureCurrentPageViewHistoryEntryId()).toBe(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
