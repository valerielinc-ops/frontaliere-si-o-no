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
 * same domain — i.e. any `*-job-parser.mjs` importing one of these is, by
 * construction, sourcing and linking through an aggregator. Register a new
 * entry here the day a second such client is built (e.g. a jobup.ch- or
 * indeed-specific one); the gate test discovers consumers automatically once
 * the client is listed.
 */
export const AGGREGATOR_BACKED_SHARED_CLIENTS = new Set([
  'jobs-ch-search-common.mjs',
]);

/**
 * Registrable domain of a URL or bare host, without pulling in the
 * prospector's full `registrable.mjs` (public-suffix aware) for what only
 * needs to compare against a short, known, two-label-suffix-free list.
 *
 * @param {string} urlOrHost
 * @returns {string}
 */
export function registrableDomainSimple(urlOrHost = '') {
  let host = String(urlOrHost || '');
  try { host = new URL(host).hostname; } catch { /* already a bare host */ }
  host = host.toLowerCase().replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  return labels.length <= 2 ? host : labels.slice(-2).join('.');
}

/**
 * @param {string} urlOrHost
 * @returns {boolean}
 */
export function isKnownAggregatorDomain(urlOrHost = '') {
  return KNOWN_AGGREGATOR_DOMAINS.has(registrableDomainSimple(urlOrHost));
}
