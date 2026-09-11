/**
 * pageViewHistoryEntry — the one place that decides a page view's identity.
 *
 * A page view is one act of navigation. Its identity is the history entry it
 * happens on, and it is bound **synchronously, at the instant the navigation
 * is observed**, by whoever observes it. The value then travels forward as an
 * argument. Nothing downstream re-derives it from ambient `window.history.state`.
 *
 * That rule is the whole design, and it makes both failure directions
 * impossible by construction rather than by discipline:
 *
 *   - two emissions of the SAME act (Firebase + PostHog, or a retry after the
 *     employer identity resolves) read the same entry → they share the id →
 *     downstream deduplication collapses them to ONE observed unit;
 *   - two REAL distinct navigations are captured while each one's own entry is
 *     current → different ids → TWO observed units.
 *
 * The defect this replaces was a late read: the lazy analytics proxy runs
 * `trackPageView` inside the `.then()` of a dynamic import, so an emitter that
 * sampled `window.history.state` there read whichever entry was current by
 * then. Two rapid navigations both sampled the last one and counted as one.
 * Collapsing real traffic and inflating it are both defects; the fix is to
 * stop sampling ambient state late, not to add another correction on top.
 *
 * When the entry cannot be determined the answer is `null` — "dedup non
 * disponibile" — never a guessed id. A fabricated identity would silently
 * become an observed count that nothing measured.
 *
 * This module is deliberately a LEAF: no imports, no Firebase, no side effects
 * at load. The lazy proxy imports it statically so the binding can happen
 * before the dynamic import, without dragging the analytics bundle into the
 * critical path — which is the reason the proxy exists.
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
  if (state == null) return { [PAGE_VIEW_HISTORY_STATE_KEY]: currentEntryId || entryId };
  if (!isHistoryStateRecord(state)) return null;
  return {
    ...state,
    [PAGE_VIEW_HISTORY_STATE_KEY]: readPageViewHistoryEntryId(state) || currentEntryId || entryId,
  };
}

/**
 * Read — or, the first time, allocate — the identity of the history entry that
 * is current RIGHT NOW. Synchronous by contract: the value is only meaningful
 * at the instant the navigation is observed.
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
  const currentEntryId = readPageViewHistoryEntryId(historyRef.state);
  if (currentEntryId) return currentEntryId;
  if (typeof historyRef.replaceState !== 'function') return null;
  const entryId = createAnalyticsEmissionId();
  const nextState = stateForReplacedPageViewHistoryEntry(historyRef.state, null, entryId);
  if (!nextState) return null;
  try {
    // Two arguments, never a third: `replaceState(state, '', '')` resolves the
    // empty URL against the document base and DROPS the fragment, so allocating
    // an analytics id would rewrite the address bar. Omitting `url` leaves the
    // URL untouched, which is the only thing this call is allowed to do.
    historyRef.replaceState(nextState, '');
    // Confirm the host actually took it. Reporting an id the entry does not
    // carry would claim an identity that no later read could reproduce.
    return readPageViewHistoryEntryId(historyRef.state) === entryId ? entryId : null;
  } catch {
    return null;
  }
}
