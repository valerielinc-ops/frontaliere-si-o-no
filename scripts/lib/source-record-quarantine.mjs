/**
 * Per-record quarantine with a systemic-drift escape hatch, for batch parsers
 * that read a listing and then decide record by record.
 *
 * #7082 ("harden source details and replay evidence") made the rexx-systems and
 * jobup.ch batch parsers fail closed when the source contradicts a record — the
 * right call — but implemented it as `return []` on the FIRST such record. One
 * ad posted at a satellite address therefore discarded the whole batch: on
 * `kantonsspital-uri` (#7459) 25 good vacancies out of 26 were thrown away for
 * a single `j210`, the crawler published 0, and `check-crawler-health.mjs`
 * flagged it as broken week after week (same shape on #7461).
 *
 * The distinction this module encodes is the one the gates were missing:
 *
 *   - an EXCLUSION the source proves (this vacancy is not at the configured
 *     workplace) is a statement about ONE record → quarantine that record and
 *     keep publishing the rest. Not publishing it is exactly what the gate
 *     wants; dropping its 25 siblings is not.
 *   - an OBSERVATION the run failed to make (detail fetch failed, page did not
 *     parse, body too thin to tell) is a statement about the RUN → those stay
 *     `return []` at the call site, because publishing a batch missing a record
 *     nobody looked at would retire a live vacancy.
 *
 * The escape hatch mirrors the per-item quarantine already used at the dataset
 * boundary (`dedicated-crawler-common.mjs`, #3789): when the rejections stop
 * looking like individual outliers and start looking like the parser or the
 * configured headquarters having drifted, fail closed on the whole batch so the
 * previously published slice stays intact.
 */

/**
 * Share the dataset-boundary threshold (#3789) so both gates move together.
 * @returns {number}
 */
export function systemicRatio() {
  return Number(process.env.JOBS_SYSTEMIC_INVALID_RATIO) || 0.5;
}

/**
 * Population below which a rejection RATIO says nothing about drift (#7702,
 * follow-up of #7609).
 *
 * A ratio needs a sample. On a listing of three rows, two vacancies the source
 * legitimately places abroad read as 67% — over the 50% systemic threshold —
 * and the valve suppresses the one live Swiss vacancy too, which is the exact
 * traffic loss #7459 closed, just restricted to small tenants. Measured over
 * the eight jobup.ch feed tenants (`data/jobs/by-crawler`, 2026-09-06): six of
 * them publish four records or fewer and only two are in double digits, so on
 * this source family the ratio sits below its own sample floor most of the
 * time. Per-tenant counts in the #7702 PR body.
 *
 * Same idiom the sibling gates in `dedicated-crawler-common.mjs` already use
 * (`JOBS_SYSTEMIC_MIN_TOTAL` on the thin-source ratio, `BOILERPLATE_MIN_ELIGIBLE`
 * at the dataset boundary): below the floor the signal is too weak to brick a
 * whole batch.
 * @returns {number}
 */
export function systemicMinObserved() {
  return Number(process.env.JOBS_SYSTEMIC_MIN_OBSERVED) || 6;
}

/**
 * Minimum ABSOLUTE number of rejections a systemic verdict needs.
 *
 * Expressed as "what the ratio would demand on the smallest listing where the
 * ratio means anything" instead of a second cliff at `observed >= floor`: with
 * the defaults (50% of 6) that is 3, so 2-of-3 and 2-of-4 quarantine per record
 * and keep publishing the siblings, while 3-of-5 and 3-of-6 still fail closed
 * exactly as today. Never below the historical 2 — one outlier is never drift.
 * @returns {number}
 */
export function systemicMinRejections() {
  return Math.max(2, Math.ceil(systemicRatio() * systemicMinObserved()));
}

/**
 * The shared systemic verdict: rejections stopped looking like individual
 * outliers and started looking like the parser or the configured headquarters
 * having drifted.
 *
 * @param {number} rejectedCount how many records the gate rejected
 * @param {number} denominator how many records the gate actually judged
 * @returns {boolean}
 */
export function isSystemicRejection(rejectedCount, denominator) {
  if (rejectedCount < systemicMinRejections()) return false;
  const ratio = denominator > 0 ? rejectedCount / denominator : 1;
  return ratio >= systemicRatio();
}

/**
 * @param {{ label: string, total: number }} options
 *   `label` names the source in the log line; `total` is the number of records
 *   the listing announced, used as the systemic-ratio denominator only for
 *   callers that do not call `observe()`.
 */
export function createSourceRecordQuarantine({ label, total }) {
  const rejected = [];
  let observed = 0;

  return {
    /**
     * Count ONE record that actually reached the gate.
     *
     * The listing length is the wrong denominator: rows a parser skips before
     * the gate (no link, duplicate, title too short) are never judged, and
     * counting them dilutes the ratio — the dirtier the feed, the looser the
     * fail-closed valve that protects the already published slice. With 10
     * rows of which 4 are skipped, 3 rejected and 3 published, the listing
     * denominator reads 0.30 and stays silent where the 6 records actually
     * evaluated read 0.50, exactly the threshold.
     */
    observe() {
      observed += 1;
    },

    /**
     * Quarantine ONE record the source proved unpublishable.
     * @param {string} id record identifier for the log line
     * @param {string} reason human-readable cause
     */
    reject(id, reason) {
      rejected.push({ id, reason });
      console.log(`     ⚠ ${reason} for ${id}: record quarantined (${rejected.length}/${total})`);
    },

    get rejectedCount() {
      return rejected.length;
    },

    /**
     * Decide what the batch publishes.
     *
     * @param {Array<Object>} jobs the records that passed
     * @returns {Array<Object>} `jobs`, or `[]` when the rejections are systemic
     */
    settle(jobs) {
      if (!rejected.length) return jobs;

      const denominator = observed || total;
      const ratio = denominator > 0 ? rejected.length / denominator : 1;
      const systemic = isSystemicRejection(rejected.length, denominator);
      if (systemic || !jobs.length) {
        const sample = rejected.slice(0, 5).map((r) => `- ${r.id}: ${r.reason}`).join('\n');
        console.log(
          `\n⛔ ${label}: ${rejected.length}/${denominator} records rejected `
          + `(${(ratio * 100).toFixed(0)}% ≥ ${(systemicRatio() * 100).toFixed(0)}% systemic threshold) — `
          + 'that is a parser or headquarters drift, not per-record outliers. '
          + 'Publishing nothing so the previously published slice stays intact.\n'
          + `${sample}`
        );
        return [];
      }

      console.log(
        `  ⚠ ${label}: ${rejected.length}/${denominator} record(s) quarantined — `
        + `publishing the remaining ${jobs.length} (per-record gate, #7459).`
      );
      return jobs;
    },
  };
}
