/**
 * useSeoPageTracking — SPA-aware page-type tracker.
 *
 * Listens for every SPA navigation (pushState + popstate) and fires
 * `trackSeoPageView(location.pathname)`, which classifies the URL into one
 * of the tagged SEO feature page types and emits `seo_page_view` to both
 * PostHog and GA4. Also fires once on initial mount to capture the landing
 * page.
 *
 * Silent activation — no consent gate.
 * SSR safe — no-op when `window` is undefined.
 *
 * The hook intentionally patches `history.pushState` / `history.replaceState`
 * instead of relying on the existing router, so it keeps working even if
 * navigation flows change. It restores the original implementations on
 * unmount so repeated mounts (e.g. React 18 StrictMode double-invocation)
 * don't stack wrappers.
 */

import { useEffect } from 'react';

import { trackSeoPageView } from '@/services/analytics-seo';
import { callNativeHistory } from '@/services/nativeHistoryCall';

export function useSeoPageTracking(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const fire = (): void => {
      try {
        trackSeoPageView(window.location.pathname);
      } catch {
        // Never let analytics crash the app.
      }
    };

    // Fire once on mount to capture the initial landing page.
    fire();

    // Patch pushState / replaceState to emit a synthetic event we can
    // listen to. (The browser emits `popstate` for back/forward but NOT
    // for programmatic pushState — the router pattern in this codebase
    // relies on manual pushState calls.)
    //
    // Keep references to the original (un-bound) functions so that on
    // unmount we restore the exact same values that were present before
    // the hook ran.
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    const PUSH_EVENT = 'seo-tracking:pushstate';
    const REPLACE_EVENT = 'seo-tracking:replacestate';

    // Defensive guard (issue #4304, hardened #5606): a live PostHog cluster
    // showed "Cannot read properties of undefined (reading 'apply')" from
    // this monkeypatch. history.pushState/replaceState is also
    // independently patched by useUIState on the same App tree — under
    // React StrictMode double-invocation or an interleaved mount/unmount
    // ordering, the captured original*State reference can go stale.
    // callNativeHistory falls back to History.prototype[method] and never
    // throws even if that is unavailable too (#5606: the fallback itself
    // was not crash-proof) — preserving the return-shape contract without
    // crashing the whole app to the top-level ErrorBoundary over a
    // tracking call.
    window.history.pushState = function patchedPushState(
      ...args: Parameters<History['pushState']>
    ) {
      const result = callNativeHistory('pushState', originalPushState, window.history, args);
      try {
        window.dispatchEvent(new Event(PUSH_EVENT));
      } catch {
        // Older browsers without Event constructor — ignore.
      }
      return result;
    };

    window.history.replaceState = function patchedReplaceState(
      ...args: Parameters<History['replaceState']>
    ) {
      const result = callNativeHistory('replaceState', originalReplaceState, window.history, args);
      try {
        window.dispatchEvent(new Event(REPLACE_EVENT));
      } catch {
        // Older browsers without Event constructor — ignore.
      }
      return result;
    };

    window.addEventListener('popstate', fire);
    window.addEventListener(PUSH_EVENT, fire);
    window.addEventListener(REPLACE_EVENT, fire);

    return () => {
      window.removeEventListener('popstate', fire);
      window.removeEventListener(PUSH_EVENT, fire);
      window.removeEventListener(REPLACE_EVENT, fire);
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    };
  }, []);
}
