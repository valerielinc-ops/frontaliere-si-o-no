/**
 * Shared "employer landing" section matchers — career-landings vs.
 * weekly-employers (leaf/hub) — extracted per CLAUDE.md non-negotiable #6 (a
 * regex duplicated literally in ≥2 files → one shared module), same class of
 * incident as `fuelSections.mjs`.
 *
 * Why this exists.
 *   Two DIFFERENT page families share adjacent URL prefixes and were
 *   conflated by `audit-title-length`'s classifier (and its `audit-dist-multi`
 *   mirror):
 *
 *     career-landings:   /cerca-lavoro-ticino/azienda-{slug}/ (+ en/de/fr)
 *                         one page per company, evergreen job-search landing.
 *     weekly-employers:   /aziende-che-assumono/{city}/{company}/{when}/
 *                         per-city×company snapshot, refreshed weekly.
 *     weekly-employers-hub: /aziende-che-assumono/{city|tutte}/{when}/
 *                         the city/all-companies index above the leaf.
 *
 *   `audit-text-html-ratio` already split these into three correctly-bucketed
 *   features (its own comment: "has career-landings, weekly-employers
 *   per-company×city ... more granular"). `audit-title-length` never got the
 *   same split — it lumped `career-landings` pages into `weekly-employers`,
 *   so that bucket's real-defect baseline (12, calibrated on the old, narrow
 *   weekly-employers population) blew up once career-landings grew into its
 *   own page family (1360 offenders). Its `weekly-employers-hub` alternation
 *   also carried a typo'd German slug (`unternehmen-die-einstellen`, which
 *   nothing generates — the real slug is `unternehmen-einstellen`, see
 *   `build-plugins/weeklyEmployersData.ts`) and was missing the French weekly
 *   slug `entreprises-recrutent` entirely (only had the different
 *   all-companies-hub slug `entreprises-qui-recrutent`) — so DE/FR weekly-
 *   employer pages fell through to the generic `spa-locale` bucket instead,
 *   contributing to that bucket's own drift.
 *
 * Keeping the buckets correct.
 *   Must stay in sync with the actual slug sources: IT/EN reuse one slug for
 *   both the weekly snapshot and the all-companies hub
 *   (`aziende-che-assumono`/`companies-hiring`); DE/FR use a DIFFERENT slug
 *   per feature (`unternehmen-einstellen` vs `firmen-die-einstellen`,
 *   `entreprises-recrutent` vs `entreprises-qui-recrutent`) — see
 *   `build-plugins/weeklyEmployersData.ts` (weekly) and
 *   `build-plugins/seoHubsData.ts` (all-companies hub). A new locale slug
 *   shipped there must be added here in the same change.
 *
 * Consumers: `audit-title-length` (re-exported to `audit-h1-title-duplicates`),
 * `audit-text-html-ratio`, and `audit-dist-multi`.
 */

import { JOB_BOARD_SECTION_PREFIX_SOURCE } from './jobBoardSections.mjs';

/**
 * One page per company, evergreen job-search landing (canton-aware —
 * `/cerca-lavoro-ticino/azienda-{slug}/` is the TI legacy instance, but every
 * canton has its own job-board section, e.g. `/cerca-lavoro-zurigo/azienda-{slug}/`).
 * A TI-only literal here meant non-TI canton career-landing pages fell through
 * to the weekly-employers bucket, misclassifying/undercounting them in
 * `audit-title-length`/`audit-text-html-ratio`/`audit-dist-multi`. Checked BEFORE
 * {@link WEEKLY_EMPLOYERS_LEAF_RX}/{@link WEEKLY_EMPLOYERS_HUB_RX} in every
 * classifier — different slug family, but ordering doesn't actually matter
 * since the alternations never overlap.
 */
export const CAREER_LANDINGS_RX = new RegExp(
  `(?:^|/)(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*/(?:azienda|company|unternehmen|entreprise)-[^/]+/?$`,
);

/** Per-city×company weekly snapshot leaf (`/aziende-che-assumono/{city}/{company}/{when}/`). */
export const WEEKLY_EMPLOYERS_LEAF_RX =
  /(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\/[^/]+\/[^/]+\//;

/** City/all-companies index hub above the leaf. Checked AFTER the leaf regex (more specific wins). */
export const WEEKLY_EMPLOYERS_HUB_RX =
  /(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//;

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped.
 * @returns {'career-landings' | 'weekly-employers' | 'weekly-employers-hub' | null}
 *   `null` when none of the three families match — caller continues its own
 *   classification chain.
 */
export function classifyEmployerLandingFeature(normalisedPath) {
  if (CAREER_LANDINGS_RX.test(normalisedPath)) return 'career-landings';
  if (WEEKLY_EMPLOYERS_LEAF_RX.test(normalisedPath)) return 'weekly-employers';
  if (WEEKLY_EMPLOYERS_HUB_RX.test(normalisedPath)) return 'weekly-employers-hub';
  return null;
}
