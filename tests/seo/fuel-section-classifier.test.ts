/**
 * Guard for the fuel-daily section matcher (scripts/lib/fuelSections.mjs) and
 * the audit feature classifier that consumes it (scripts/audit-title-length.mjs
 * → also imported by audit-h1-title-duplicates + audit-title-no-disambig-hash).
 *
 * Regression context (2026-06-24 post-deploy validate-dist failure):
 * the title-length classifier's fuel regex had drifted BEHIND its siblings and
 * still used the older BARE alternation (`gasoline-price`, `diesel-price`,
 * `dieselpreis`, `prix-gasoil`), so it failed to match the en/de/fr
 * COUNTRY-SUFFIXED fuel section slugs the corpus actually emits
 * (`gasoline-price-switzerland`, `diesel-price-switzerland`, `dieselpreis-schweiz`,
 * `prix-gasoil-suisse` — see build-plugins/fuelDailyData.ts FUEL_SECTION_SLUG).
 * Those daily-volatile fuel town pages (long Italian comune names) fell into the
 * volatile `spa-locale` bucket and drifted its ratchet over cap with no real SEO
 * change. They must classify as `fuel-daily` (data-volatile headroom bucket) for
 * EVERY locale × fuel type, and the matcher must stay in sync with
 * FUEL_SECTION_SLUG so the drift cannot recur.
 */
import { describe, it, expect } from 'vitest';
import { classifyFeature } from '../../scripts/audit-title-length.mjs';
import { isFuelSectionPath, FUEL_SECTION_RX } from '../../scripts/lib/fuelSections.mjs';

// classifyFeature takes a dist-relative path (with `dist/` prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('fuel-daily section matcher', () => {
  const fuelPaths = [
    // it (bare — always matched)
    '/prezzi-benzina/oggi/',
    '/prezzi-diesel/chiasso/oggi/',
    '/prezzi-benzina/italia/como/oggi/',
    // de — benzina already matched; DIESEL (dieselpreis-schweiz) was the leak
    '/de/benzinpreis-schweiz/heute/',
    '/de/dieselpreis-schweiz/italien/bardello-con-malgesso-e-bregano/heute/',
    '/de/dieselpreis-schweiz/italienische-tankstellen/',
    // fr — essence already matched; GASOIL (prix-gasoil-suisse) was the leak
    '/fr/prix-essence-suisse/aujourd-hui/',
    '/fr/prix-gasoil-suisse/italie/bardello-con-malgesso-e-bregano/aujourd-hui/',
    '/fr/prix-gasoil-suisse/italie/san-fermo-della-battaglia/aujourd-hui/',
    // en — BOTH gasoline and diesel country-suffixed sections were the leak
    '/en/gasoline-price-switzerland/italy/bardello-con-malgesso-e-bregano/today/',
    '/en/diesel-price-switzerland/italy/bardello-con-malgesso-e-bregano/today/',
  ];

  it.each(fuelPaths)('classifies %s as fuel-daily', (p) => {
    expect(isFuelSectionPath(p)).toBe(true);
    expect(classifyFeature(rel(p))).toBe('fuel-daily');
  });

  // Every CURRENT canonical section slug from FUEL_SECTION_SLUG must match — the
  // sync invariant that prevents the en/de/fr suffix drift from recurring.
  const canonicalSectionSlugs = [
    'prezzi-benzina', 'prezzi-diesel', // it
    'gasoline-price-switzerland', 'diesel-price-switzerland', // en
    'benzinpreis-schweiz', 'dieselpreis-schweiz', // de
    'prix-essence-suisse', 'prix-gasoil-suisse', // fr
  ];
  it.each(canonicalSectionSlugs)('matches canonical section slug %s', (slug) => {
    expect(isFuelSectionPath(`/${slug}/`)).toBe(true);
    expect(isFuelSectionPath(`/en/${slug}/x/today/`)).toBe(true);
  });

  const nonFuelPaths = [
    // The non-fuel pages that legitimately STAY in spa-locale (must NOT move)
    '/de/grenzgaenger-ratgeber/versteckte-kosten-chf-eur-wechselkurs-nettogehalt/',
    '/fr/reports/marche-emploi-frontaliers-tessin-2026/',
    '/fr/salaires-schaffhouse/',
    '/en/tax/',
    // Profession-canton landings must keep their own bucket, not fuel
    '/de/arbeit-aargau-koch/',
    '/en/jobs-zurich-cook/',
  ];
  it.each(nonFuelPaths)('does NOT classify %s as fuel-daily', (p) => {
    expect(isFuelSectionPath(p)).toBe(false);
    expect(classifyFeature(rel(p))).not.toBe('fuel-daily');
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    // A path whose segment merely contains "diesel-price" mid-word must not match.
    expect(FUEL_SECTION_RX.test('/blog/cheapest-diesel-price-tips/')).toBe(false);
  });

  it('validator form: "/" + dist-relative path matches the fuel section', () => {
    expect(isFuelSectionPath('/' + 'fr/prix-gasoil-suisse/italie/x/aujourd-hui/index.html')).toBe(true);
  });
});
