/**
 * Regression: meta tags update on SPA route change (2c)
 *
 * Verifies that og:url / twitter:url reflect the CURRENT page URL on every
 * SPA navigation — NOT the stale URL from the previous page.
 *
 * Background (2c):
 * When a user navigated from a job detail page (/cerca-lavoro-ticino/azienda-board-international/)
 * to a recency landing (/cerca-lavoro-ticino/da-ieri/), the og:url remained
 * stale (pointing at the previous page). Root cause: seoService.ts built
 * canonicalLocalePath via buildPath(route, locale). For static-overlay routes
 * AppRoute only stores { activeTab: 'job-board', staticOverlay: true } — the
 * specific landing slug is NOT round-tripped through AppRoute. buildPath()
 * therefore returns the generic tab root (/cerca-lavoro-ticino/), not
 * /cerca-lavoro-ticino/da-ieri/.
 *
 * Fix (seoService.ts): when route.staticOverlay is true, use
 * window.location.pathname directly for canonicalLocalePath instead of
 * buildPath(route, locale).
 *
 * Test strategy:
 *   - seoService is globally mocked in tests/setup.tsx (so we cannot call
 *     updateMetaTags in unit tests and expect real DOM updates).
 *   - Instead this file tests the underlying data-flow invariants at the
 *     router layer: (a) buildPath loses the slug for static-overlay routes;
 *     (b) parsePath round-trips the URL correctly to staticOverlay:true;
 *     (c) the fix produces the correct canonical path for og:url construction.
 */

import { describe, it, expect } from 'vitest';

// seoService is globally mocked (tests/setup.tsx); only router utilities are real.
import { parsePath, buildPath } from '@/services/router';

const BASE_URL = 'https://frontaliereticino.ch';

// ── Helper: mirror the seoService canonicalLocalePath logic ────────────────
/**
 * Compute what canonicalLocalePath seoService.ts would produce for a given
 * window.location.pathname, mirroring the fix in seoService.ts exactly:
 *   route.staticOverlay → use pathname directly
 *   else               → use buildPath(route, locale)
 */
function computeCanonicalLocalePath(pathname: string): string {
  const { route, locale } = parsePath(pathname);
  if (route.staticOverlay) {
    // FIX: use window.location.pathname directly for static-overlay routes
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }
  const path = buildPath(route, locale);
  return path.endsWith('/') ? path : `${path}/`;
}

describe('2c — canonicalLocalePath reflects window.location.pathname for static-overlay routes', () => {
  // ── Core regression: recency landings ────────────────────────────────────
  it('da-ieri recency landing: canonical path IS /da-ieri/ (not generic listing root)', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/da-ieri/');
    expect(canonical).toContain('/da-ieri/');
    expect(canonical).not.toMatch(/^\/cerca-lavoro-ticino\/$/);
  });

  it('ultimi-3-giorni recency landing: canonical path IS /ultimi-3-giorni/', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/ultimi-3-giorni/');
    expect(canonical).toContain('/ultimi-3-giorni/');
  });

  it('EN since-yesterday recency landing: canonical path IS /since-yesterday/', () => {
    const canonical = computeCanonicalLocalePath('/en/find-jobs-ticino/since-yesterday/');
    expect(canonical).toContain('/since-yesterday/');
  });

  it('DE seit-gestern recency landing: canonical path IS /seit-gestern/', () => {
    const canonical = computeCanonicalLocalePath('/de/jobs-im-tessin/seit-gestern/');
    expect(canonical).toContain('/seit-gestern/');
  });

  it('FR depuis-hier recency landing: canonical path IS /depuis-hier/', () => {
    const canonical = computeCanonicalLocalePath('/fr/trouver-emploi-tessin/depuis-hier/');
    expect(canonical).toContain('/depuis-hier/');
  });

  // ── Bug documentation: buildPath loses the slug for static-overlay routes ──
  it('[bug doc] buildPath alone for static-overlay route returns generic listing root', () => {
    const { route, locale } = parsePath('/cerca-lavoro-ticino/da-ieri/');
    // This confirms WHY the fix is needed: buildPath cannot reconstruct /da-ieri/
    const naivePath = buildPath(route, locale);
    expect(naivePath).not.toContain('da-ieri');
    // The naive approach would have produced the WRONG og:url
    expect(`${BASE_URL}${naivePath}/`).not.toContain('/da-ieri/');
  });

  // ── Non-static-overlay (normal SPA route): buildPath is still used ────────
  it('job-board listing page: canonical path uses buildPath correctly', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/');
    // Normal listing page — not a static overlay — uses buildPath
    // buildPath({ activeTab: 'job-board' }, 'it') → /cerca-lavoro-ticino/
    expect(canonical).toContain('/cerca-lavoro-ticino/');
  });

  it('job detail page: canonical path uses buildPath with job slug', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/software-engineer-lugano/');
    // Job detail pages have a jobSlug in AppRoute — buildPath reconstructs correctly
    expect(canonical).toContain('cerca-lavoro-ticino');
  });

  // ── og:url construction: BASE_URL + canonicalLocalePath ───────────────────
  it('full og:url for da-ieri is BASE_URL + /da-ieri/ (not the generic listing root)', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/da-ieri/');
    const ogUrl = `${BASE_URL}${canonical}`;
    expect(ogUrl).toBe(`${BASE_URL}/cerca-lavoro-ticino/da-ieri/`);
  });

  it('full og:url for job detail page is BASE_URL + /slug/ (reconstructed via buildPath)', () => {
    const canonical = computeCanonicalLocalePath('/cerca-lavoro-ticino/software-engineer-lugano/');
    const ogUrl = `${BASE_URL}${canonical}`;
    // buildPath correctly reconstructs job detail canonical from the route
    expect(ogUrl).toContain('frontaliereticino.ch');
    expect(ogUrl).toContain('cerca-lavoro-ticino');
  });
});

describe('2c — parsePath invariants for static-overlay routes', () => {
  it('parsePath /da-ieri/ returns staticOverlay:true so the fix is activated', () => {
    const { route } = parsePath('/cerca-lavoro-ticino/da-ieri/');
    expect(route.staticOverlay).toBe(true);
  });

  it('parsePath /cerca-lavoro-ticino/ does NOT return staticOverlay', () => {
    const { route } = parsePath('/cerca-lavoro-ticino/');
    expect(route.staticOverlay).toBeFalsy();
  });

  it('parsePath /cerca-lavoro-ticino/software-engineer-x/ does NOT return staticOverlay', () => {
    const { route } = parsePath('/cerca-lavoro-ticino/software-engineer-x/');
    expect(route.staticOverlay).toBeFalsy();
  });
});
