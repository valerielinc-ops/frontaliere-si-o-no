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
function systemicRatio() {
  return Number(process.env.JOBS_SYSTEMIC_INVALID_RATIO) || 0.5;
}

/**
 * @param {{ label: string, total: number }} options
 *   `label` names the source in the log line; `total` is the number of records
 *   the listing announced, i.e. the denominator of the systemic ratio.
 */
export function createSourceRecordQuarantine({ label, total }) {
  const rejected = [];

  return {
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

      const ratio = total > 0 ? rejected.length / total : 1;
      const systemic = rejected.length >= 2 && ratio >= systemicRatio();
      if (systemic || !jobs.length) {
        const sample = rejected.slice(0, 5).map((r) => `- ${r.id}: ${r.reason}`).join('\n');
        console.log(
          `\n⛔ ${label}: ${rejected.length}/${total} records rejected `
          + `(${(ratio * 100).toFixed(0)}% ≥ ${(systemicRatio() * 100).toFixed(0)}% systemic threshold) — `
          + 'that is a parser or headquarters drift, not per-record outliers. '
          + 'Publishing nothing so the previously published slice stays intact.\n'
          + `${sample}`
        );
        return [];
      }

      console.log(
        `  ⚠ ${label}: ${rejected.length}/${total} record(s) quarantined — `
        + `publishing the remaining ${jobs.length} (per-record gate, #7459).`
      );
      return jobs;
    },
  };
}
