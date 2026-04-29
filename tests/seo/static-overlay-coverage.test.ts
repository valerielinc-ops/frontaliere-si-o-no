/**
 * Regression — every URL emitted by an "SEO shell" build plugin (one that
 * uses buildSeoPageHtml with `seoContentOutsideRoot: true`) must be
 * recognised by parsePath() with `staticOverlay: true`.
 *
 * If a URL falls through the parser, the SPA hydrates inside #root, the
 * router rewrites the URL to `/`, and the user sees "Pagina non trovata"
 * even though the static HTML at the URL is perfectly fine.
 *
 * Reported instances of this bug class:
 *   2026-04-29 — /prezzi-benzina/stazioni-italia/ (fuel-station-index)
 *                FIX: build-plugins/fuelDailyData.ts → isFuelStationIndexPath
 *   2026-04-29 — /fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/
 *                FIX: services/router.ts → FR_SALAIRE_NET_PATHS branch
 *
 * This test enumerates the canonical URL of every SEO-shell plugin we know
 * of and asserts staticOverlay=true. New plugins of the same shape must be
 * added here at the same time as their router registration.
 */

import { describe, it, expect } from 'vitest';
import { parsePath } from '../../services/router';

const cases: ReadonlyArray<{ url: string; tab: string }> = [
  // Fuel-station / fuel-cities indexes (fuelStationIndexPages)
  { url: '/prezzi-benzina/stazioni-italia/', tab: 'stats' },
  { url: '/prezzi-benzina/stazioni-svizzere/', tab: 'stats' },
  { url: '/prezzi-benzina/citta-italiane/', tab: 'stats' },
  { url: '/prezzi-diesel/stazioni-svizzere/', tab: 'stats' },
  { url: '/en/gasoline-price-switzerland/swiss-stations/', tab: 'stats' },
  { url: '/de/dieselpreis-schweiz/schweizer-tankstellen/', tab: 'stats' },
  { url: '/fr/prix-essence-suisse/villes-italiennes/', tab: 'stats' },

  // FR salary calculator landing (frSalaireNetLandingPlugin)
  { url: '/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/', tab: 'calculator' },

  // Sanity sample — already-registered routes from sibling SEO shells
  { url: '/report/frontalieri-2026/', tab: 'stats' },
  { url: '/guida-frontaliere/mappa-live-valichi/', tab: 'guida' },
  { url: '/guida-frontaliere/guida-completa-calcolo-stipendio-frontaliere-2026/', tab: 'guida' },
];

describe('static-overlay coverage — SEO shell URLs must be recognised by parsePath', () => {
  for (const { url, tab } of cases) {
    it(`${url} → staticOverlay=true (tab=${tab})`, () => {
      const { route } = parsePath(url);
      expect(
        route.staticOverlay,
        `${url} must be staticOverlay=true (got activeTab=${route.activeTab}, staticOverlay=${route.staticOverlay ?? false}). ` +
          `If a static-HTML SEO page lacks staticOverlay, the SPA replaces its body with the default tab content on hydrate.`,
      ).toBe(true);
      expect(route.activeTab).toBe(tab);
    });
  }
});
