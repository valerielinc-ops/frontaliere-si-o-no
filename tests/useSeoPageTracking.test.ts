import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSeoPageTracking } from '@/hooks/useSeoPageTracking';
import { captureEvent as posthogCapture } from '@/services/posthog';

const posthogMock = vi.mocked(posthogCapture);

/**
 * Helper to swap the browser pathname without actually navigating — jsdom's
 * `history.pushState` accepts it, but only if we also update `location`
 * via `window.history.pushState`, which is what the app does.
 */
function navigateTo(path: string): void {
  window.history.pushState({}, '', path);
}

describe('useSeoPageTracking', () => {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    posthogMock.mockClear();
    delete (window as unknown as { gtag?: unknown }).gtag;
    // Reset pathname between tests.
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    // Guard against a test leaving history.* patched if unmount failed.
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('fires once on initial mount with the current pathname', () => {
    window.history.replaceState({}, '', '/prezzi-diesel/oggi/');
    renderHook(() => useSeoPageTracking());

    expect(posthogMock).toHaveBeenCalledTimes(1);
    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'fuel_daily',
      pathname: '/prezzi-diesel/oggi/',
      locale: 'it',
    });
  });

  it('does not emit for untagged landing paths on mount', () => {
    window.history.replaceState({}, '', '/');
    renderHook(() => useSeoPageTracking());
    expect(posthogMock).not.toHaveBeenCalled();
  });

  it('fires on SPA pushState navigation', () => {
    window.history.replaceState({}, '', '/');
    renderHook(() => useSeoPageTracking());
    posthogMock.mockClear();

    act(() => {
      navigateTo('/premi-cassa-malati/ticino/');
    });

    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'health_premiums',
      pathname: '/premi-cassa-malati/ticino/',
      locale: 'it',
    });
  });

  it('fires on replaceState navigation', () => {
    window.history.replaceState({}, '', '/');
    renderHook(() => useSeoPageTracking());
    posthogMock.mockClear();

    act(() => {
      window.history.replaceState({}, '', '/en/ticino-job-market/week-16-2026/');
    });

    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'job_market_snapshot',
      pathname: '/en/ticino-job-market/week-16-2026/',
      locale: 'en',
    });
  });

  it('fires on popstate (back/forward)', () => {
    window.history.replaceState({}, '', '/');
    renderHook(() => useSeoPageTracking());
    posthogMock.mockClear();

    // Simulate back-navigation to a classifiable SEO page.
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/lugano/');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'city_hub',
      pathname: '/cerca-lavoro-ticino/lugano/',
      locale: 'it',
    });
  });

  it('mirrors seo_page_view to gtag when present', () => {
    const gtagSpy = vi.fn();
    (window as unknown as { gtag: typeof gtagSpy }).gtag = gtagSpy;
    window.history.replaceState({}, '', '/aziende-che-assumono/lugano/settimana-16-2026/');

    renderHook(() => useSeoPageTracking());

    expect(gtagSpy).toHaveBeenCalledWith('event', 'seo_page_view', {
      seo_page_type: 'weekly_employers',
      page_path: '/aziende-che-assumono/lugano/settimana-16-2026/',
      locale: 'it',
    });
  });

  it('restores history.pushState / replaceState on unmount', () => {
    const { unmount } = renderHook(() => useSeoPageTracking());

    // While mounted, pushState should be patched.
    expect(window.history.pushState).not.toBe(originalPushState);

    unmount();

    // After unmount, originals are restored.
    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
  });

  it('does not throw when the pre-existing pushState/replaceState is not a function at mount time (issue #4304)', () => {
    // Simulates the live PostHog cluster: "Cannot read properties of
    // undefined (reading 'apply')". A stale/tampered `history.pushState`
    // (e.g. from an interleaved mount/unmount with useUIState's own history
    // patch, or third-party tampering) means the closed-over
    // original*State captured at hook-mount time can be non-function — the
    // wrapper must degrade to a no-op instead of throwing. (With no native
    // implementation to delegate to, the URL itself cannot change — this
    // only asserts the wrapper survives the call instead of crashing the
    // whole app to the top-level ErrorBoundary.)
    window.history.replaceState({}, '', '/');
    // Force the pre-existing implementations to a non-function value before
    // the hook captures them.
    (window.history as unknown as { pushState: unknown }).pushState = undefined;
    (window.history as unknown as { replaceState: unknown }).replaceState = undefined;

    const { unmount } = renderHook(() => useSeoPageTracking());
    posthogMock.mockClear();

    try {
      expect(() => {
        act(() => {
          window.history.pushState({}, '', '/premi-cassa-malati/ticino/');
        });
      }).not.toThrow();

      expect(() => {
        act(() => {
          window.history.replaceState({}, '', '/permessi-di-lavoro/');
        });
      }).not.toThrow();
    } finally {
      // The hook's own cleanup restores to whatever it captured (undefined,
      // in this test) — explicitly re-restore the true originals afterward
      // so later tests in this file don't inherit a poisoned history object.
      unmount();
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    }
  });

  it('does not emit when navigating to an untagged path', () => {
    window.history.replaceState({}, '', '/');
    renderHook(() => useSeoPageTracking());
    posthogMock.mockClear();

    act(() => {
      navigateTo('/privacy/');
    });

    expect(posthogMock).not.toHaveBeenCalled();
  });
});
