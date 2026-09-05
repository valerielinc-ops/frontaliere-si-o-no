#!/usr/bin/env node
/**
 * Shared carrier for a source-proven zero ("I looked at the source and it says
 * it has no open positions"), consumed by `runStandardCrawlerPipeline` through
 * its `validateAuthoritativeSnapshot` hook.
 *
 * WHY THIS EXISTS (issues #7458 / #6660 / #7321). "crawler unhealthy" covers
 * three different states, not two: a proven-empty source, a full source the run
 * never observed (early exit / aborted batch), and a source that is *plausibly*
 * empty but has no way to prove it. The third one is a permanent backlog
 * generator: `check-crawler-health.mjs` cannot tell it apart from a dead
 * selector, so it reopens the same issue every week forever.
 *
 * The fix is to make those crawlers publish a zero that carries its own
 * evidence. It is deliberately NOT an `EMPTY_OK_CRAWLERS` entry: that allowlist
 * silences the slug even after the source actually dies, which trades a noisy
 * defect for a silent one. The proof here is re-established on every single run
 * and disappears the moment the source stops saying "empty" — so a crawler that
 * really breaks goes back to `unhealthy` on the next run.
 *
 * Contract for a caller:
 *   - prove the source is empty *positively* (a rendered zero-count, an
 *     explicit empty-state marker, an empty-but-present listing container) —
 *     never "the parser found nothing", which is exactly the ambiguity this
 *     module exists to remove;
 *   - a fetch that failed, was skipped, or produced an unrecognised page must
 *     NOT be marked: return a bare `[]` and let the pipeline keep the previous
 *     slice (and let the health monitor keep complaining);
 *   - wire the runner with `allowAuthoritativeEmptySnapshot: true` and
 *     `authoritativeSnapshotScope: 'empty-only'`, so a non-empty batch keeps the
 *     ordinary miss-grace path.
 */

const PROVEN_EMPTY_STATE = 'authoritative-source-zero';

/**
 * Stamp the proof on the (empty) batch. Non-enumerable on purpose — repo idiom
 * shared with `discoveredCount` (ocst, chicco-doro, albergo-gardenia): the
 * crawler template reads it as a plain property, but an enumerable own property
 * would leak into deep-equality contracts like `resolves.toEqual([])` and into
 * the serialised dataset.
 *
 * @param {object[]} jobs must be an empty array
 * @param {string} evidence human-readable description of what proved the zero
 * @returns {object[]} the same array, stamped
 */
export function markAuthoritativeEmptySnapshot(jobs, evidence) {
  if (!Array.isArray(jobs) || jobs.length !== 0) {
    throw new Error('markAuthoritativeEmptySnapshot: only an empty batch can be a proven empty snapshot');
  }
  const reason = String(evidence || '').trim();
  if (!reason) {
    throw new Error('markAuthoritativeEmptySnapshot: evidence string is required');
  }
  Object.defineProperties(jobs, {
    authoritativeEmptyState: { value: PROVEN_EMPTY_STATE, enumerable: false },
    authoritativeEmptyEvidence: { value: reason, enumerable: false },
    discoveredCount: { value: 0, enumerable: false },
  });
  return jobs;
}

/**
 * True only for a batch stamped by `markAuthoritativeEmptySnapshot`.
 *
 * @param {unknown} jobs
 */
export function isAuthoritativeEmptySnapshot(jobs) {
  return Array.isArray(jobs)
    && jobs.length === 0
    && Reflect.get(jobs, 'authoritativeEmptyState') === PROVEN_EMPTY_STATE;
}

/**
 * Build the `validateAuthoritativeSnapshot` callback for one crawler.
 *
 * A plain `[]` is rejected on purpose: that is the "I never got to look" case,
 * and granting it source authority would retire live jobs on a fetch failure.
 *
 * @param {string} label company label, used in the refusal message
 * @returns {(jobs: unknown) => true}
 */
export function authoritativeEmptySnapshotValidator(label) {
  return (jobs) => {
    if (isAuthoritativeEmptySnapshot(jobs)) return true;
    // Say WHICH condition refused — same reasoning as
    // `assertCompleteArtisaSnapshot` (issue #7425 item 3): a permanent parser
    // drift and a transient fetch shortfall otherwise produce the same red,
    // and only one of them clears itself.
    const rows = Array.isArray(jobs) ? jobs.length : 'not-an-array';
    const state = Array.isArray(jobs)
      ? Reflect.get(jobs, 'authoritativeEmptyState') ?? '(unset)'
      : 'n/a';
    throw new Error(
      `${label} snapshot is not a proven authoritative empty state: `
      + `rows=${rows}, state=${state} (expected ${PROVEN_EMPTY_STATE})`,
    );
  };
}

export { PROVEN_EMPTY_STATE };
