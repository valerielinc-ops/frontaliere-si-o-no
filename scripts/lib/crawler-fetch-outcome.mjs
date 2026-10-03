/**
 * Shared vocabulary for a crawler run's self-reported fetch outcome (#7897).
 *
 * A summary slice may carry `lastFetchOutcome`: the run's own answer to WHY it
 * produced the jobs it did — and, when it produced none, which layer failed.
 * `total: 0` is the same number whether the source refused the fetch, the
 * parser's selectors stopped matching, or the board is genuinely empty, so the
 * crawler-health monitor could only wait three consecutive empty runs and then
 * report "N consecutive runs returned 0 jobs" — a symptom, never a cause.
 *
 * The set lives here rather than in the producer or the consumer because BOTH
 * validate against it (`crawler-template.mjs` before writing the field,
 * `check-crawler-health.mjs` before trusting it). Two literal copies would
 * drift the moment a value is added on one side only, and the failure mode is
 * silent: an unrecognised outcome is simply ignored, so the crawler quietly
 * falls back to the three-day streak it was supposed to escape.
 *
 * The field is OPTIONAL by construction. Absent — every slice written before
 * this existed, and every crawler not yet instrumented — reads as `null`, which
 * every consumer treats as the pre-#7897 behaviour. Nothing needs backfilling.
 */

/** Every value a run may legitimately report. */
export const CRAWLER_FETCH_OUTCOMES = new Set([
  // The fetch and the parse both worked. Says nothing about the job count: a
  // legitimately empty board is `ok`, and so is a run that published 40 jobs.
  'ok',
  // The source refused to serve the run (WAF, anti-bot fence, IP reputation).
  // The selectors were never exercised, so the parser is not the place to look.
  'anti_bot_block',
  // The fetch succeeded and the parser matched nothing it used to match:
  // selector / label / markup drift. The source is reachable.
  'selector_miss',
  // Candidates were found and the crawler's own filter (geographic, ownership,
  // …) dropped all of them. Not a failure — the same evidence as a
  // `discovered > 0, written === 0` slice (#5945), stated directly.
  'filtered_empty',
  // The crawler exhausted transport retries without observing the source.
  // This is distinct from selector drift: the parser never received a page.
  'connection_error',
  // The source answered with retryable HTTP statuses until the response retry
  // budget was exhausted. Unlike a connection error, the server was observed.
  'exhausted_retry',
  // The expected feed host answered with a redirect/HTML maintenance page.
  // This is an upstream endpoint outage, not malformed XML or selector drift.
  'feed_endpoint_unavailable',
]);

/**
 * The outcomes that are evidence of breakage on the run's own report, and
 * therefore need no corroborating streak. Kept apart from the full set because
 * `ok` and `filtered_empty` are the opposite claim: they assert the zero is
 * legitimate.
 */
export const CRAWLER_FETCH_FAILURE_OUTCOMES = new Set([
  'anti_bot_block',
  'selector_miss',
  'connection_error',
  'exhausted_retry',
  'feed_endpoint_unavailable',
]);

/**
 * Outcomes where the runner could not reliably inspect the source content.
 * These may use the `connection-level-fetch` early-exit cause; a selector miss
 * or a source-side endpoint response must remain distinguishable from them.
 */
export const CRAWLER_TRANSPORT_FAILURE_OUTCOMES = new Set([
  'anti_bot_block',
  'connection_error',
  'exhausted_retry',
]);

/**
 * Causes recorded by the process-exit summary guard for an early run.
 *
 * Every value is an ABORT: the run ended without publishing and the source was
 * not observed empty. A name only says which bail-out it was — it never makes
 * the run healthy.
 */
export const CRAWLER_ABORT_KINDS = new Set([
  // The parser returned nothing and offered no proof of an empty source.
  'no-jobs-parsed',
  'connection-level-fetch',
  'crash',
  // More than MISSING_DETAIL_URL_MAX_RATIO of the stored slice lost its
  // per-vacancy detail URL in this read; the old slice is kept untouched.
  'missing-detail-url',
  // The parser emitted jobs, none with a source body of at least 50 words
  // (fresh or stored): nothing is publishable, thin stored rows are quarantined.
  'thin-source-all',
  // Same outcome, but every parsed row reported a source-body extraction
  // failure (e.g. an unreadable PDF): the extractor broke, not the content.
  'source-extraction-failed',
]);

/**
 * May a parser-stamped empty snapshot be honoured after this self-reported
 * fetch outcome?
 *
 * Only when the run reported nothing at all (parsers that predate the field),
 * or reported an outcome that itself asserts the zero is legitimate (`ok`,
 * `filtered_empty`). Every other non-null value fails closed: a recognised
 * failure contradicts the stamp, and a value outside the vocabulary is a
 * producer bug. `normalizeFetchOutcome` reads an unknown string as `null` so a
 * typo cannot flip a health verdict; here the same reading would let that typo
 * retire every stored job, so this predicate takes the RAW value.
 *
 * @param {unknown} value the outcome exactly as the parser reported it
 * @returns {boolean}
 */
export function fetchOutcomeAllowsStampedEmpty(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string'
    && CRAWLER_FETCH_OUTCOMES.has(value)
    && !CRAWLER_FETCH_FAILURE_OUTCOMES.has(value);
}

/**
 * Read a slice's (or parser's) self-reported outcome, or `null` when it is
 * absent or not a recognised value. An unknown string is a producer bug, and
 * reading it as evidence would let a typo (`selector-miss`) flip a verdict.
 *
 * @param {unknown} value
 * @returns {'ok'|'anti_bot_block'|'selector_miss'|'filtered_empty'|'connection_error'|'exhausted_retry'|'feed_endpoint_unavailable'|null}
 */
export function normalizeFetchOutcome(value) {
  return typeof value === 'string' && CRAWLER_FETCH_OUTCOMES.has(value) ? value : null;
}

/**
 * Read an early-exit cause, or `null` when the producer did not report one.
 *
 * @param {unknown} value
 * @returns {'no-jobs-parsed'|'connection-level-fetch'|'crash'|'missing-detail-url'|'thin-source-all'|'source-extraction-failed'|null}
 */
export function normalizeAbortKind(value) {
  return typeof value === 'string' && CRAWLER_ABORT_KINDS.has(value) ? value : null;
}
