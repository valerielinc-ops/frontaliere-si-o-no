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

// The legacy Ticino snapshot emitter also owns an evergreen hub, monthly
// aggregates, and a closed set of sector pages. Keep those route forms here
// instead of making callers infer ownership from a shared substring such as
// "job-market". The values mirror build-plugins/jobMarketSnapshotData.ts.
const JOB_MARKET_ROUTE_CONFIG = Object.freeze([
  Object.freeze({
    root: 'mercato-lavoro-ticino',
    weeklyPrefix: 'settimana',
    monthNames: Object.freeze([
      'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
      'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
    ]),
    sectorSegment: 'settore',
  }),
  Object.freeze({
    root: 'en/ticino-job-market',
    weeklyPrefix: 'week',
    monthNames: Object.freeze([
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ]),
    sectorSegment: 'sector',
  }),
  Object.freeze({
    root: 'de/tessiner-arbeitsmarkt',
    weeklyPrefix: 'woche',
    monthNames: Object.freeze([
      'januar', 'februar', 'maerz', 'april', 'mai', 'juni',
      'juli', 'august', 'september', 'oktober', 'november', 'dezember',
    ]),
    sectorSegment: 'branche',
  }),
  Object.freeze({
    root: 'fr/marche-travail-tessin',
    weeklyPrefix: 'semaine',
    monthNames: Object.freeze([
      'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
    ]),
    sectorSegment: 'secteur',
  }),
]);

const JOB_MARKET_SECTOR_SLUGS = Object.freeze([
  'infermieri', 'educatori', 'case-anziani', 'sanita', 'amministrativo',
  'vendite', 'finanza', 'informatica', 'retail', 'meccanica', 'edilizia',
  'ristorazione', 'logistica', 'ingegneria',
]);

const JOB_MARKET_MONTH_RE = /^(?:[a-z]+)-\d{4}$/;
const JOB_MARKET_WEEK_RE_BY_PREFIX = new Map(
  JOB_MARKET_ROUTE_CONFIG.map((route) => [
    route.weeklyPrefix,
    new RegExp(`^${escapeRegExp(route.weeklyPrefix)}-(?:0[1-9]|[1-4]\\d|5[0-3])-\\d{4}$`),
  ]),
);

function normalizeJobMarketPath(value) {
  let path = String(value || '').replace(/\\/g, '/').split(/[?#]/, 1)[0];
  path = path.replace(/^\/+/, '').replace(/\/index\.html$/, '').replace(/\/+$/, '');
  return path;
}

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

/**
 * Match every canonical route owned by the legacy job-market snapshot
 * emitter: hub, weekly/monthly archive, sector page, or the canton snapshot
 * variant handled by the companion emitter.
 *
 * @param {string} snapshotPath URL pathname or dist-relative path
 * @returns {boolean} whether the path belongs to the job-market snapshot family
 */
export function isJobMarketSnapshotPath(snapshotPath) {
  if (isWeeklyJobMarketSnapshotPath(snapshotPath)) return true;

  const path = normalizeJobMarketPath(snapshotPath);
  if (!path) return false;

  for (const route of JOB_MARKET_ROUTE_CONFIG) {
    if (path === route.root) return true;
    if (!path.startsWith(`${route.root}/`)) continue;

    const tail = path.slice(route.root.length + 1).split('/');
    if (tail.length === 1) {
      const [segment] = tail;
      const weekRe = JOB_MARKET_WEEK_RE_BY_PREFIX.get(route.weeklyPrefix);
      if (weekRe.test(segment)) return true;
      if (JOB_MARKET_MONTH_RE.test(segment)) {
        const [month] = segment.split('-');
        if (route.monthNames.includes(month)) return true;
      }
      continue;
    }

    if (tail.length === 2 && tail[0] === route.sectorSegment
      && JOB_MARKET_SECTOR_SLUGS.includes(tail[1])) {
      return true;
    }
  }

  return false;
}
