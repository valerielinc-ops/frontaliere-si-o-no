#!/usr/bin/env node
/**
 * Job-alert inactivity sunset runner (issue #2852 item 1).
 *
 * List hygiene for never-engaging job-alert subscribers — see the classifier
 * in scripts/lib/jobAlertSunset.mjs for the policy and rationale. Two
 * transitions, each computed purely then applied in batched writes:
 *
 *   sunset     → status = 'inactive' (soft, excluded from job-alert sends,
 *                reversible on the next open/click)
 *   reactivate → an 'inactive' subscriber who has since engaged → 'active'
 *   reprobe    → an 'inactive' subscriber silent long enough that reactivate's
 *                engagement evidence can never arrive → one-time, capped
 *                return to 'active' so a real send can produce it (#5559)
 *
 * `inactive` here lives on `job_alert_subscribers/{email}.status` and is
 * honored by scripts/send-job-alerts.mjs via
 * services/emailSuppression.mjs's `isJobAlertExcluded()`. It is a
 * job-alert-CHANNEL soft state — separate from the per-alert `active:false`
 * opt-out and from the cross-channel hard-suppression list (#2831).
 *
 * No win-back email stage (unlike scripts/newsletter-sunset.mjs): see
 * scripts/lib/jobAlertSunset.mjs's header comment for why that is
 * intentionally out of scope for this classifier.
 *
 * Usage:
 *   node scripts/job-alert-sunset.mjs            # DRY-RUN (no writes)
 *   node scripts/job-alert-sunset.mjs --apply    # apply status transitions
 *
 * Requires Firebase application-default credentials (CI runs load-rc-env first).
 */
import { classifyJobAlertSunset } from './lib/jobAlertSunset.mjs';
import { recipientsWithAllAlertsDecayed } from './lib/jobAlertCadence.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';

const APPLY = process.argv.includes('--apply');

let db;

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
}

async function main() {
  await initFirebase();
  const { FieldValue } = await import('firebase-admin/firestore');
  const now = Date.now();

  // Whose every alert the cadence engine has already retired (#5705 §5.4). The
  // re-probe below and the decay disagree — one says "mail them once more and
  // see", the other says "we stopped, and only they can restart us" — and on a
  // channel nobody asked for the quieter one wins. Same collectionGroup query
  // send-job-alerts.mjs runs nightly, so the index is the one already deployed.
  //
  // FAILS CLOSED: if the query cannot run we suppress every re-probe rather
  // than risk one landing on somebody we decided to stop mailing. A sunset run
  // that re-probes nobody today costs a day; the other error costs an email to
  // exactly the person this whole mechanism exists to leave alone.
  let allAlertsDecayed = null; // null = unknown → treat everybody as decayed
  try {
    const alertsSnap = await db.collectionGroup('alerts').where('active', '==', true).get();
    allAlertsDecayed = recipientsWithAllAlertsDecayed(
      alertsSnap.docs
        .filter((doc) => doc.ref.parent.parent?.parent?.id === 'job_alert_subscribers')
        .map((doc) => ({ email: doc.ref.parent.parent?.id || doc.data()?.email, ...doc.data() })),
    );
    console.log(`   🪦 cadence-decayed recipients (all alerts): ${allAlertsDecayed.size}`);
  } catch (err) {
    console.warn(`   ⚠️  could not read the cadence state (${err?.message || err}) — suppressing every re-probe this run`);
  }
  const cadenceDecayedFor = (email) => (allAlertsDecayed == null ? true : allAlertsDecayed.has(String(email).toLowerCase()));

  const snap = await db.collection('job_alert_subscribers').get();
  const sunset = [];
  const reactivate = [];
  const reprobe = [];

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const { action } = classifyJobAlertSunset(data, now, {
      cadenceDecayed: cadenceDecayedFor(data.email || doc.id),
    });
    if (action === 'sunset') sunset.push({ ref: doc.ref, email: data.email || doc.id });
    else if (action === 'reactivate') reactivate.push({ ref: doc.ref, email: data.email || doc.id });
    else if (action === 'reprobe') reprobe.push({ ref: doc.ref, email: data.email || doc.id });
  });

  console.log(`📊 Job-alert sunset scan: ${snap.size} subscribers`);
  console.log(`   to sunset     : ${sunset.length}`);
  console.log(`   to reactivate : ${reactivate.length}`);
  console.log(`   to re-probe   : ${reprobe.length}`);

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes. Re-run with --apply to apply status transitions.');
    for (const s of sunset.slice(0, 10)) console.log(`   [sunset]     ${s.email}`);
    for (const r of reactivate.slice(0, 10)) console.log(`   [reactivate] ${r.email}`);
    for (const p of reprobe.slice(0, 10)) console.log(`   [reprobe]    ${p.email}`);
    return;
  }

  // Reactivate first — cheapest, and frees mistakenly-silent users immediately.
  if (reactivate.length) {
    await commitInChunks(db, reactivate, (batch, it) => {
      batch.set(it.ref, {
        status: 'active',
        reactivated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    console.log(`✅ Reactivated ${reactivate.length}`);
  }

  // Re-probe: one-time, capped return to mailable for subscribers who've been
  // inactive too long for `reactivate`'s engagement evidence to ever arrive
  // (#5559) — job alerts have no accidental exit at all (no sender writes to
  // this collection while inactive), so this is the ONLY way out. Deliberately
  // NOT the bare reprobe_count/reprobed_at names — scripts/suppression-decay.mjs
  // already owns those on this same collection for its own unrelated recovery
  // mechanism; sharing the name would let one mechanism's counter exhaust the
  // other's budget.
  if (reprobe.length) {
    await commitInChunks(db, reprobe, (batch, it) => {
      batch.set(it.ref, {
        status: 'active',
        sunset_reprobed_at: FieldValue.serverTimestamp(),
        sunset_reprobe_count: FieldValue.increment(1),
        inactive_at: FieldValue.delete(),
      }, { merge: true });
    });
    console.log(`🔁 Re-probed ${reprobe.length}`);
  }

  if (sunset.length) {
    await commitInChunks(db, sunset, (batch, it) => {
      batch.set(it.ref, { status: 'inactive', inactive_at: FieldValue.serverTimestamp() }, { merge: true });
    });
    console.log(`🌙 Sunset (→ inactive) ${sunset.length}`);
  }
}

main().catch((err) => {
  console.error('[job-alert-sunset] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
