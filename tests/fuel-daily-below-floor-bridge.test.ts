/**
 * Regression test for issue #4553 item 3.
 *
 * Fuel-daily SSG loops (daily/archive/station/city/index, all in
 * build-plugins/fuelDailyPagesPlugin.ts) gate emission on a word-count
 * floor and previously did a bare `continue` on a miss — leaving a
 * previously-indexed URL 404 on GitHub Pages (no SPA fallback) whenever
 * the scraped station count dips below floor on a later build.
 * `renderFuelBelowFloorBridge` replaces that silent skip with a
 * noindex,follow bridge to the always-live regional stats hub
 * (FUEL_STATS_HUB_PATH — a static editorial page emitted unconditionally
 * by staticPagesPlugin.ts), same shape as shared/salaryStatsBridge.ts.
 */
import { describe, expect, it } from 'vitest';
import { renderFuelBelowFloorBridge } from '../build-plugins/fuelDailyPagesPlugin';

const BASE_URL = 'https://frontaliereticino.ch';

const HUB_PATH = {
  it: '/statistiche/prezzi-benzina-confine/',
  en: '/en/statistics/border-fuel-prices/',
  de: '/de/statistiken/spritpreise-grenze/',
  fr: '/fr/statistiques/prix-essence-frontiere/',
};

describe('renderFuelBelowFloorBridge (#4553 below-floor bridge)', () => {
  it('bridges an IT below-floor path to the IT stats hub', () => {
    const html = renderFuelBelowFloorBridge('/statistiche/prezzi-benzina-confine/oggi/benzina/chiasso/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.it}">`);
    expect(html).toContain(`href="${HUB_PATH.it}"`);
  });

  it('bridges an EN below-floor path to the EN stats hub (not IT)', () => {
    const html = renderFuelBelowFloorBridge('/en/statistics/border-fuel-prices/today/petrol/como/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.en}">`);
  });

  it('bridges a DE below-floor path to the DE stats hub', () => {
    const html = renderFuelBelowFloorBridge('/de/statistiken/spritpreise-grenze/heute/diesel/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.de}">`);
  });

  it('bridges a FR below-floor path to the FR stats hub', () => {
    const html = renderFuelBelowFloorBridge('/fr/statistiques/prix-essence-frontiere/aujourd-hui/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.fr}">`);
  });

  it('marks the bridge noindex,follow — never indexable itself', () => {
    const html = renderFuelBelowFloorBridge('/statistiche/prezzi-benzina-confine/oggi/benzina/');
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('emits all 4 locale hreflang alternates + x-default pointing at each hub', () => {
    const html = renderFuelBelowFloorBridge('/statistiche/prezzi-benzina-confine/oggi/benzina/');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(html).toContain(
        `<link rel="alternate" hreflang="${locale}" href="${BASE_URL}${HUB_PATH[locale]}">`,
      );
    }
    expect(html).toContain(
      `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${HUB_PATH.it}">`,
    );
  });

  it('injects an instant client-side meta-refresh to the canonical target', () => {
    const html = renderFuelBelowFloorBridge('/statistiche/prezzi-benzina-confine/oggi/benzina/');
    expect(html).toContain(
      `<meta http-equiv="refresh" content="0; url=${BASE_URL}${HUB_PATH.it}">`,
    );
  });

  it('never leaves the below-floor URL as a dead end (CTA links to the hub)', () => {
    const html = renderFuelBelowFloorBridge('/en/statistics/border-fuel-prices/today/diesel/lugano/');
    expect(html).toMatch(new RegExp(`<a href="${HUB_PATH.en.replace(/\//g, '\\/')}"[^>]*>`));
  });
});
