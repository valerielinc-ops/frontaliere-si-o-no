#!/usr/bin/env node

/**
 * report-job-alert-engagement-tiers.mjs — READ-ONLY control/monitoring report
 * for the job-alert adaptive-frequency engine (owner design 2026-07-16, see
 * scripts/lib/jobAlertEngagementTier.mjs).
 *
 * Answers: "what cadence is each active job-alert actually getting right
 * now, and is the engine moving people between tiers?" Reads every active
 * `alerts/*` doc (collectionGroup, same query send-job-alerts.mjs uses) plus
 * its parent `job_alert_subscribers/{email}` doc, then:
 *   - splits alerts into manual-pinned (frequencyOverride:true) vs
 *     engine-managed, and reports the daily/36h/weekly distribution of the
 *     engine-managed ones using the SAME pure classifier the send pipeline
 *     uses (scripts/lib/jobAlertEngagementTier.mjs) — a live snapshot,
 *     independent of send-job-alerts.mjs's own daily cron cadence.
 *   - compares that live-computed tier against `last_engagement_tier`, the
 *     field send-job-alerts.mjs stamps on the subscriber's root doc every
 *     run: a REAL delta (movement between two production-written values),
 *     not a fabricated counter.
 *
 * Read-only: no Firestore writes. Exit code is always 0 (a report, not a CI
 * gate) — Firestore errors are logged and degrade the output, never fail
 * the process.
 *
 * Usage:
 *   node scripts/report-job-alert-engagement-tiers.mjs
 *   node scripts/report-job-alert-engagement-tiers.mjs --json
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT (optional).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEffectiveJobAlertTier, JOB_ALERT_ENGAGEMENT_TIERS } from './lib/jobAlertEngagementTier.mjs';

const LOOKUP_CHUNK_SIZE = 200; // emails per db.getAll() call — same batching as send-job-alerts.mjs

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { admin: a, db: a.firestore() };
}

/**
 * Load every active alert doc, restricted to the real job_alert_subscribers
 * subcollection (collectionGroup('alerts') also returns unrelated `alerts`
 * subcollections elsewhere in the project — same defensive filter
 * send-job-alerts.mjs applies).
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<Array<{id: string, email: string, frequency: string, frequencyOverride: boolean}>>}
 */
async function loadActiveAlerts(db) {
  const snap = await db.collectionGroup('alerts').where('active', '==', true).get();
  return snap.docs
    .filter((doc) => doc.ref.parent.parent?.parent?.id === 'job_alert_subscribers')
    .map((doc) => {
      const data = doc.data() || {};
      const email = String(doc.ref.parent.parent?.id || data.email || '').toLowerCase();
      return { id: doc.id, email, frequency: data.frequency || 'daily', frequencyOverride: data.frequencyOverride === true };
    })
    .filter((a) => a.email);
}

/**
 * Batch-load job_alert_subscribers root docs for the given emails.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} emails
 * @returns {Promise<Map<string, object>>}
 */
async function loadSubscriberProfiles(db, emails) {
  const profiles = new Map();
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = emails.slice(i, i + LOOKUP_CHUNK_SIZE);
    const refs = chunk.map((email) => db.collection('job_alert_subscribers').doc(email));
    const snaps = await db.getAll(...refs);
    chunk.forEach((email, idx) => {
      const snap = snaps[idx];
      if (snap.exists) profiles.set(email, snap.data() || {});
    });
  }
  return profiles;
}

export function emptyDistribution() {
  return {
    [JOB_ALERT_ENGAGEMENT_TIERS.DAILY]: 0,
    [JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H]: 0,
    [JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]: 0,
  };
}

/**
 * Core aggregation, kept pure/exported for tests — no Firestore, no Date.now().
 * @param {Array<{id: string, email: string, frequency: string, frequencyOverride: boolean}>} alerts
 * @param {Map<string, object>} subscriberProfiles
 * @param {number} nowMs
 */
export function aggregateEngagementTiers(alerts, subscriberProfiles, nowMs) {
  const manualByFrequency = { daily: 0, weekly: 0 };
  const engineDistribution = emptyDistribution();
  const delta = { improved: 0, regressed: 0, unchanged: 0, noPriorSnapshot: 0 };

  for (const alert of alerts) {
    const sub = subscriberProfiles.get(alert.email) || {};
    const verdict = resolveEffectiveJobAlertTier(alert, sub, nowMs);

    if (verdict.manual) {
      manualByFrequency[verdict.tier] = (manualByFrequency[verdict.tier] || 0) + 1;
      continue;
    }

    engineDistribution[verdict.tier]++;

    const priorTier = sub.last_engagement_tier;
    if (!priorTier) {
      delta.noPriorSnapshot++;
    } else if (priorTier === verdict.tier) {
      delta.unchanged++;
    } else {
      // Rank: daily is the "warmest"/most-frequent tier, weekly the coldest —
      // moving toward daily is an engagement improvement, the reverse a regression.
      const rank = { [JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]: 0, [JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H]: 1, [JOB_ALERT_ENGAGEMENT_TIERS.DAILY]: 2 };
      if ((rank[verdict.tier] ?? -1) > (rank[priorTier] ?? -1)) delta.improved++;
      else delta.regressed++;
    }
  }

  return { manualByFrequency, engineDistribution, delta, totalAlerts: alerts.length };
}

function formatReport(result) {
  const { manualByFrequency, engineDistribution, delta, totalAlerts } = result;
  const manualTotal = manualByFrequency.daily + manualByFrequency.weekly;
  const engineTotal = engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.DAILY]
    + engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H]
    + engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY];

  const lines = [];
  lines.push('📊 Job-alert adaptive-frequency engagement report');
  lines.push(`   Active alerts: ${totalAlerts}`);
  lines.push('');
  lines.push(`   Manual pin (frequencyOverride:true): ${manualTotal}`);
  lines.push(`     - daily:  ${manualByFrequency.daily}`);
  lines.push(`     - weekly: ${manualByFrequency.weekly}`);
  lines.push('');
  lines.push(`   Engine-managed: ${engineTotal}`);
  lines.push(`     - daily:  ${engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.DAILY]}`);
  lines.push(`     - 36h:    ${engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H]}`);
  lines.push(`     - weekly: ${engineDistribution[JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]}`);
  lines.push('');
  lines.push('   Cadence movement vs. last send-job-alerts.mjs run (last_engagement_tier):');
  lines.push(`     - improved (colder→warmer):  ${delta.improved}`);
  lines.push(`     - regressed (warmer→colder): ${delta.regressed}`);
  lines.push(`     - unchanged:                 ${delta.unchanged}`);
  lines.push(`     - no prior snapshot yet:     ${delta.noPriorSnapshot}`);
  return lines.join('\n');
}

function printHelp() {
  console.log(`
report-job-alert-engagement-tiers.mjs — READ-ONLY control/monitoring report
for the job-alert adaptive-frequency engine.

Usage:
  node scripts/report-job-alert-engagement-tiers.mjs
  node scripts/report-job-alert-engagement-tiers.mjs --json

Read-only: no Firestore writes. Exit code is always 0.
Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT (optional).
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const JSON_OUT = argv.includes('--json');

  const { db } = await initFirebase();
  const alerts = await loadActiveAlerts(db);

  if (alerts.length === 0) {
    if (JSON_OUT) console.log(JSON.stringify({ totalAlerts: 0 }, null, 2));
    else console.log('ℹ️  No active job alerts — nothing to report.');
    return;
  }

  const emails = [...new Set(alerts.map((a) => a.email))];
  const subscriberProfiles = await loadSubscriberProfiles(db, emails);
  const result = aggregateEngagementTiers(alerts, subscriberProfiles, Date.now());

  if (JSON_OUT) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
    return;
  }

  console.log(`\n${formatReport(result)}\n`);
}

// Run only when invoked directly; the pure aggregation function above stays
// importable for tests without triggering a live Firestore connection attempt.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    // Report, not a gate: log the failure but never fail the process.
    console.error('❌ Report failed to complete:', err?.message || err);
    process.exit(0);
  });
}
