import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../build-plugins/frontalierePillarPlugin';
import { resetSeoHeroCardRegistry } from '../build-plugins/shared/seoHeroImage';

afterEach(() => {
  resetSeoHeroCardRegistry();
});

describe('frontaliere pillar static pages', () => {
  it('puts stats and the primary action before hero media on every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = renderPage(locale, '2026-09-27', '/tmp/frontaliere-pillar-test').html;
      const statsIndex = html.indexOf('sm:grid-cols-3');
      const ctaIndex = html.indexOf('class=s-cta');
      const heroIndex = html.indexOf(`data-seo-hero=frontaliere-pillar/pillar/${locale}`);

      expect(statsIndex, `${locale}: stats`).toBeGreaterThan(-1);
      expect(ctaIndex, `${locale}: CTA`).toBeGreaterThan(statsIndex);
      expect(heroIndex, `${locale}: hero`).toBeGreaterThan(ctaIndex);
    }
  });
});
