/**
 * Shared health-facilities section matcher.
 * ─────────────────────────────────────────────────────────────────────────
 * Shared "is this dist path under the health-facilities hub?" matcher,
 * extracted per AGENTS.md non-negotiable #6 (a regex duplicated literally in
 * ≥2 files → one shared module) so the same classifier-drift class that hit
 * job-board (2026-06-11) and events (#3232) doesn't recur feature-by-feature.
 *
 * Consumers: the audit feature-classifiers audit-title-length and
 * audit-text-html-ratio (and audit-dist-multi's re-exported copies of both).
 *
 * Root cause (2026-07-22 validate-dist regression). The health-facilities
 * hub (epic #4455/#4457, build-plugins/healthFacilitiesPlugin.ts) shipped
 * with no entry in either audit's `classifyFeature`. Its pages are markup-
 * heavy by design (facility JSON-LD + job cards, same shape as `eventi` /
 * `border-wait` / `fuel-daily`) but carry substantive real prose (verified
 * live: 400+ words in `<main>`), so a low text/HTML ratio here isn't a
 * content-quality regression — it's the same structurally-thin profile
 * already accepted for `eventi`. Without a dedicated bucket, every facility
 * page fell through to the generic `spa-locale`/`spa-other` catch-all, whose
 * baseline expects near-zero offenders, tripping the `text-html-ratio`
 * rate-ratchet gate on a normal crawl with no real regression.
 */

/** Locale → URL section (matches build-plugins/healthFacilitiesData.ts HEALTH_FACILITY_SECTION). */
const SECTIONS = ['strutture-sanitarie', 'en/healthcare-facilities', 'de/gesundheitseinrichtungen', 'fr/etablissements-sante'];

/**
 * Matches the leading health-facilities section segment of a normalised dist
 * path (a path beginning with `/`, optionally locale-prefixed `/en|/de|/fr`).
 * Examples that match: `/strutture-sanitarie/clinique-la-source/`,
 * `/en/healthcare-facilities/psgn/`, `/de/gesundheitseinrichtungen/fmi/`,
 * `/fr/etablissements-sante/merian-iselin/`.
 */
export const HEALTH_FACILITIES_SECTION_RX = new RegExp(
  `(?:^|/)(?:${SECTIONS.map((s) => s.replace(/\//g, '\\/')).join('|')})(?:/|$)`,
);

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped (the form the audit
 *   classifiers build before bucketing).
 * @returns {boolean} true when the path is under the health-facilities hub.
 */
export function isHealthFacilitiesSectionPath(normalisedPath) {
  return HEALTH_FACILITIES_SECTION_RX.test(normalisedPath);
}
