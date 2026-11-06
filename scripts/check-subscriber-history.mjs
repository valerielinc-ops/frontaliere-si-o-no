#!/usr/bin/env node
/**
 * Read-only Firestore inspector: prints the jobalert + newsletter send
 * history for a single email address. Never writes to Firestore.
 *
 * Environment variables:
 *   GOOGLE_APPLICATION_CREDENTIALS — Firebase service account for Firestore
 *   CHECK_EMAIL                    — address to inspect (required)
 *
 * Usage:
 *   CHECK_EMAIL=someone@example.com node scripts/check-subscriber-history.mjs
 */

import fs from 'node:fs';

function fmtTs(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts === 'number') return new Date(ts).toISOString();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

async function getFirestoreAdmin() {
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
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
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  return getFirestore();
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

async function main() {
  const email = (process.env.CHECK_EMAIL || '').trim().toLowerCase();
  if (!email) {
    console.error('CHECK_EMAIL env var is required');
    process.exit(1);
  }

  const db = await getFirestoreAdmin();

  console.log(`# Subscriber history — ${email}`);

  // ── job_alert_subscribers/{email} ──
  section('job_alert_subscribers (root doc)');
  const jaRootSnap = await db.collection('job_alert_subscribers').doc(email).get();
  if (!jaRootSnap.exists) {
    console.log('(no document)');
  } else {
    const d = jaRootSnap.data() || {};
    console.log(JSON.stringify({
      status: d.status ?? null,
      last_sent_at: fmtTs(d.last_sent_at),
      delivered_count: d.delivered_count ?? null,
      last_delivered_at: fmtTs(d.last_delivered_at),
      open_count: d.open_count ?? null,
      last_open_at: fmtTs(d.last_open_at),
      click_count: d.click_count ?? null,
      last_click_at: fmtTs(d.last_click_at),
      bounce_count: d.bounce_count ?? null,
    }, null, 2));
  }

  // ── job_alert_subscribers/{email}/alerts/* ──
  section('job_alert_subscribers/{email}/alerts');
  const alertsSnap = await db.collection('job_alert_subscribers').doc(email).collection('alerts').get();
  if (alertsSnap.empty) {
    console.log('(no alerts)');
  } else {
    alertsSnap.forEach((doc) => {
      const d = doc.data() || {};
      const sentJobIds = d.sentJobIds || {};
      const sentTimestamps = Object.values(sentJobIds)
        .map((v) => (typeof v === 'number' ? v : (v?.toMillis ? v.toMillis() : null)))
        .filter(Boolean)
        .sort((a, b) => b - a);
      console.log(`\nalert ${doc.id}:`);
      console.log(JSON.stringify({
        active: d.active ?? null,
        frequency: d.frequency ?? null,
        createdAt: fmtTs(d.createdAt),
        lastMatchedAt: fmtTs(d.lastMatchedAt),
        matchCount: d.matchCount ?? null,
        sentJobsTracked: Object.keys(sentJobIds).length,
        mostRecentSentJobAt: sentTimestamps[0] ? new Date(sentTimestamps[0]).toISOString() : null,
        allSentJobTimestamps: sentTimestamps.map((t) => new Date(t).toISOString()),
      }, null, 2));
    });
  }

  // ── job_alert_subscribers/{email}/events (delivered) ──
  section('job_alert_subscribers/{email}/events (delivery log)');
  try {
    const eventsSnap = await db.collection('job_alert_subscribers').doc(email)
      .collection('events').orderBy('timestamp', 'desc').limit(100).get();
    if (eventsSnap.empty) {
      console.log('(no events)');
    } else {
      const rows = eventsSnap.docs.map((doc) => {
        const d = doc.data() || {};
        return { event_type: d.event_type ?? null, occurred_at: d.occurred_at ?? fmtTs(d.timestamp), provider: d.provider ?? null };
      });
      console.log(JSON.stringify(rows, null, 2));
      const delivered = rows.filter((r) => r.event_type === 'delivered' || r.event_type === 'delivery');
      console.log(`\nDelivered event count (last 100 events window): ${delivered.length}`);
    }
  } catch (e) {
    console.log(`(events query failed: ${e?.message || e})`);
  }

  // ── newsletter_subscribers/{email} ──
  section('newsletter_subscribers (root doc)');
  const nlRootSnap = await db.collection('newsletter_subscribers').doc(email).get();
  if (!nlRootSnap.exists) {
    console.log('(no document)');
  } else {
    const d = nlRootSnap.data() || {};
    console.log(JSON.stringify({
      status: d.status ?? null,
      isActive: d.isActive ?? null,
      last_sent_at: fmtTs(d.last_sent_at),
      send_count: d.send_count ?? null,
      last_open_at: fmtTs(d.last_open_at),
      open_count: d.open_count ?? null,
      last_click_at: fmtTs(d.last_click_at),
      click_count: d.click_count ?? null,
    }, null, 2));
  }

  // ── newsletter_subscribers/{email}/campaign_deliveries ──
  section('newsletter_subscribers/{email}/campaign_deliveries');
  const deliveriesSnap = await db.collection('newsletter_subscribers').doc(email)
    .collection('campaign_deliveries').get();
  if (deliveriesSnap.empty) {
    console.log('(no deliveries)');
  } else {
    const rows = deliveriesSnap.docs
      .map((doc) => {
        const d = doc.data() || {};
        return { campaign_id: d.campaign_id ?? null, sent_at: fmtTs(d.sent_at), provider: d.provider ?? null };
      })
      .sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\nTotal newsletter deliveries: ${rows.length}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
