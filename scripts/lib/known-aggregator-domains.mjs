/**
 * Known job-board / aggregator domains — the single source of truth shared by
 * the prospector's platform registry (`scripts/lib/prospector/config.mjs`) and
 * the dedicated-crawler source-integrity gate
 * (`tests/aggregator-sourced-crawler-gate.test.ts`).
 *
 * Why this exists as its own file instead of living only in prospector/config:
 * a dedicated crawler built by hand (via `scripts/scaffold-crawler.mjs`, before
 * the prospector existed) can source an employer's postings from one of these
 * domains exactly the way the prospector is designed never to. The prospector
 * already refuses to treat these as rentable single-tenant platforms
 * (`NON_PLATFORM_HOSTS`); this list is what lets the OTHER creation path
 * — a manually written `*-job-parser.mjs` — be held to the same constraint,
 * without duplicating (and risking drift on) the domain set itself.
 *
 * A domain here is a multi-employer marketplace: its business is aggregating
 * postings from many employers, not hosting one employer's own careers page.
 * Sourcing a dedicated crawler's `url`/`applyUrl` from one of these domains is
 * not automatically wrong — an employer may genuinely have chosen it as their
 * outsourced application channel (see `AGGREGATOR_BACKED_SHARED_CLIENTS`
 * below and the gate that requires evidence) — but it must never be silent.
 */

/** Registrable domains of known multi-employer Swiss/international job boards. */
export const KNOWN_AGGREGATOR_DOMAINS = new Set([
  'jobs.ch', 'jobup.ch', 'indeed.com', 'indeed.ch', 'stepstone.ch', 'stepstone.de',
  'monster.ch', 'jobscout24.ch', 'ostjob.ch', 'jobagent.ch',
  'job-room.ch', 'arbeit.swiss', 'eures.europa.eu',
  'jobwinner.ch', 'topjobs.ch', 'jobsuchmaschine.ch',
  'glassdoor.com', 'glassdoor.ch', 'karriere.at', 'ictjobs.ch',
]);

/**
 * Shared client modules (basenames under `scripts/lib/`) that fetch job data
 * FROM one of `KNOWN_AGGREGATOR_DOMAINS` and hand back a detail URL on that
 * same domain — i.e. importing one of these named exports from a
 * `*-job-parser.mjs` is, by construction, sourcing and linking through an
 * aggregator.
 *
 * Value shape, keyed by file basename:
 *   - `true`      — every export is aggregator-specific; any import from the
 *                    file counts (e.g. `jobs-ch-search-common.mjs`, which
 *                    exists ONLY to talk to jobs.ch).
 *   - `Set<name>` — only these specific exports indicate aggregator sourcing.
 *                    `jobup-ch-feed-common.mjs` needs this: it mixes real
 *                    jobup.ch-fetching functions (`createJobupChFeedParser`,
 *                    `fetchJobupDetailDescription`) with generic, reusable
 *                    parsing helpers that have nothing to do with jobup.ch
 *                    (`detectEmploymentTypeFromOccupation`, a plain
 *                    percentage-range classifier already reused by
 *                    `cham-swiss-properties-job-parser.mjs` and
 *                    `dic-sa-job-parser.mjs` for a source that is NOT
 *                    jobup.ch) — flagging the whole file would false-positive
 *                    on every consumer of the generic helper.
 *
 * Register a new entry here the day a second aggregator-fetching client is
 * built; the gate test discovers consumers automatically once it is listed.
 */
export const AGGREGATOR_BACKED_SHARED_CLIENTS = new Map([
  ['jobs-ch-search-common.mjs', true],
  ['jobup-ch-feed-common.mjs', new Set(['createJobupChFeedParser', 'fetchJobupDetailDescription'])],
]);

/**
 * @param {string} urlOrHost
 * @returns {boolean}
 */
export function isKnownAggregatorDomain(urlOrHost = '') {
  let host = String(urlOrHost || '');
  try { host = new URL(host).hostname; } catch { /* already a bare host */ }
  host = host.toLowerCase().replace(/^www\./, '');
  for (const domain of KNOWN_AGGREGATOR_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}
