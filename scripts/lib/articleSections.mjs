/**
 * Shared blog/article section matcher.
 * ─────────────────────────────────────────────────────────────────────────
 * Shared "is this dist path under an editorial article section?" matcher,
 * extracted per CLAUDE.md non-negotiable #6 (a regex duplicated literally in
 * ≥2 files → one shared module) so the locale-section drift that caused the
 * 2026-06-24 post-deploy `title-length` failure (`spa-locale 91>90`) stops
 * recurring. Same drift class the `fuelSections.mjs` extraction (#2853) fixed
 * for fuel pages and `jobBoardSections.mjs` (#1300+) fixed for job pages.
 *
 * Why this exists.
 *   The site emits two parallel article sections, each with one localized hub
 *   slug per locale (services/articleSections.ts → `ARTICLE_SECTIONS[*].indexSlug`):
 *
 *               it                     en                  de                 fr
 *     fronta.:  articoli-frontaliere   cross-border-articles  grenzgaenger-artikel  articles-frontalier
 *     svizzera: articoli-svizzera      swiss-articles         schweiz-artikel       articles-suisse
 *
 *   The audit feature-classifiers each inlined this alternation, but only ever
 *   listed the `frontaliere` slugs — the `svizzera` mirror section (PR #1173)
 *   shipped its localized hub/archive landings (`/en/swiss-articles/…`,
 *   `/de/schweiz-artikel/…`, `/fr/articles-suisse/…`) afterwards and was never
 *   added. Those en/de/fr svizzera article pages therefore fell through to the
 *   generic `spa-locale` (en/de/fr) bucket instead of `blog`. As the svizzera
 *   section grew, their long keyword-rich titles drifted the volatile
 *   `spa-locale` title-length ratchet over its cap on a normal article batch,
 *   with no real SEO change — the same false-positive class as the fuel leak.
 *   (`blog`, the correct bucket, carries deliberate headroom for exactly this
 *   data-volatile article growth, so reclassifying them there is behaviour-
 *   correct, not a gate relaxation.)
 *
 * Keeping the bucket correct.
 *   `BLOG_SECTION_RX` lists every CURRENT canonical hub slug for BOTH sections.
 *   As of issue #4881 Fase 6 it is BUILT from `ARTICLE_SECTION_CORE_LIST` in
 *   `build-plugins/shared/articleSectionCore.mjs` — the same canonical tuple
 *   `services/articleSections.ts` re-exports as `ARTICLE_SECTIONS` — instead of
 *   a hand-written alternation, so a new section or locale hub slug shipped
 *   there is picked up here automatically; it can no longer drift out of sync
 *   by omission.
 *
 * Consumers: the audit feature-classifiers `audit-title-length` (re-exported to
 * `audit-h1-title-duplicates` + `audit-title-no-disambig-hash`),
 * `audit-text-html-ratio`, `audit-page-weight`, and `audit-dist-multi`.
 */
import { ARTICLE_SECTION_CORE_LIST } from '../../build-plugins/shared/articleSectionCore.mjs';

/** Every localized hub slug across both sections, in canonical (section, it/en/de/fr) order. */
const HUB_SLUGS = ARTICLE_SECTION_CORE_LIST.flatMap((entry) => Object.values(entry.indexSlug));

/**
 * Matches the leading editorial-article section segment of a normalised dist
 * path (a path beginning with `/`, optionally locale-prefixed `/en|/de|/fr`).
 * Anchors on a path boundary and stops at the next `/`, so it only ever
 * classifies the SECTION segment — deeper, more specific buckets are checked
 * before this in every classifier and still win.
 */
export const BLOG_SECTION_RX = new RegExp(`(?:^|/)(?:${HUB_SLUGS.join('|')})/`);

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped (the form the audit
 *   classifiers build before bucketing).
 * @returns {boolean} true when the path is under any editorial article section
 *   (frontaliere or svizzera, any locale).
 */
export function isBlogSectionPath(normalisedPath) {
  return BLOG_SECTION_RX.test(normalisedPath);
}
