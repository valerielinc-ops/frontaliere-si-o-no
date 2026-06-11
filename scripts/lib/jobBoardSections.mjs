/**
 * Shared canton-aware job-board section matcher.
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth for "is this dist path under a job-board section?",
 * used by the audit feature-classifiers (audit-title-length,
 * audit-text-html-ratio, audit-dist-multi). Extracted per CLAUDE.md
 * non-negotiable #6 (a regex duplicated literally in ≥2 files → one shared
 * module) so the TI-vs-canton-aware drift that caused the 2026-06-11
 * post-deploy title-length failure cannot happen again.
 *
 * Why this is broad (all cantons, not just TI).
 *   The old literal was TI-only:
 *     /(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//
 *   Cathedral migration (#1275+) shipped canton-aware job-board sections for
 *   every Swiss canton — `cerca-lavoro-argovia`, `find-jobs-geneva`,
 *   `jobs-in-aargau`, `trouver-emploi-vaud`, the `cerca-lavoro-svizzera`
 *   aggregator, German `jobs-in-der-…` prefixes, … — but the classifier kept
 *   matching ONLY the four TI legacy slugs. Every NON-TI canton job page
 *   (hub, city hub, category hub, editorial slot AND each job-detail page)
 *   therefore fell through to the generic `spa-locale` (en/de/fr) /
 *   `spa-other` (it) buckets. Long, externally-sourced job-detail titles
 *   (e.g. `/en/find-jobs-geneva/head-of-clinic-with-or-without-specialty-…/`)
 *   then drifted the volatile spa-locale ratchet over its cap on a normal
 *   daily crawl, with no real SEO change. Classifying them under `job-board`
 *   — where they belong, and which carries generous organic-growth headroom —
 *   removes the false positive and auto-covers any future canton (the prefix
 *   set is fixed; the canton slug is matched generically).
 *
 * Section-slug shape (data/canton-url-slugs.json → resolveCantonSection):
 *   it:  cerca-lavoro-{slug}      (TI legacy: cerca-lavoro-ticino)
 *   en:  find-jobs-{slug}         (TI legacy: find-jobs-ticino)
 *   de:  jobs-in-{slug} | jobs-in-der-{slug} | jobs-im-{slug}  (TI: jobs-im-tessin)
 *   fr:  trouver-emploi-{slug}    (TI legacy: trouver-emploi-tessin)
 *   aggregator: cerca-lavoro-svizzera / find-jobs-switzerland /
 *               jobs-in-schweiz / trouver-emploi-suisse
 * The canton slug may itself contain a hyphen (e.g. `san-gallo`), so the
 * trailing run allows `[a-z-]`. The match anchors on a path boundary and
 * stops at the next `/`, so it only ever classifies the SECTION segment —
 * deeper, more specific buckets (blog, fuel, health, …) are checked before
 * this in every classifier and still win.
 */

/**
 * Matches the leading job-board section segment of a normalised dist path
 * (a path beginning with `/`, optionally locale-prefixed `/en|/de|/fr`).
 * Examples that match: `/cerca-lavoro-ticino/…`, `/cerca-lavoro-argovia/…`,
 * `/cerca-lavoro-svizzera/…`, `/en/find-jobs-geneva/…`, `/de/jobs-im-tessin/…`,
 * `/de/jobs-in-aargau/…`, `/de/jobs-in-der-waadt/…`, `/fr/trouver-emploi-vaud/…`.
 */
export const JOB_BOARD_SECTION_RX =
  /(?:^|\/)(?:cerca-lavoro|find-jobs|trouver-emploi|jobs-in|jobs-im)-[a-z][a-z-]*\//;

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped (the form the audit
 *   classifiers build before bucketing).
 * @returns {boolean} true when the path is under any canton-aware job-board
 *   section (TI legacy, any canton, or the Switzerland aggregator).
 */
export function isJobBoardSectionPath(normalisedPath) {
  return JOB_BOARD_SECTION_RX.test(normalisedPath);
}
