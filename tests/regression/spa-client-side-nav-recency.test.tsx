/**
 * Regression: SPA client-side navigation to recency/oggi landings
 *
 * Verifies that clicking an <a href="/cerca-lavoro-ticino/da-ieri/"> does NOT
 * route through the SPA as a job detail (jobSlug: 'da-ieri'), but instead
 * lets the browser perform a full-page navigation to the static HTML landing.
 *
 * Background (2b): before the parsePath fix (f5cca508) and the BUG-1 click
 * interceptor fix (cfec2111), clicking a recency/oggi footer link while on a
 * job detail page caused the SPA to:
 *   1. Intercept the click via e.preventDefault()
 *   2. Set jobSlug = 'da-ieri' (treating the recency slug as a job ID)
 *   3. Show "Questo annuncio non è più disponibile" (404 banner)
 *   4. Keep stale og:url / og:title from the previous page
 *
 * The fix has two layers:
 *   - parsePath() returns { activeTab: 'job-board', staticOverlay: true } for
 *     every recency slug (tested separately in recency-router-guards.test.ts)
 *   - The global click interceptor in useNavigationState.ts detects
 *     staticOverlay: true and returns early WITHOUT calling e.preventDefault(),
 *     so the browser navigates natively to the static HTML page.
 *
 * This file tests the click interceptor layer by mounting the hook and
 * simulating a document click event on an anchor pointing to /da-ieri/.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Shared mock setup ──────────────────────────────────────────────────────
// parsePath is used by the click interceptor. We want the REAL implementation
// for recency paths but need the hook's other dependencies mocked.

vi.mock('@/services/router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/router')>();
  return {
    ...real,
    // Keep real parsePath so the recency guard is exercised
    pushRoute: vi.fn(),
    replaceRoute: vi.fn(),
    updatePathForLocale: vi.fn(),
    scrollToAnchor: vi.fn(() => false),
    preloadBlogData: vi.fn(() => Promise.resolve()),
    resolveBlogSlug: vi.fn(() => null),
    getLocalizedJobSlug: vi.fn((slug: string) => slug),
  };
});

vi.mock('@/services/i18n', () => ({
  setLocale: vi.fn(),
  onLocaleChange: vi.fn(() => vi.fn()),
}));

vi.mock('@/services/prefetch', () => ({
  prefetchTab: vi.fn(),
}));

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
}));

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackTabNavigation: vi.fn(),
    trackFunnelStep: vi.fn(),
  },
  unlockAchievement: vi.fn(),
}));

import { useNavigationState } from '@/hooks/useNavigationState';

// ── Test helpers ───────────────────────────────────────────────────────────

/** Simulate the user being on a job detail page (SPA route, not static overlay). */
function setupJobDetailPage(slug: string) {
  window.history.replaceState({}, '', `/cerca-lavoro-ticino/${slug}/`);
}

/** Fire a click event on a synthetic anchor element at a given href. */
function clickAnchor(href: string): { defaultPrevented: boolean } {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = 'test link';
  document.body.appendChild(a);

  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  a.dispatchEvent(event);

  document.body.removeChild(a);
  return { defaultPrevented: event.defaultPrevented };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('2b — client-side nav: recency landing guard in click interceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore URL after each test
    window.history.replaceState({}, '', '/');
  });

  it('does NOT call e.preventDefault() when clicking /cerca-lavoro-ticino/da-ieri/', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    // Simulate clicking the "Nuove offerte da ieri" footer link
    const { defaultPrevented } = clickAnchor('/cerca-lavoro-ticino/da-ieri/');

    // The click interceptor MUST fall through (no preventDefault) so the
    // browser performs a full navigation to the static HTML page.
    expect(defaultPrevented).toBe(false);
  });

  it('does NOT call e.preventDefault() for ultimi-3-giorni recency slug', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    const { defaultPrevented } = clickAnchor('/cerca-lavoro-ticino/ultimi-3-giorni/');
    expect(defaultPrevented).toBe(false);
  });

  it('does NOT call e.preventDefault() for EN since-yesterday recency slug', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    const { defaultPrevented } = clickAnchor('/en/find-jobs-ticino/since-yesterday/');
    expect(defaultPrevented).toBe(false);
  });

  it('does NOT call e.preventDefault() for DE seit-gestern recency slug', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    const { defaultPrevented } = clickAnchor('/de/jobs-im-tessin/seit-gestern/');
    expect(defaultPrevented).toBe(false);
  });

  it('does NOT call e.preventDefault() for FR depuis-hier recency slug', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    const { defaultPrevented } = clickAnchor('/fr/trouver-emploi-tessin/depuis-hier/');
    expect(defaultPrevented).toBe(false);
  });

  it('DOES call e.preventDefault() for a regular job detail link (control case)', () => {
    setupJobDetailPage('azienda-board-international');
    renderHook(() => useNavigationState());

    // A real job slug should be intercepted by the SPA
    const { defaultPrevented } = clickAnchor('/cerca-lavoro-ticino/software-engineer-lugano/');
    expect(defaultPrevented).toBe(true);
  });

  it('resulting route from parsePath is { activeTab: job-board, staticOverlay: true } — NOT jobSlug', async () => {
    // This test exercises parsePath directly to confirm no jobSlug is produced
    // for the da-ieri recency slug. Mirrors recency-router-guards.test.ts but
    // stated explicitly as a 2b regression guard.
    const { parsePath } = await import('@/services/router');
    const { route } = parsePath('/cerca-lavoro-ticino/da-ieri/');

    expect(route.activeTab).toBe('job-board');
    expect(route.staticOverlay).toBe(true);
    expect((route as unknown as Record<string, unknown>).jobSlug).toBeUndefined();
  });
});
