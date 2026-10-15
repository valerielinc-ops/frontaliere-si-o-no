/**
 * Shared matcher for the weekly job-market snapshot data vertical.
 *
 * These pages are records from the weekly jobs snapshot, not editorial prose:
 * their differentiating payload is the period/canton and its counts. The
 * information-gain audit must keep them out of the editorial near-duplicate
 * cohorts, while leaving the evergreen hub, monthly and sector pages in scope.
 *
 * The legacy weekly roots come from build-plugins/jobMarketSnapshotData.ts.
 * The canton snapshot roots come from
 * build-plugins/jobMarketSnapshotChCantonPathsData.ts. This module stays
 * runtime-neutral so the dist audit can use the same boundary without
 * importing TypeScript build-plugin code.
 */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WEEKLY_JOB_MARKET_STEMS = Object.freeze([
  'mercato-lavoro-ticino/settimana',
  'en/ticino-job-market/week',
  'de/tessiner-arbeitsmarkt/woche',
  'fr/marche-travail-tessin/semaine',
]);

const WEEKLY_PERIOD_SUFFIX = '(?:\\d{1,2}-\\d{4}|corrente|current|aktuell|actuelle)';
const WEEKLY_JOB_MARKET_STEM_SOURCE = WEEKLY_JOB_MARKET_STEMS
  .map(escapeRegExp)
  .join('|');

/**
 * Canton snapshot pages are emitted below the locale-aware job-board section
 * and use exactly one `snapshot` leaf. Keep the locale/prefix pairing aligned
 * with CANTON_JOB_BOARD_PREFIX, including the frozen legacy German `jobs-im`
 * form; `jobs-in` remains accepted for already-emitted compatible routes.
 */
const CANTON_SNAPSHOT_ROOT_SOURCE = [
  'cerca-lavoro-[a-z][a-z-]*',
  'en/find-jobs-[a-z][a-z-]*',
  'de/jobs-(?:im|in)-[a-z][a-z-]*',
  'fr/trouver-emploi-[a-z][a-z-]*',
].join('|');

/**
 * Matches a dist-relative path or URL pathname for a weekly snapshot page.
 * Accepts both the canonical trailing slash and the emitted `index.html`
 * representation used by the dist audit.
 */
export const WEEKLY_JOB_MARKET_SNAPSHOT_RX = new RegExp(
  `^/?(?:${WEEKLY_JOB_MARKET_STEM_SOURCE})-${WEEKLY_PERIOD_SUFFIX}(?:/index\\.html)?/?$|^/?(?:${CANTON_SNAPSHOT_ROOT_SOURCE})/snapshot(?:/index\\.html)?/?$`,
);

/**
 * @param {string} snapshotPath dist-relative path or URL pathname
 * @returns {boolean} whether the path is a weekly/canton job-market snapshot
 */
export function isWeeklyJobMarketSnapshotPath(snapshotPath) {
  return WEEKLY_JOB_MARKET_SNAPSHOT_RX.test(String(snapshotPath || ''));
}
