import { describe, expect, it } from 'vitest';
// Guard for #1997: the FX / health / fuel comparator cross-links in canton SEO
// prose must come from the shared comparatorHref SSOT (canonical, curl-verified
// 200) and never regress to the dead orphan scheme (/en/comparators/…,
// /de/vergleiche/…, /fr/comparateurs/…, bare /…/gasoline-price-switzerland/)
// that no plugin emits → 404 on indexed pages. Renders the actual prose per
// locale so a re-introduced local table / orphan path fails HERE, pre-merge.
import { renderCantonSeoProse, type CantonSeoLocale } from '@/build-plugins/shared/cantonSeoProse';
import { FX_HREF, HEALTH_HREF, FUEL_HREF } from '@/build-plugins/shared/comparatorHref';

const LOCALES: CantonSeoLocale[] = ['it', 'en', 'de', 'fr'];

// Dead/orphan schemes that must never reappear in emitted prose.
const ORPHANS = [
  '/en/comparators/currency-exchange/',
  '/en/comparators/health-insurance/',
  '/de/vergleiche/wechselkurs/',
  '/de/vergleiche/krankenkassen/',
  '/fr/comparateurs/change-devises/',
  '/fr/comparateurs/caisses-maladie/',
  '/en/gasoline-price-switzerland/"', // bare (no /today/) → 404; quote-anchored
  '/comparatori/cambio-valuta/', // IT FX redirect-bridge (301 hop) — use direct canonical
];

describe('comparatorHref SSOT — canton SEO prose cross-links (#1997)', () => {
  it('SSOT exposes canonical it/en/de/fr for FX, health, fuel', () => {
    for (const loc of LOCALES) {
      expect(FX_HREF[loc]).toMatch(/^\//);
      expect(HEALTH_HREF[loc]).toMatch(/^\//);
      expect(FUEL_HREF[loc]).toMatch(/^\//);
    }
    // No orphan scheme baked into the SSOT itself.
    const all = [...Object.values(FX_HREF), ...Object.values(HEALTH_HREF), ...Object.values(FUEL_HREF)];
    expect(all.some((h) => h.includes('/comparators/') || h.includes('/vergleiche/') || h.includes('/comparateurs/'))).toBe(false);
  });

  it.each(LOCALES)('renders %s prose with canonical comparator hrefs, no orphans', (locale) => {
    const html = renderCantonSeoProse({ locale, cantonDisplay: 'Zurigo', slot: 'canton-hub' });
    expect(html).toContain(`href="${FX_HREF[locale]}"`);
    expect(html).toContain(`href="${HEALTH_HREF[locale]}"`);
    expect(html).toContain(`href="${FUEL_HREF[locale]}"`);
    for (const dead of ORPHANS) expect(html).not.toContain(dead);
    expect(html).not.toContain('undefined'); // import-cycle freeze guard
  });
});
