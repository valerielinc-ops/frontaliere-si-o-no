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
import { join } from 'node:path';
import { classifyFeature } from '../../scripts/audit-title-length.mjs';
import { isFuelSectionPath, FUEL_SECTION_RX } from '../../scripts/lib/fuelSections.mjs';
import { DIST, sdClassifyPage, sdValidateFuelMerchantProduct } from '../../scripts/audit-dist-multi.mjs';

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

/**
 * Guard for issue #3303 (follow-up of #3299): `scripts/audit-dist-multi.mjs`'s
 * `sdClassifyPage()` and `sdValidateFuelMerchantProduct()` — a "verbatim"
 * copy of validate-structured-data-completeness.mjs's fuel classifier —
 * previously used the OLD pre-#3299 7-slug inline alternation instead of the
 * shared FUEL_SECTION_RX, so the fuel Product JSON-LD completeness check
 * silently skipped pages at the 5 legacy-alias slugs FUEL_SECTION_RX also
 * covers. Migrating THIS file (unlike validate-structured-data-completeness.mjs,
 * which stays on the old regex per #3299's declared exception for its live
 * JobPosting-schema gate) is safe: audit-dist-multi is not itself invoked by
 * any automated CI workflow (see tests/deploy-workflow.test.ts
 * GATES_NOT_IN_DIST_PARALLEL — "aggregators that wrap other audits"), and the
 * legacy-alias slugs are redirect-only compat paths with no real emitted
 * dist/*.html Product schema today.
 */
describe('audit-dist-multi.mjs sdClassifyPage/sdValidateFuelMerchantProduct (#3303)', () => {
  const distPath = (rel: string) => join(DIST, ...rel.split('/'));

  const canonicalFuelPaths = [
    'prezzi-benzina/oggi/index.html',
    'prezzi-diesel/chiasso/oggi/index.html',
    'en/gasoline-price-switzerland/italy/como/today/index.html',
    'en/diesel-price-switzerland/italy/como/today/index.html',
    'de/benzinpreis-schweiz/heute/index.html',
    'de/dieselpreis-schweiz/heute/index.html',
    'fr/prix-essence-suisse/aujourd-hui/index.html',
    'fr/prix-gasoil-suisse/aujourd-hui/index.html',
  ];
  it.each(canonicalFuelPaths)('sdClassifyPage: canonical slug %s still classifies as fuel (no regression)', (rel) => {
    expect(sdClassifyPage(distPath(rel))).toBe('fuel');
  });

  // The 5 legacy-alias slugs FUEL_SECTION_RX adds over the old inline
  // alternation (scripts/lib/fuelSections.mjs) — previously mis-classified
  // as 'other' by sdClassifyPage and silently skipped by
  // sdValidateFuelMerchantProduct.
  const legacyAliasFuelPaths = [
    'prezzi-benzina-svizzera/oggi/index.html',
    'prezzi-carburante-svizzera/oggi/index.html',
    'fuel-prices-switzerland/today/index.html',
    'fr/prix-diesel-suisse/aujourd-hui/index.html',
    'de/benzinpreise-schweiz/heute/index.html',
  ];
  it.each(legacyAliasFuelPaths)('sdClassifyPage: legacy-alias slug %s now classifies as fuel', (rel) => {
    expect(sdClassifyPage(distPath(rel))).toBe('fuel');
  });

  const nonFuelPages = [
    ['cerca-lavoro-ticino/index.html', 'job'],
    ['blog/some-article/index.html', 'blog'],
    ['aziende/some-company/index.html', 'company'],
    ['statistiche/index.html', 'statistics'],
    ['tax/index.html', 'other'],
  ] as const;
  it.each(nonFuelPages)('sdClassifyPage: %s still classifies as %s (no regression)', (rel, expected) => {
    expect(sdClassifyPage(distPath(rel))).toBe(expected);
  });

  const incompleteProduct = { '@type': 'Product' }; // missing image/description/global identifier/etc.
  // Every field sdValidateFuelMerchantProduct checks (image, description,
  // brand, aggregateRating.*, review.*; offers/return-policy are optional —
  // only validated when present) so `completeProduct` genuinely produces 0
  // errors rather than happening to skip a later branch.
  const completeProduct = {
    '@type': 'Product',
    image: 'https://example.com/fuel.jpg',
    description: 'Prezzo medio del diesel in Svizzera oggi.',
    brand: 'Frontaliere Ticino',
    aggregateRating: { ratingValue: '4.5', reviewCount: '12', bestRating: '5', worstRating: '1' },
    review: {
      reviewBody: 'Dati aggiornati quotidianamente, molto utili.',
      author: { name: 'Mario Rossi' },
      reviewRating: { ratingValue: '5' },
    },
  };

  it('sdValidateFuelMerchantProduct: non-Product schema is ignored regardless of path', () => {
    expect(sdValidateFuelMerchantProduct({ '@type': 'Dataset' }, distPath('prezzi-benzina-svizzera/oggi/index.html'))).toEqual([]);
  });

  it('sdValidateFuelMerchantProduct: canonical-slug Product still validated (no regression)', () => {
    const okErrors = sdValidateFuelMerchantProduct(completeProduct, distPath('prezzi-benzina/oggi/index.html'));
    expect(okErrors).toEqual([]);
    const badErrors = sdValidateFuelMerchantProduct(incompleteProduct, distPath('prezzi-benzina/oggi/index.html'));
    expect(badErrors.length).toBeGreaterThan(0);
  });

  it('sdValidateFuelMerchantProduct: Product outside any fuel section is skipped entirely', () => {
    expect(sdValidateFuelMerchantProduct(incompleteProduct, distPath('aziende/some-company/index.html'))).toEqual([]);
  });

  it.each(legacyAliasFuelPaths)(
    'sdValidateFuelMerchantProduct: legacy-alias slug %s incomplete Product is now flagged (was silently skipped pre-#3303)',
    (rel) => {
      const errors = sdValidateFuelMerchantProduct(incompleteProduct, distPath(rel));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === 'image')).toBe(true);
    },
  );

  it.each(legacyAliasFuelPaths)(
    'sdValidateFuelMerchantProduct: legacy-alias slug %s complete Product still passes',
    (rel) => {
      expect(sdValidateFuelMerchantProduct(completeProduct, distPath(rel))).toEqual([]);
    },
  );
});
