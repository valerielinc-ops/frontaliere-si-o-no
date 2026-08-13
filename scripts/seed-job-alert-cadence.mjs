#!/usr/bin/env node
/**
 * seed-job-alert-cadence.mjs — give every job-alert recipient a starting
 * cadence tier, read off the engagement history the ESP webhooks already wrote
 * (issue #5705 §10, modelled on scripts/seed-daily-brief-tiers.mjs).
 *
 * WHY SEED AT ALL. Without a stored tier the engine falls back to a live read
 * of the classifier on every run, which is correct but re-decides the tier from
 * a 14-day lookback every night: nobody's demotion streak can ever accumulate,
 * because the state it accumulates in does not exist yet. Seeding writes the
 * current answer down once, and from then on promotion and demotion move it.
 *
 * IT MOVES NOBODY UP. Every tier on the new scale is at least as slow as what
 * the same recipient receives today, and the ceiling
 * (JOB_ALERT_CADENCE_CEILING_DAYS) holds all of them at 7 days regardless. This
 * script cannot increase anybody's volume; if a dry-run says it does, something
 * is inverted and the run must not be repeated with writes.
 *
 * IT IS NOT A CONSENT RECORD. These fields say how often we will mail somebody,
 * not that they asked to be mailed. 6.306 of the 6.835 active digest alerts were
 * created by a backfill from the newsletter list (#5705); slowing them down
 * leaves that question exactly where it was.
 *
 * IDEMPOTENT. Only writes root documents with no `ja_cadence_tier` yet, so a
 * rerun after a partial run finishes the job and a rerun after a full one is a
 * no-op. A tier the engine has since moved is never overwritten.
 *
 * Usage:
 *   node scripts/seed-job-alert-cadence.mjs --dry-run   # distribution + volume only
 *   node scripts/seed-job-alert-cadence.mjs             # write
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJobAlertExcluded } from '../services/emailSuppression.mjs';
import {
  JOB_ALERT_CADENCE_CEILING_DAYS,
  estimateDailyVolume,
  isBackfilledAlert,
  isDecayed,
  isManuallyPinned,
  resolveJobAlertCadence,
  seedJobAlertTier,
} from './lib/jobAlertCadence.mjs';
import { JOB_ALERT_CLICK_EVIDENCE, jobAlertClickEvidence } from './lib/jobAlertEngagementTier.mjs';
import { isImmediateCompanyAlert } from './lib/company-alert-routing.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 400;
const LOOKUP_CHUNK_SIZE = 200;

async function getFirestoreAdmin() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    initializeApp({ credential: cert(JSON.parse(fs.readFileSync(credPath, 'utf-8'))) });
  }
  return getFirestore();
}

/**
 * The seed decision for a set of recipients. Pure, so the distribution and the
 * volume a dry-run prints are exactly the ones a real run writes.
 *
 * @param {Array<{email: string, doc: object, alerts: Array<object>, clickEvents?: Array<object>|null}>} rows
 * @param {number} nowMs
 * @param {object} [options]
 * @param {number|null} [options.ceilingDays]
 */
export function planSeed(rows, nowMs, { ceilingDays = JOB_ALERT_CADENCE_CEILING_DAYS } = {}) {
  const writes = [];
  const skipped = { alreadySeeded: 0, excluded: 0, noEngineAlert: 0 };
  // Intervals actually served, per alert — the honest input to the volume
  // estimate, because the ceiling and the manual pins are per alert, not per
  // recipient.
  const intervalsBefore = {};
  const intervalsAfter = {};
  const byTier = {};
  let decayedAlerts = 0;
  let pinnedAlerts = 0;
  let backfilledAlerts = 0;

  for (const row of rows) {
    const doc = row.doc || {};
    const alerts = row.alerts || [];
    if (isJobAlertExcluded(doc.status)) { skipped.excluded++; continue; }

    const seed = seedJobAlertTier(doc, nowMs, { clickEvents: row.clickEvents ?? null });
    const engineAlerts = alerts.filter((a) => !isManuallyPinned(a) && !isDecayed(a));

    for (const alert of alerts) {
      if (isBackfilledAlert(alert)) backfilledAlerts++;
      if (isDecayed(alert)) { decayedAlerts++; continue; }
      if (isManuallyPinned(alert)) {
        pinnedAlerts++;
        const pinned = alert.frequency === 'daily' ? 1 : 7;
        intervalsBefore[pinned] = (intervalsBefore[pinned] || 0) + 1;
        intervalsAfter[pinned] = (intervalsAfter[pinned] || 0) + 1;
        continue;
      }
      // What today's gate serves: no gate on `daily` (one calendar day), 36h on
      // the open tier — which with a single daily cron lands on every other day
      // — and 7 days on `weekly`.
      const today = { daily: 1, 'every-other-day': 2, weekly: 7 }[seed.tier] ?? 7;
      intervalsBefore[today] = (intervalsBefore[today] || 0) + 1;
      const after = resolveJobAlertCadence(alert, doc, nowMs, { ceilingDays, clickEvents: row.clickEvents ?? null });
      intervalsAfter[after.intervalDays] = (intervalsAfter[after.intervalDays] || 0) + 1;
    }

    if (engineAlerts.length === 0) { skipped.noEngineAlert++; continue; }
    if (doc.ja_cadence_tier != null) { skipped.alreadySeeded++; continue; }

    const evidence = jobAlertClickEvidence(doc, { clickEvents: row.clickEvents ?? null });
    writes.push({
      email: row.email,
      tier: seed.tierDays,
      reason: seed.reason,
      lastHumanClickAtMs: evidence.kind === JOB_ALERT_CLICK_EVIDENCE.HUMAN ? evidence.atMs : null,
    });
    byTier[seed.tierDays] = (byTier[seed.tierDays] || 0) + 1;
  }

  return {
    writes,
    skipped,
    byTier,
    intervalsBefore,
    intervalsAfter,
    volumeBefore: estimateDailyVolume(intervalsBefore),
    volumeAfter: estimateDailyVolume(intervalsAfter),
    decayedAlerts,
    pinnedAlerts,
    backfilledAlerts,
  };
}

async function main() {
  const nowMs = Date.now();
  const db = await getFirestoreAdmin();
  console.log(`🌱 seeding job-alert cadence tiers — mode: ${DRY_RUN ? 'DRY RUN' : 'WRITE'}`);

  const snap = await db.collectionGroup('alerts').where('active', '==', true).get();
  const alertsByEmail = new Map();
  for (const doc of snap.docs) {
    if (doc.ref.parent.parent?.parent?.id !== 'job_alert_subscribers') continue;
    const data = doc.data() || {};
    if (data.paused === true) continue;
    // The immediate CompanyAlerts belong to scripts/send-company-alerts.mjs
    // (#5012 phase 2, shared predicate applied on both sides so the two senders
    // stay disjoint AND total). Seeding a cadence for a send that does not run
    // on this clock would put them in the volume estimate at the wrong pace.
    if (isImmediateCompanyAlert({ ...data, active: data.active !== false })) continue;
    const email = String(doc.ref.parent.parent?.id || data.email || '').toLowerCase();
    if (!email) continue;
    if (!alertsByEmail.has(email)) alertsByEmail.set(email, []);
    alertsByEmail.get(email).push({ id: doc.id, ...data });
  }
  console.log(`🔔 ${snap.size} active alert documents over ${alertsByEmail.size} recipients`);

  const emails = [...alertsByEmail.keys()];
  const rows = [];
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = emails.slice(i, i + LOOKUP_CHUNK_SIZE);
    const snaps = await db.getAll(...chunk.map((email) => db.collection('job_alert_subscribers').doc(email)));
    chunk.forEach((email, idx) => {
      rows.push({ email, doc: snaps[idx].exists ? (snaps[idx].data() || {}) : {}, alerts: alertsByEmail.get(email) });
    });
  }

  const plan = planSeed(rows, nowMs);
  console.log(`📊 seed distribution (days between sends): ${JSON.stringify(plan.byTier)}`);
  console.log(`   skipped: already seeded ${plan.skipped.alreadySeeded}, suppressed ${plan.skipped.excluded}, no engine-managed alert ${plan.skipped.noEngineAlert}`);
  console.log(`   alerts: ${plan.backfilledAlerts} from the newsletter backfill, ${plan.pinnedAlerts} manually pinned (exempt from the ceiling), ${plan.decayedAlerts} already decayed`);
  console.log(`   intervals served — before: ${JSON.stringify(plan.intervalsBefore)}`);
  console.log(`   intervals served — after:  ${JSON.stringify(plan.intervalsAfter)}  (ceiling ${JOB_ALERT_CADENCE_CEILING_DAYS}d)`);
  console.log(`   expected volume: ${plan.volumeBefore} → ${plan.volumeAfter} emails/day`);
  if (plan.volumeAfter > plan.volumeBefore) {
    console.log('   ⚠️  volume went UP. That is impossible by construction — do not run this with writes until it is explained.');
  }

  if (DRY_RUN) {
    console.log('✅ [dry-run] nothing written.');
    return;
  }

  const seededAt = new Date().toISOString();
  for (let i = 0; i < plan.writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const write of plan.writes.slice(i, i + BATCH_SIZE)) {
      batch.set(db.collection('job_alert_subscribers').doc(write.email), {
        ja_cadence_tier: write.tier,
        ja_cadence_sends_since_engagement: 0,
        ja_cadence_weekly_sends: 0,
        ja_cadence_tier_updated_at: seededAt,
        ja_cadence_seeded_at: seededAt,
        ...(write.lastHumanClickAtMs != null
          ? { ja_cadence_last_human_click_at: new Date(write.lastHumanClickAtMs).toISOString() }
          : {}),
      }, { merge: true });
    }
    await batch.commit();
    console.log(`   … ${Math.min(i + BATCH_SIZE, plan.writes.length)}/${plan.writes.length}`);
  }
  console.log(`✅ seeded ${plan.writes.length} recipients.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('❌ seed-job-alert-cadence.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main };
