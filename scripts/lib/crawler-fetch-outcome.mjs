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
]);

/**
 * The outcomes that are evidence of breakage on the run's own report, and
 * therefore need no corroborating streak. Kept apart from the full set because
 * `ok` and `filtered_empty` are the opposite claim: they assert the zero is
 * legitimate.
 */
export const CRAWLER_FETCH_FAILURE_OUTCOMES = new Set(['anti_bot_block', 'selector_miss']);

/**
 * Read a slice's (or parser's) self-reported outcome, or `null` when it is
 * absent or not a recognised value. An unknown string is a producer bug, and
 * reading it as evidence would let a typo (`selector-miss`) flip a verdict.
 *
 * @param {unknown} value
 * @returns {'ok'|'anti_bot_block'|'selector_miss'|'filtered_empty'|null}
 */
export function normalizeFetchOutcome(value) {
  return typeof value === 'string' && CRAWLER_FETCH_OUTCOMES.has(value) ? value : null;
}
