/**
 * Auto Ads policy regression — App.tsx must NOT carry blanket
 * `data-no-auto-ads="inside"` on root layout or <main>.
 *
 * Background (2026-04-26 → 2026-05-19):
 *  - Apr 26: blanket opt-out added to fix mobile p75 CLS 0.51.
 *  - May 19: AdSense console audit showed coverage stuck at 42-49% (was
 *    65.7%) and "0 in-page ads" in the site preview, with in-page Auto Ads
 *    identified as the single biggest unused revenue lever.
 *  - May 19: blanket opt-out removed. CLS is bounded by per-slot
 *    placeholderMinHeight (services/adsenseSlots.ts) and overlay frequency
 *    capping (AdSenseBanner.tsx:141).
 *
 * Per-page `disableAutoAds` flag in build-plugins/htmlTemplate.ts is still
 * supported for drive-by SEO landings — this test scopes ONLY to App.tsx.
 *
 * Per-component scoping (e.g. JobExpiredView, sensitive auth flows) is also
 * still allowed and intentional — this test only blocks the blanket pattern
 * on the root layout container and the top-level <main>.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const appTsx = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');

describe('App.tsx — in-page Auto Ads must not be blanket-disabled', () => {
  it('root <div> wrapper does NOT carry data-no-auto-ads', () => {
    // The root wrapper is the <div> directly inside the NavigationContext
    // Provider holding the staticOverlay / min-h-screen classes.
    const rootDivRegex =
      /<div[^>]*data-no-auto-ads[^>]*\$\{staticOverlay\s*\?\s*''\s*:\s*'min-h-screen'\}/;
    expect(appTsx).not.toMatch(rootDivRegex);
  });

  it('top-level <main id="main-content"> does NOT carry data-no-auto-ads', () => {
    const mainRegex = /<main\s+id=["']main-content["'][^>]*data-no-auto-ads/;
    expect(appTsx).not.toMatch(mainRegex);
  });

  it('the placeholderMinHeight CLS guardrail still exists in adsenseSlots', () => {
    // Removing the blanket opt-out is only safe because manual slots reserve
    // layout space. Catch an accidental removal of that guardrail.
    const adsenseSlots = readFileSync(
      resolve(__dirname, '..', 'services', 'adsenseSlots.ts'),
      'utf8',
    );
    expect(adsenseSlots).toMatch(/placeholderMinHeight\s*:\s*\d{3}/);
  });
});
