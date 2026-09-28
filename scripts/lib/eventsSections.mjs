/**
 * Shared canton-aware events section matcher.
 * ─────────────────────────────────────────────────────────────────────────
 * Shared "is this dist path under an events section?" matcher, extracted
 * per AGENTS.md non-negotiable #6 (a regex duplicated literally in ≥2 files →
 * one shared module) so the TI-vs-canton-aware drift class that already hit
 * job-board (2026-06-11 post-deploy title-length failure, fixed via
 * `./jobBoardSections.mjs`) doesn't keep recurring feature-by-feature.
 *
 * Consumers: the audit feature-classifiers audit-title-length,
 * audit-text-html-ratio, and audit-dist-multi's copies of both.
 *
 * Why this is broad (all cantons, not just TI).
 *   The old literal was TI-only:
 *     /(?:^|\/)(?:eventi\/ticino|events\/ticino|veranstaltungen\/tessin|evenements\/tessin)(?:\/|$)/
 *   Commit c1e56b62679 (#3125/#3243) shipped nationwide event sourcing
 *   (guidle.com, myswitzerland.com) — every canton now gets its own events
 *   section via `eventsBasePathForCanton()` (scripts/lib/events-utils.mjs),
 *   e.g. `/eventi/zurigo/`, `/en/events/aargau/`, `/de/veranstaltungen/bern/`
 *   — but the classifier kept matching ONLY the TI segment. Every non-TI
 *   events page fell through to the generic `spa-locale` (en/de/fr) /
 *   `spa-other` (it) buckets, whose baseline caps are small (30 / event
 *   pages are markup-heavy by design — event cards + Event JSON-LD + a map —
 *   so this drifted BOTH the title-length and text-html-ratio ratchets on a
 *   normal crawl, with no real content-quality regression (issue #3232).
 *   Matching the locale segment generically (any canton/comune/digest slug)
 *   removes the false positive and auto-covers any future canton.
 *
 * Why the trailing segment is OPTIONAL (issue #3645, F3).
 *   F3 added a real, indexable Swiss-wide index hub at the bare
 *   `/eventi/` (+ locale variants) root, one level above every canton hub
 *   matched below — same markup-heavy shape (stat tiles, a 26-canton grid,
 *   an upcoming-events list, FAQ, methodology), same audit-classification
 *   risk as the original #3232 leak: without this, the bare root falls
 *   through to `spa-other`/`spa-locale` and can drift those ratchets on a
 *   normal crawl. Made the trailing `/<canton>` segment optional so the
 *   bare root classifies as `eventi` too, instead of repeating the same
 *   bug class for a different page.
 */

/** The localized root segments are shared by audits and runtime analytics. */
export const EVENTS_ROOT_SEGMENTS = Object.freeze([
  'eventi',
  'events',
  'veranstaltungen',
  'evenements',
]);

const EVENTS_ROOT_PATTERN = EVENTS_ROOT_SEGMENTS.join('|');

/**
 * Matches the leading events section segment of a normalised dist path
 * (a path beginning with `/`, optionally locale-prefixed `/en|/de|/fr`).
 * Examples that match: `/eventi/` (bare index hub), `/eventi/ticino/…`,
 * `/eventi/zurigo/…`, `/en/events/aargau/…`,
 * `/de/veranstaltungen/graubunden/…`, `/fr/evenements/vaud/…`,
 * `/eventi/questo-weekend/…` (digest landing).
 */
export const EVENTS_SECTION_RX = new RegExp(
  `(?:^|\/)(?:${EVENTS_ROOT_PATTERN})(?:\/[a-z][a-z-]*)?(?:\/|$)`,
);

const EVENTS_DIGEST_SEGMENTS = new Set([
  'questa-settimana',
  'questo-weekend',
  'this-week',
  'this-weekend',
  'diese-woche',
  'dieses-wochenende',
  'cette-semaine',
  'ce-week-end',
]);

const EVENTS_OTHER_SEGMENTS = new Set([
  'altri-eventi',
  'other-events',
  'weitere-veranstaltungen',
  'autres-evenements',
]);

/**
 * Classify the canonical page shape below a localized events root.
 * `localPath` must already have its optional locale prefix removed.
 * Keeping this classifier next to `EVENTS_SECTION_RX` prevents the GA4 route
 * taxonomy from drifting away from the static-page/audit taxonomy.
 */
export function classifyEventsPage(localPath) {
  const segments = String(localPath || '').split('/').filter(Boolean);
  if (!EVENTS_ROOT_SEGMENTS.includes(segments[0])) return null;

  const tail = segments.slice(1);
  if (tail.length === 0) return 'events_index';
  if (tail.length === 1) return 'events_hub';
  if (tail.length === 2) {
    if (EVENTS_DIGEST_SEGMENTS.has(tail[1])) return 'events_digest';
    if (EVENTS_OTHER_SEGMENTS.has(tail[1])) return 'events_other';
    return 'events_comune';
  }
  if (/^page-\d+$/.test(tail[tail.length - 1])) return 'events_overflow';
  return 'event_detail';
}

/**
 * Classify a dist-relative HTML path, including its optional locale prefix.
 * Validators use this to apply the Event-detail contract only to documents
 * emitted by eventsSeoPagesPlugin; legacy Event objects embedded in editorial
 * pages (for example the holiday calendar) have a different schema contract.
 */
export function classifyEventsDistPath(distRelativePath) {
  const normalized = String(distRelativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const withoutIndex = normalized.replace(/(?:^|\/)index\.html$/, '');
  const withoutLocale = withoutIndex.replace(/^(?:en|de|fr)\//, '');
  return classifyEventsPage(`/${withoutLocale}`);
}

/**
 * @param {string} normalisedPath path that already starts with `/` and has had
 *   the `dist/` prefix and trailing `index.html` stripped (the form the audit
 *   classifiers build before bucketing).
 * @returns {boolean} true when the path is under any canton-aware events
 *   section (TI legacy, any canton, or a digest landing).
 */
export function isEventsSectionPath(normalisedPath) {
  return EVENTS_SECTION_RX.test(normalisedPath);
}
