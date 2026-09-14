/**
 * #6399 — `/farmacie/` national pharmacy coverage hub.
 *
 * `buildPharmacyHubPage` renders `data/pharmacy-sources-registry.json` (SOURCE
 * configuration only — no `Pharmacy`/`PharmacyDuty` connector exists yet), so
 * these tests guard the two invariants the parent issue (#6173) actually
 * cares about: the page is indexable (>=50 words, Non-Negotiable #4) for
 * every locale, and it never fabricates duty-schedule content.
 */
import { describe, it, expect } from 'vitest';
import { buildPharmacyHubPage, getPharmacyHubCantonCards } from '../../build-plugins/pharmacyHubPlugin';
import { PHARMACY_HUB_PATH } from '../../services/pharmacies/types';
import { SWISS_CANTONS } from '../../services/pharmacies/swissCantons';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('pharmacyHubPlugin — buildPharmacyHubPage', () => {
  it.each(LOCALES)('emits >=50 words of body content for locale %s (indexable, Non-Negotiable #4)', (locale) => {
    const { wordCount } = buildPharmacyHubPage(locale);
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it.each(LOCALES)('canonical/hreflang match PHARMACY_HUB_PATH for locale %s', (locale) => {
    const { html } = buildPharmacyHubPage(locale);
    expect(html).toContain(`https://frontaliereticino.ch${PHARMACY_HUB_PATH[locale]}`);
  });

  it('never renders a duty schedule or an invented pharmacy name — only registry source status', () => {
    const { html } = buildPharmacyHubPage('it');
    // The registry entry for Ticino is real; assert the page surfaces its
    // status/source link, not a fabricated on-duty listing.
    expect(html).toContain('Ticino');
    expect(html).not.toMatch(/farmacia\s+[A-Z][a-zà-ü]+\s+è\s+di\s+turno/i);
  });

  it('represents all 26 Swiss cantons without fabricating missing source links', () => {
    expect(SWISS_CANTONS).toHaveLength(26);
    const cards = getPharmacyHubCantonCards();
    expect(cards).toHaveLength(26);
    expect(cards.find((card) => card.canton.code === 'TI')?.source?.officialSourceUrl)
      .toBe('https://www.ofct.ch/farmacieturno/');
    expect(cards.find((card) => card.canton.code === 'AG')?.source).toBeUndefined();

    const { html } = buildPharmacyHubPage('it');
    for (const canton of SWISS_CANTONS) expect(html).toContain(canton.names.it);
    expect(html).toContain('Corridoio italiano di confine');
    expect(html).toContain('/farmacie/italia/');
    expect(html).toContain('https://www.dati.salute.gov.it/it/dataset/farmacie/');
    expect(html).not.toContain('href="https://www.ar.ch/');
  });

  it('robots is index,follow once the body clears MIN_INDEXABLE_WORDS', () => {
    const { html } = buildPharmacyHubPage('it');
    expect(html).toMatch(/<meta name=robots content="index, ?follow/);
  });
});
