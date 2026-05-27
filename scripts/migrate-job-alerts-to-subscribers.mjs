#!/usr/bin/env node
/**
 * Migrate `job_alerts/{alertId}` → `job_alert_subscribers/{email}/alerts/{alertId}`.
 *
 * Mirrors the `newsletter_subscribers/{email}` pattern: one root doc per email
 * holding aggregate counters + `alerts` subcollection with the search configs
 * (also `alert_deliveries` and `events` subcollections, populated by the ESP
 * webhooks).
 *
 * The script is idempotent: re-running merges into existing subscriber docs
 * without overwriting counters already set by webhooks.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/migrate-job-alerts-to-subscribers.mjs [--dry-run] [--delete-source]
 *
 * Flags:
 *   --dry-run        Read + log only, no writes.
 *   --delete-source  After successful copy, delete the original `job_alerts/{alertId}`.
 *                    Off by default — keep the old collection as a safety net for
 *                    a few days, then re-run with this flag.
 */

import fs from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_SOURCE = process.argv.includes('--delete-source');

let _db = null;
async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (cred.project_id) {
      initializeApp({ credential: cert(cred) });
    } else {
      const { applicationDefault } = await import('firebase-admin/app');
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function main() {
  console.log('🔄 Migrating job_alerts → job_alert_subscribers/{email}/alerts/{alertId}');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${DELETE_SOURCE ? ' + DELETE SOURCE' : ''}`);

  const db = await getFirestoreAdmin();
  const { FieldValue } = await import('firebase-admin/firestore');

  const snap = await db.collection('job_alerts').get();
  console.log(`   Source docs: ${snap.size}`);
  if (snap.empty) {
    console.log('   Nothing to migrate.');
    return;
  }

  const subscribersTouched = new Set();
  const alertsByEmail = new Map();
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const email = normalizeEmail(data.email);
    if (!email || !email.includes('@')) {
      console.warn(`   ⚠️  Skipping ${doc.id}: missing/invalid email (${data.email})`);
      skipped++;
      continue;
    }
    if (!alertsByEmail.has(email)) alertsByEmail.set(email, []);
    alertsByEmail.get(email).push({ id: doc.id, data });
  }

  console.log(`   Distinct emails: ${alertsByEmail.size} (skipped ${skipped} invalid)`);

  let alertsCopied = 0;
  let parentDocsMerged = 0;

  for (const [email, alerts] of alertsByEmail.entries()) {
    const subscriberRef = db.collection('job_alert_subscribers').doc(email);
    const userIds = [...new Set(alerts.map((a) => a.data.userId).filter(Boolean))];
    const locales = [...new Set(alerts.map((a) => a.data.locale).filter(Boolean))];

    const parentPayload = {
      email,
      updated_at: FieldValue.serverTimestamp(),
      // Denormalized for collectionGroup security rules + queries.
      userId: userIds[0] || null,
      locale: locales[0] || 'it',
      // Only set on first creation — won't overwrite an existing webhook-created doc.
      created_at: FieldValue.serverTimestamp(),
    };

    if (DRY_RUN) {
      console.log(`   [dry] merge job_alert_subscribers/${email} (userId=${userIds[0] || '∅'}, alerts=${alerts.length})`);
    } else {
      // Merge: preserves any counters/engagement_score already written by ESP webhooks.
      // created_at uses serverTimestamp which Firestore replaces only if absent on merge:false,
      // but with merge:true it always writes — so we read first to avoid clobbering.
      const existing = await subscriberRef.get();
      if (existing.exists) {
        delete parentPayload.created_at;
      }
      await subscriberRef.set(parentPayload, { merge: true });
      parentDocsMerged++;
    }
    subscribersTouched.add(email);

    const batch = DRY_RUN ? null : db.batch();
    for (const { id, data } of alerts) {
      const alertRef = subscriberRef.collection('alerts').doc(id);
      const alertPayload = {
        // Denormalized fields needed for collectionGroup queries + rules.
        email,
        userId: data.userId || null,
        // Search config.
        keywords: data.keywords || [],
        locations: data.locations || [],
        contractTypes: data.contractTypes || [],
        sectors: data.sectors || [],
        frequency: data.frequency || 'daily',
        locale: data.locale || 'it',
        // State.
        active: data.active !== false,
        createdAt: data.createdAt || FieldValue.serverTimestamp(),
        lastMatchedAt: data.lastMatchedAt || null,
        matchCount: data.matchCount || 0,
        // Audit fields preserved if present.
        ...(data.unsubscribed_at ? { unsubscribed_at: data.unsubscribed_at } : {}),
        ...(data.unsubscribe_source ? { unsubscribe_source: data.unsubscribe_source } : {}),
        // Migration provenance.
        migrated_at: FieldValue.serverTimestamp(),
        migrated_from: `job_alerts/${id}`,
      };

      if (DRY_RUN) {
        console.log(`   [dry] write job_alert_subscribers/${email}/alerts/${id} (active=${alertPayload.active})`);
      } else {
        batch.set(alertRef, alertPayload, { merge: true });
      }
      alertsCopied++;
    }

    if (batch) await batch.commit();
  }

  console.log('');
  console.log(`   ✅ Subscribers touched : ${subscribersTouched.size}`);
  console.log(`   ✅ Parent docs merged   : ${parentDocsMerged}${DRY_RUN ? ' (dry)' : ''}`);
  console.log(`   ✅ Alerts copied        : ${alertsCopied}${DRY_RUN ? ' (dry)' : ''}`);

  if (DELETE_SOURCE && !DRY_RUN) {
    console.log('');
    console.log('🗑️  Deleting source docs in job_alerts/...');
    let deleted = 0;
    const batchSize = 400;
    let pending = db.batch();
    let pendingCount = 0;
    for (const doc of snap.docs) {
      const email = normalizeEmail(doc.data().email);
      if (!email || !email.includes('@')) continue;
      pending.delete(doc.ref);
      pendingCount++;
      deleted++;
      if (pendingCount >= batchSize) {
        await pending.commit();
        pending = db.batch();
        pendingCount = 0;
      }
    }
    if (pendingCount > 0) await pending.commit();
    console.log(`   🗑️  Deleted: ${deleted}`);
  } else if (DELETE_SOURCE && DRY_RUN) {
    console.log('   🔵 [dry] would delete source docs in job_alerts/');
  } else {
    console.log('');
    console.log('   ℹ️  Source collection job_alerts/ kept as backup.');
    console.log('       Re-run with --delete-source after verifying the new collection.');
  }

  console.log('\n🔄 Migration done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
