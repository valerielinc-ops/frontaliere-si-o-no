/**
 * missing-index-error.mjs — one definition of "this Firestore query has no
 * index to serve it", shared by every reporting script that raises it.
 *
 * It lived as two hand-copied classes (scripts/lib/newsletter-ab-data.mjs and
 * scripts/report-send-hour-impact.mjs) and they drifted: one named the fields
 * of the query that actually failed, the other hardcoded `campaign_id` into
 * the message no matter which query threw. That sent the reader looking for a
 * single-field index that already existed while the real gap was a composite
 * one on different fields, and the newsletter A/B report stayed dead for weeks
 * behind a message that described the wrong query. One definition makes that
 * particular drift impossible.
 */

export class MissingIndexError extends Error {
  /**
   * @param {string} group   collectionGroup the query ran against
   * @param {string} fields  fields of the FAILING query, e.g. 'campaign_id' or
   *                         'event_type + timestamp' — never those of some
   *                         other query on the same group
   * @param {Error}  original the Firestore error, which carries the console
   *                         link that creates the index
   */
  constructor(group, fields, original) {
    super(`Missing Firestore collectionGroup index for "${group}.${fields}"`);
    this.name = 'MissingIndexError';
    this.group = group;
    this.fields = fields;
    this.original = original;
  }
}
