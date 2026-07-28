/**
 * Regression test for the shared below-floor bridge target used by any SSG
 * loop without its own family-specific always-live hub — currently
 * borderWaitPagesPlugin.ts and healthPremiumsLandingPlugin.ts (issue #4553
 * sibling fix: check-sibling-patterns.mjs surfaced both as sharing the same
 * "silent continue on below-floor, no bridge" construct as fuelDailyPagesPlugin.ts's
 * fix). `/guida-frontaliere/` is a SECTION_EDITORIAL entry emitted
 * unconditionally by staticPagesPlugin.ts for every locale — a safe,
 * permanently-live, family-agnostic redirect target.
 */
import { describe, expect, it } from 'vitest';
import { renderGuideHubBridge } from '../build-plugins/shared/guideHubBridge';

const BASE_URL = 'https://frontaliereticino.ch';

const HUB_PATH = {
  it: '/guida-frontaliere/',
  en: '/en/cross-border-guide/',
  de: '/de/grenzgaenger-ratgeber/',
  fr: '/fr/guide-frontalier/',
};

describe('renderGuideHubBridge (#4553 sibling below-floor bridge)', () => {
  it('bridges an IT below-floor path to the guida-frontaliere hub', () => {
    const html = renderGuideHubBridge('/traffico-dogane/mendrisiotto/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.it}">`);
  });

  it('bridges an EN below-floor path to the EN cross-border-guide hub', () => {
    const html = renderGuideHubBridge('/en/border-wait/como/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.en}">`);
  });

  it('bridges a DE below-floor path to the DE hub', () => {
    const html = renderGuideHubBridge('/de/wartezeit-grenze/archiv/2026-03/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.de}">`);
  });

  it('bridges a health-premiums-style FR below-floor path to the FR hub', () => {
    const html = renderGuideHubBridge('/fr/primes-caisse-maladie/geneve/');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}${HUB_PATH.fr}">`);
  });

  it('marks the bridge noindex,follow', () => {
    const html = renderGuideHubBridge('/traffico-dogane/luganese/');
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('emits all 4 locale hreflang alternates + x-default at the hub', () => {
    const html = renderGuideHubBridge('/premi-cassa-malati/ticino/');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(html).toContain(
        `<link rel="alternate" hreflang="${locale}" href="${BASE_URL}${HUB_PATH[locale]}">`,
      );
    }
    expect(html).toContain(
      `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${HUB_PATH.it}">`,
    );
  });

  it('injects an instant client-side meta-refresh to the hub', () => {
    const html = renderGuideHubBridge('/premi-cassa-malati/vallese/');
    expect(html).toContain(
      `<meta http-equiv="refresh" content="0; url=${BASE_URL}${HUB_PATH.it}">`,
    );
  });
});
