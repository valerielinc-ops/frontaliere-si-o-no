/**
 * Regression guard for issue #5428 — the locale-root SPA shells must link the
 * two hubs their whole subtree hangs off.
 *
 * What broke, and why a unit test is the right net for it
 * ------------------------------------------------------
 * `/en/`, `/de/`, `/fr/` used to be written by staticPagesPlugin's generic
 * hreflang-variant loop, i.e. by `buildPage()`, which appends the locale's
 * 16-anchor pipe nav (`NAV_LABELS[locale]`) to every artifact it emits. Issue
 * #5468 handed those three paths to the post-loop "Locale-root SPA shells"
 * ratchet instead (the loop now `continue`s on them) so they would stop losing
 * the homepage SEO block to `_qw`'s first-write-wins dedup. The ratchet mirrors
 * the ITALIAN root, so the three locale homes came out with the Italian
 * prerender's nav and none of their own — and nothing in CI noticed, because
 * every gate that could have is a whole-`dist/` crawl that only runs
 * post-deploy.
 *
 * The two anchors this file pins are the ones whose loss actually cost depth:
 *
 *   1. the locale HTML sitemap page (`/en/site-map/`, `/de/seitenplan/`,
 *      `/fr/plan-du-site/`) — see build-plugins/shared/siteMapPageDir.ts: it is
 *      the injection target EVERY `*LinksPlugin.ts` uses to pull an orphaned
 *      landing family inside the crawl budget, and its docstring's "depth ≤ 2
 *      en-de-fr" holds ONLY while the locale root links it. When it slipped to
 *      depth 3, `/{loc}/gehalt-…-{canton}/` spokes went to 4 and the
 *      `/{loc}/gehaelter-{canton}/` salary hubs they link went to 5:
 *      `sitemap-salary-stats.xml` failed the ratchet at 75 URLs past the
 *      depth-4 cap against a baseline of 12 (run 31342536200).
 *
 *   2. the locale FAQ hub, carried by the related-guides rail. DE was the only
 *      locale whose pill pointed at a slug that does not exist
 *      (`/de/haeufig-gestellte-fragen/`, a 404 — the hub is
 *      `/de/haeufige-fragen/`), so DE alone stayed buried when the rail became
 *      its only shallow path: all 103 `/de/haeufige-fragen/<entry>/` pages at
 *      depth 5, and `/de/grenzgaenger/` (linked from that hub) with them.
 *      Deriving the href from `buildFaqHubPath` is what makes the drift
 *      impossible; this test is what makes the drift loud.
 *
 * Driving the two injectors in the ratchet's own order (SEO block first, main
 * nav second) keeps the test honest about the artifact the build really ships,
 * without needing a `dist/` — which is CI-assembled and never exists locally.
 */

import { describe, it, expect } from 'vitest';

import {
  injectLocaleMainNav,
  renderLocaleRootShell,
} from '../../build-plugins/staticPagesPlugin';
import { SITE_MAP_PAGE_DIR } from '../../build-plugins/shared/siteMapPageDir';
import { buildFaqHubPath } from '../../data/faq-hub/routes';

/** Minimal stand-in for the mirrored IT root the ratchet starts from. */
const SHELL = '<html lang="it"><body><div id="root"><main id="main-content"></main></div></body></html>';

/**
 * `renderLocaleRootShell` IS the ratchet's per-locale transform — the same
 * function `closeBundle` calls on both of its branches — so dropping the nav
 * injection from the pipeline turns these assertions red, which a hand-rolled
 * re-composition of the same steps would not have done.
 */
function renderLocaleRoot(locale: 'en' | 'de' | 'fr'): string {
  return renderLocaleRootShell(SHELL, locale);
}

const NON_IT_LOCALES = ['en', 'de', 'fr'] as const;

describe('locale-root SPA shells — internal links (#5428)', () => {
  it.each(NON_IT_LOCALES)(
    '/%s/ links its HTML sitemap page, the depth-≤2 hub every *LinksPlugin injects into',
    (locale) => {
      const html = renderLocaleRoot(locale);
      // SITE_MAP_PAGE_DIR holds the dist-relative dir ('de/seitenplan'); the
      // anchor is the absolute, trailing-slash path.
      const href = `/${SITE_MAP_PAGE_DIR[locale]}/`;
      expect(html).toContain(`href="${href}"`);
    },
  );

  it.each(NON_IT_LOCALES)(
    '/%s/ links its own FAQ hub at the path the hub is actually emitted on',
    (locale) => {
      const html = renderLocaleRoot(locale);
      expect(html).toContain(`href="${buildFaqHubPath(locale)}"`);
    },
  );

  // The DE slug is called out on its own because it is the one that had
  // drifted: a generic "some FAQ anchor is present" assertion would have
  // passed on `/de/haeufig-gestellte-fragen/` too, which is a 404.
  it('spells the DE FAQ hub /de/haeufige-fragen/, not the 404 /de/haeufig-gestellte-fragen/', () => {
    const html = renderLocaleRoot('de');
    expect(html).toContain('href="/de/haeufige-fragen/"');
    expect(html).not.toContain('/de/haeufig-gestellte-fragen/');
  });

  it.each(NON_IT_LOCALES)(
    'keeps /%s/ nav anchors inside its own locale subtree (no IT nav inherited from the mirror)',
    (locale) => {
      const html = renderLocaleRoot(locale);
      // The Italian sitemap page is the canary: the ratchet mirrors the IT
      // root, so an IT-flavoured nav leaking through is exactly the failure
      // mode #5428 was — a locale home whose only sitemap-page anchor points
      // at the wrong locale's tree.
      expect(html).not.toContain(`href="/${SITE_MAP_PAGE_DIR.it}/"`);
    },
  );

  it('injects the main nav exactly once, since the ratchet may re-read and re-inject', () => {
    const once = renderLocaleRoot('de');
    const twice = injectLocaleMainNav(once, 'de');
    expect(twice).toBe(once);
    expect(twice.match(/id="hp-locale-main-nav"/g)).toHaveLength(1);
    expect(twice.match(/href="\/de\/seitenplan\/"/g)).toHaveLength(1);
  });

  it('is a no-op on markup with no </body> to anchor to, like injectHomepageSeoContent', () => {
    const fragment = '<div id="root"></div>';
    expect(injectLocaleMainNav(fragment, 'de')).toBe(fragment);
  });
});
