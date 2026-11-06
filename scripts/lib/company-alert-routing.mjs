/**
 * Which sender owns an alert (issue #5012 phase 2).
 *
 * CompanyAlert introduced a SECOND sender — scripts/send-company-alerts.mjs,
 * event-driven on new jobs — alongside the daily digest
 * scripts/send-job-alerts.mjs. Two senders reading the same
 * `job_alert_subscribers/{email}/alerts/*` collection need exactly one
 * partition rule, applied by both, or the two failure modes are:
 *
 *   - both claim an alert → the subscriber gets the same job twice, from two
 *     emails that look almost identical;
 *   - neither claims it → the alert silently never sends, with no error
 *     anywhere. That is the exact class of defect #5151 existed to kill.
 *
 * So the predicate lives here, once, and each sender applies it (the digest
 * applies its negation). Pure — no IO — so tests/company-alert.test.ts can
 * assert the partition is total and disjoint without Firestore.
 */

import { canonicalCompanyProfileSlug } from '../../build-plugins/shared/companyProfileSlug.mjs';

/**
 * The cadence value that routes an alert to the immediate sender.
 *
 * Exported so scripts/send-company-alerts.mjs can put it in the Firestore
 * query (`where('frequency','==',IMMEDIATE_FREQUENCY)`) without re-deriving
 * the rule — the partition stays owned by this file, whether it is applied in
 * memory or by the query planner.
 */
export const IMMEDIATE_FREQUENCY = 'immediate';

/**
 * Resolve the only company identity an immediate alert may use.
 *
 * This delegates to the same canonical slug used by the registration path and
 * by the matcher. An empty result is not a company called ""; it is an
 * unresolved identity and must be quarantined by the sender.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalCompanyAlertKey(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return canonicalCompanyProfileSlug(raw, raw);
}

/**
 * Explain why an immediate CompanyAlert cannot safely enter matching.
 *
 * The routing predicate intentionally still claims a truthy raw key so an
 * unresolved record is visible to the immediate sender. This second guard is
 * where it becomes an explicit quarantine instead of a silent drop or a
 * similarity match.
 *
 * @param {object|null|undefined} alert
 * @returns {string|null}
 */
export function companyAlertQuarantineReason(alert) {
  if (!isImmediateCompanyAlert(alert)) return null;
  return canonicalCompanyAlertKey(alert.specificCompanyKey)
    ? null
    : 'unresolved-canonical-company-key';
}

/**
 * True iff this alert belongs to the IMMEDIATE CompanyAlert sender.
 *
 * Requires BOTH the employer pin and the immediate cadence. The cadence half
 * matters for back-compat: a company-pinned alert created before phase 2
 * carries `frequency: 'daily'` and keeps riding the digest untouched — no
 * migration, no backfill, no silently-rerouted existing subscriber.
 *
 * @param {{ specificCompanyKey?: string|null, frequency?: string, paused?: boolean, active?: boolean }} alert
 * @returns {boolean}
 */
export function isImmediateCompanyAlert(alert) {
  if (!alert) return false;
  if (alert.active === false) return false;
  if (alert.paused === true) return false;
  if (!alert.specificCompanyKey) return false;
  return alert.frequency === IMMEDIATE_FREQUENCY;
}
