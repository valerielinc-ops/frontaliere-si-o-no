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

  const snap = await db.collection('job_alert_subscribers').get();
  const sunset = [];
  const reactivate = [];

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const { action } = classifyJobAlertSunset(data, now);
    if (action === 'sunset') sunset.push({ ref: doc.ref, email: data.email || doc.id });
    else if (action === 'reactivate') reactivate.push({ ref: doc.ref, email: data.email || doc.id });
  });

  console.log(`📊 Job-alert sunset scan: ${snap.size} subscribers`);
  console.log(`   to sunset     : ${sunset.length}`);
  console.log(`   to reactivate : ${reactivate.length}`);

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes. Re-run with --apply to apply status transitions.');
    for (const s of sunset.slice(0, 10)) console.log(`   [sunset]     ${s.email}`);
    for (const r of reactivate.slice(0, 10)) console.log(`   [reactivate] ${r.email}`);
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
