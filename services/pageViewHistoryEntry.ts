/**
 * pageViewHistoryEntry — the one place that decides a page view's identity.
 *
 * A page view is one act of navigation. Its identity is the history entry it
 * happens on, and it is coined by the code that opens that entry: the eager
 * `pushState`/`replaceState` wrappers below. The value then travels forward as
 * an argument. Nothing downstream re-derives it from ambient
 * `window.history.state`.
 *
 * That rule is the whole design, and it makes both failure directions
 * impossible by construction rather than by discipline:
 *
 *   - two emissions of the SAME act (Firebase + PostHog, or a retry after the
 *     employer identity resolves) read the same entry → they share the id →
 *     downstream deduplication collapses them to ONE observed unit;
 *   - two REAL distinct navigations open two entries → two fresh ids → TWO
 *     observed units.
 *
 * The defect this replaces was trusting a late read: a new entry could be
 * opened with `pushState(history.state)`, carrying the previous id with it.
 * The push wrapper always overwrites that stale value with a fresh id; the
 * replace wrapper preserves the id of the entry that already exists.
 *
 * When the entry cannot be determined the answer is `null` — "dedup non
 * disponibile" — never a guessed id. A fabricated identity would silently
 * become an observed count that nothing measured.
 *
 * This module is deliberately a LEAF: no imports and no Firebase. In a
 * browser it EAGERLY patches the current History at module evaluation, before
 * navigation can happen; the `typeof window` guard keeps the same module safe
 * when Node evaluates it during SSG.
 */

export const PAGE_VIEW_HISTORY_STATE_KEY = '__frontaliere_page_view_entry_id';

type HistoryStateRecord = Record<string, unknown>;

/** Create one non-identifying key shared by all provider emissions of one action. */
export function createAnalyticsEmissionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through to a local key when Web Crypto is unavailable.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Only a plain object can carry our key without destroying someone else's
 * state. A primitive, an array or a class instance belongs to another
 * navigation owner: we read it, we never rewrite it.
 */
export function isHistoryStateRecord(value: unknown): value is HistoryStateRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function readPageViewHistoryEntryId(state: unknown): string | null {
  if (!isHistoryStateRecord(state)) return null;
  const value = state[PAGE_VIEW_HISTORY_STATE_KEY];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function stateForNewPageViewHistoryEntry(state: unknown, entryId: string): HistoryStateRecord | null {
  if (state == null) return { [PAGE_VIEW_HISTORY_STATE_KEY]: entryId };
  if (!isHistoryStateRecord(state)) return null;
  return { ...state, [PAGE_VIEW_HISTORY_STATE_KEY]: entryId };
}

export function stateForReplacedPageViewHistoryEntry(
  state: unknown,
  currentEntryId: string | null,
  entryId: string,
): HistoryStateRecord | null {
  const preservedEntryId = currentEntryId || entryId;
  if (state == null) return { [PAGE_VIEW_HISTORY_STATE_KEY]: preservedEntryId };
  if (!isHistoryStateRecord(state)) return null;
  return {
    ...state,
    [PAGE_VIEW_HISTORY_STATE_KEY]: preservedEntryId,
  };
}

type PageViewHistoryPatch = {
  patchedPushState?: History['pushState'];
  patchedReplaceState?: History['replaceState'];
  pushStateInstalled: boolean;
  replaceStateInstalled: boolean;
};

const pageViewHistoryPatches = new WeakMap<object, PageViewHistoryPatch>();
const PAGE_VIEW_HISTORY_PATCH_MARKER = Symbol.for('frontaliere.pageViewHistoryEntry.patch');

function installPageViewHistoryEntryWrappers(): void {
  if (typeof window === 'undefined') return;
  const historyRef = (window as unknown as { history?: History }).history;
  if (!historyRef || (typeof historyRef !== 'object' && typeof historyRef !== 'function')) return;

  const historyObject = historyRef as unknown as object;
  if (pageViewHistoryPatches.has(historyObject)) return;
  const markedPatch = (historyRef as unknown as Record<PropertyKey, unknown>)[PAGE_VIEW_HISTORY_PATCH_MARKER];
  if (markedPatch && typeof markedPatch === 'object') {
    pageViewHistoryPatches.set(historyObject, markedPatch as PageViewHistoryPatch);
    return;
  }

  const originalPushState = (historyRef as unknown as { pushState?: History['pushState'] }).pushState;
  const originalReplaceState = (historyRef as unknown as { replaceState?: History['replaceState'] }).replaceState;
  const patch: PageViewHistoryPatch = {
    pushStateInstalled: false,
    replaceStateInstalled: false,
  };

  if (typeof originalPushState === 'function') {
    const patchedPushState = function patchedPageViewPushState(
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      const entryId = createAnalyticsEmissionId();
      const nextState = stateForNewPageViewHistoryEntry(state, entryId);
      return originalPushState.call(this, nextState || state, unused, url);
    } as History['pushState'];
    try {
      historyRef.pushState = patchedPushState;
      patch.patchedPushState = patchedPushState;
      patch.pushStateInstalled = historyRef.pushState === patchedPushState;
    } catch {
      // A constrained host may expose a non-writable History API.
    }
  }

  if (typeof originalReplaceState === 'function') {
    const patchedReplaceState = function patchedPageViewReplaceState(
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      let currentState: unknown;
      try {
        currentState = this.state;
      } catch {
        return originalReplaceState.call(this, state, unused, url);
      }
      const currentEntryId = readPageViewHistoryEntryId(currentState);
      const entryId = currentEntryId || createAnalyticsEmissionId();
      const nextState = stateForReplacedPageViewHistoryEntry(state, currentEntryId, entryId);
      return originalReplaceState.call(this, nextState || state, unused, url);
    } as History['replaceState'];
    try {
      historyRef.replaceState = patchedReplaceState;
      patch.patchedReplaceState = patchedReplaceState;
      patch.replaceStateInstalled = historyRef.replaceState === patchedReplaceState;
    } catch {
      // A constrained host may expose a non-writable History API.
    }
  }

  try {
    Object.defineProperty(historyRef, PAGE_VIEW_HISTORY_PATCH_MARKER, {
      configurable: false,
      enumerable: false,
      value: patch,
      writable: false,
    });
  } catch {
    // The local WeakMap still keeps repeated installation idempotent here.
  }
  pageViewHistoryPatches.set(historyObject, patch);
}

/**
 * Read the identity already coined for the entry that is current RIGHT NOW.
 * For the initial entry, ask the eager `replaceState` wrapper to coin it in
 * place. Synchronous by contract: the value describes this entry, not a new
 * navigation.
 *
 * Returns `null` whenever the entry cannot be identified without lying: no
 * window, no history, a state we must not overwrite, a host that refuses
 * `replaceState`, or one that accepts it and quietly keeps its own state. In
 * every one of those cases the honest downstream answer is "dedup non
 * disponibile", and the caller must not substitute a number for it.
 */
export function ensureCurrentPageViewHistoryEntryId(): string | null {
  if (typeof window === 'undefined') return null;
  const historyRef = (window as unknown as { history?: History }).history;
  if (!historyRef) return null;
  const patch = pageViewHistoryPatches.get(historyRef as unknown as object);
  if (!patch?.pushStateInstalled || !patch.replaceStateInstalled) return null;
  if (historyRef.pushState !== patch.patchedPushState || historyRef.replaceState !== patch.patchedReplaceState) {
    return null;
  }
  const currentEntryId = readPageViewHistoryEntryId(historyRef.state);
  if (currentEntryId) return currentEntryId;
  if (typeof historyRef.replaceState !== 'function') return null;
  try {
    // The wrapper coins the id for the current entry. Two arguments, never a
    // third: omitting `url` leaves the address bar, including its fragment,
    // untouched.
    historyRef.replaceState(historyRef.state, '');
    // Confirm the host actually took it. Reporting an id the entry does not
    // carry would claim an identity that no later read could reproduce.
    return readPageViewHistoryEntryId(historyRef.state);
  } catch {
    return null;
  }
}

installPageViewHistoryEntryWrappers();
