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
import { buildPharmacyHubPage } from '../../build-plugins/pharmacyHubPlugin';
import { PHARMACY_HUB_PATH } from '../../services/pharmacies/types';

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

  it('robots is index,follow once the body clears MIN_INDEXABLE_WORDS', () => {
    const { html } = buildPharmacyHubPage('it');
    expect(html).toMatch(/<meta name=robots content="index, ?follow/);
  });
});
