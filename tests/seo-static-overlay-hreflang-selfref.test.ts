/**
 * SEO regression — static-overlay landing pages keep their self-referential
 * hreflang after SPA hydration.
 *
 * SearchAtlas flagged `no_self_ref_hreflang` on 612 pages. Root cause: the
 * SPA runtime `updateHreflangTags(route)` rebuilt hreflang from
 * `buildAllLocalePaths(route)` → `buildPath(route, locale)`. For
 * `staticOverlay` landing routes (recency / today landings, fuel-daily,
 * border-wait, salary-stats, profession-canton, publisher ads, …) the
 * specific slug is NOT stored in AppRoute, so `buildPath` collapses to the
 * generic tab root (e.g. `/cerca-lavoro-ticino/` instead of
 * `/cerca-lavoro-ticino/ultimi-3-giorni/`). The rebuilt self-reference then
 * pointed away from the actual URL → SearchAtlas reported "no self-ref".
 *
 * The build plugins already emit a correct, self-referential, 4-locale +
 * x-default hreflang block for these pages (via the shared
 * `renderHreflangTags()` helper). The fix makes `updateHreflangTags` skip
 * staticOverlay routes so the server-rendered block survives. This test
 * locks that behaviour in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePath, buildAllLocalePaths, getSeoSection } from '@/services/router';
import { loadAllLocaleChunks, setLocale } from '@/services/i18n';

// Canonical prod domain (mirrors the private BASE_URL const in seoService.ts).
const BASE_URL = 'https://frontaliereticino.ch';

const { updateMetaTags } = await vi.importActual<typeof import('@/services/seoService')>(
  '@/services/seoService',
);

// A real recency landing URL: staticOverlay route whose slug is not carried
// in AppRoute (verified: buildAllLocalePaths collapses to the generic root).
const LANDING_PATH = '/cerca-lavoro-ticino/ultimi-3-giorni/';
const SELF_HREF = `${BASE_URL}${LANDING_PATH}`;

/** Seed the <head> with the correct server-rendered hreflang block. */
function seedStaticHreflang(): void {
  document.querySelectorAll('link[hreflang]').forEach((el) => el.remove());
  const entries: Array<[string, string]> = [
    ['it', `${BASE_URL}/cerca-lavoro-ticino/ultimi-3-giorni/`],
    ['en', `${BASE_URL}/en/find-jobs-ticino/last-3-days/`],
    ['de', `${BASE_URL}/de/jobs-im-tessin/letzte-3-tage/`],
    ['fr', `${BASE_URL}/fr/trouver-emploi-tessin/derniers-3-jours/`],
    ['x-default', `${BASE_URL}/cerca-lavoro-ticino/ultimi-3-giorni/`],
  ];
  for (const [lang, href] of entries) {
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.setAttribute('hreflang', lang);
    link.href = href;
    document.head.appendChild(link);
  }
}

describe('static-overlay hreflang self-reference is preserved after hydration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.querySelectorAll('link[hreflang]').forEach((el) => el.remove());
  });

  it('the landing URL is a staticOverlay route whose slug collapses in buildAllLocalePaths', () => {
    const { route } = parsePath(LANDING_PATH);
    expect(route.staticOverlay).toBe(true);
    // Regression anchor: without the fix, the self (it) hreflang would be
    // rebuilt to this collapsed root, NOT the landing URL.
    expect(buildAllLocalePaths(route).it).toBe('/cerca-lavoro-ticino/');
  });

  it('updateMetaTags does NOT overwrite the static self-referential hreflang', async () => {
    seedStaticHreflang();

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', LANDING_PATH);

    const { route } = parsePath(LANDING_PATH);
    await updateMetaTags(getSeoSection(route));

    const itHref = document
      .querySelector('link[hreflang="it"]')
      ?.getAttribute('href');
    // The self-reference must still point at the actual landing URL, not the
    // collapsed generic root.
    expect(itHref).toBe(SELF_HREF);

    const xDefault = document
      .querySelector('link[hreflang="x-default"]')
      ?.getAttribute('href');
    expect(xDefault).toBe(SELF_HREF);
  });
});
