/**
 * Shared fuel-daily section matcher.
 * ─────────────────────────────────────────────────────────────────────────
 * Shared "is this dist path under a fuel-daily section?" matcher, extracted
 * per CLAUDE.md non-negotiable #6 (a regex duplicated literally in ≥2 files →
 * one shared module) so the locale-section drift that caused the 2026-06-24
 * post-deploy `title-length` failure stops recurring.
 *
 * Why this exists.
 *   The fuel-daily feature emits one top-level section segment per locale ×
 *   fuel type (build-plugins/fuelDailyData.ts → `FUEL_SECTION_SLUG`):
 *
 *     it:  prezzi-benzina            prezzi-diesel
 *     en:  gasoline-price-switzerland   diesel-price-switzerland
 *     de:  benzinpreis-schweiz        dieselpreis-schweiz
 *     fr:  prix-essence-suisse        prix-gasoil-suisse
 *
 *   The audit feature-classifiers each inlined this alternation. Over time the
 *   en/de/fr country-suffixed section slugs (`gasoline-price-switzerland`,
 *   `diesel-price-switzerland`, `dieselpreis-schweiz`, `prix-gasoil-suisse`)
 *   were added to most classifiers — but `audit-title-length` (and the mirror
 *   in `audit-dist-multi`) were left with the older BARE alternation
 *   (`gasoline-price`, `diesel-price`, `dieselpreis`, `prix-gasoil`, …), which
 *   matches only a `slug/` segment with no `-switzerland`/`-schweiz`/`-suisse`
 *   suffix. The real, country-suffixed town pages
 *   (e.g. `/fr/prix-gasoil-suisse/italie/{comune}/aujourd-hui/`) therefore fell
 *   through to the generic `spa-locale` (en/de/fr) bucket. Long Italian comune
 *   names (e.g. "Bardello Con Malgesso E Bregano") then drifted the volatile
 *   `spa-locale` title-length ratchet over its cap on a normal daily fuel
 *   crawl, with no real SEO change — exactly the false-positive class the
 *   `jobBoardSections.mjs` extraction (#1300+) already fixed for job pages.
 *
 * Keeping the bucket correct.
 *   `FUEL_SECTION_RX` lists every CURRENT canonical section slug plus the
 *   legacy aliases (`prezzi-benzina-svizzera`, `prezzi-carburante-svizzera`,
 *   `fuel-prices-switzerland`, `prix-diesel-suisse`, `benzinpreise-schweiz`)
 *   still referenced by redirect/compat emitters. It MUST stay in sync with
 *   `FUEL_SECTION_SLUG` — a new locale section slug shipped there must be added
 *   here in the same change.
 *
 * Consumers: the audit feature-classifiers `audit-title-length` (re-exported to
 * `audit-h1-title-duplicates` + `audit-title-no-disambig-hash`),
 * `audit-text-html-ratio`, `audit-page-weight`, and `audit-dist-multi`.
 */

/**
 * Matches the leading fuel-daily section segment of a normalised dist path
 * (a path beginning with `/`, optionally locale-prefixed `/en|/de|/fr`).
 * Anchors on a path boundary and stops at the next `/`, so it only ever
 * classifies the SECTION segment — deeper, more specific buckets are checked
 * before this in every classifier and still win.
 */
export const FUEL_SECTION_RX =
  /(?:^|\/)(?:prezzi-benzina-svizzera|prezzi-benzina|prezzi-diesel|prezzi-carburante-svizzera|gasoline-price-switzerland|diesel-price-switzerland|prix-essence-suisse|prix-diesel-suisse|prix-gasoil-suisse|fuel-prices-switzerland|benzinpreis-schweiz|dieselpreis-schweiz|benzinpreise-schweiz)\//;

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped (the form the audit
 *   classifiers build before bucketing).
 * @returns {boolean} true when the path is under any fuel-daily section
 *   (any locale, current canonical slug or legacy alias).
 */
export function isFuelSectionPath(normalisedPath) {
  return FUEL_SECTION_RX.test(normalisedPath);
}
