#!/usr/bin/env node
/**
 * measure-optout-recovery-exposure.mjs — the metric for #5741, READ-ONLY.
 *
 * Counts the documents that carry a binding opt-out stamp AND that a recovery
 * predicate would still act on. It answers the one question the issue turns on:
 * how many people who asked us to stop are one `delivered`/`open`/`click` away
 * from being written back to `status: 'active'`.
 *
 * It computes BOTH verdicts on the same live document:
 *
 *   before — the pre-#5741 decision, which read `currentStatus` and nothing
 *            else. Re-implemented here rather than imported, because the point
 *            of the fix is that this code no longer exists;
 *   after  — the shipped `positiveEventStatusFields`, stamp included.
 *
 * Run it before and after the merge; `after` must be 0 and must stay 0.
 *
 *   node scripts/dev/measure-optout-recovery-exposure.mjs
 *
 * THIS SCRIPT NEVER WRITES. There is no `--apply`, no batch, no `set`/`update`
 * call anywhere in it, and there is deliberately no remediation mode: the
 * readers all accept both spellings of the stamp, so no data migration is
 * needed to close #5741 — only the predicate change this measures. Normalising
 * stamps or rewriting statuses on personal data is the owner's decision, not a
 * side effect of a measurement.
 */
import admin from 'firebase-admin';

import {
  positiveEventStatusFields,
  hasBindingOptOutStamp,
  isTerminalSuppression,
  MACHINE_INFERRED_SUPPRESSIONS,
} from '../../functions/src/lib/subscriberReactivation.js';

const COLLECTIONS = ['newsletter_subscribers', 'job_alert_subscribers'];
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * The decision as it stood before #5741: `status`, and nothing but `status`.
 * Returns the fields it WOULD have written on a positive event.
 */
function statusOnlyVerdict(status, bounceSeverity) {
  const s = norm(status);
  if (MACHINE_INFERRED_SUPPRESSIONS.has(s) && !isTerminalSuppression(s, bounceSeverity)) {
    return { status: 'active', isActive: true, recovered_from_status: s };
  }
  if (isTerminalSuppression(s, bounceSeverity)) return {};
  // The fall-through that made `pending`/`confirmed`/`active` documents
  // reachable too — the majority of the exposed population.
  return { status: 'active' };
}

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

const totals = { scanned: 0, stamped: 0, before: 0, after: 0, alreadyRecovered: 0, camelOnly: 0 };

for (const collection of COLLECTIONS) {
  const snap = await db.collection(collection).get();
  const per = { scanned: 0, stamped: 0, before: 0, after: 0, alreadyRecovered: 0, camelOnly: 0 };

  for (const doc of snap.docs) {
    if (doc.id === '_meta_') continue;
    const data = doc.data() || {};
    per.scanned++;

    // `.data()`, never the snapshot — see the guard in newsletterOptOut.mjs.
    if (!hasBindingOptOutStamp(data)) continue;
    per.stamped++;

    if (Object.keys(statusOnlyVerdict(data.status, data.bounce_severity)).length > 0) per.before++;
    if (Object.keys(positiveEventStatusFields({
      subscriber: data,
      currentStatus: data.status,
      bounceSeverity: data.bounce_severity,
      event: 'open',
    })).length > 0) per.after++;

    // Retro-exposure: a document already carrying the fabricated audit trail,
    // i.e. one this path had already reactivated before the fix landed.
    if (data.recovered_from_status != null) per.alreadyRecovered++;

    // The sub-population #5741 was originally filed on: the pre-#5673 SPA
    // documents, camelCase stamp only, whose `status` a later writer moved off
    // `unsubscribed`. Reported separately so the headline number reconciles
    // with the one in the issue instead of looking like drift.
    if (data.unsubscribedAt != null && data.unsubscribed_at == null
      && norm(data.status) !== 'unsubscribed') per.camelOnly++;
  }

  console.log(
    `${collection}: scanned=${per.scanned} withBindingOptOutStamp=${per.stamped} `
    + `contactableBefore=${per.before} contactableAfter=${per.after} `
    + `alreadyReactivatedByThisPath=${per.alreadyRecovered} `
    + `camelCaseOnlyStampWithOtherStatus=${per.camelOnly}`,
  );
  for (const k of Object.keys(totals)) totals[k] += per[k];
}

console.log(
  `TOTAL: scanned=${totals.scanned} withBindingOptOutStamp=${totals.stamped} `
  + `contactableBefore=${totals.before} contactableAfter=${totals.after} `
  + `alreadyReactivatedByThisPath=${totals.alreadyRecovered} `
  + `camelCaseOnlyStampWithOtherStatus=${totals.camelOnly}`,
);
console.log(totals.after === 0
  ? 'OK — no stamped document is reachable by a recovery predicate.'
  : `REGRESSION — ${totals.after} stamped documents are still reachable.`);

process.exit(0);
