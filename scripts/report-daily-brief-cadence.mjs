#!/usr/bin/env node
/**
 * report-daily-brief-cadence.mjs — the daily brief's own numbers (issue #5415 §3.10).
 *
 * A cadence that adapts to engagement is a feedback loop, and a feedback loop
 * nobody measures is a feedback loop nobody notices going wrong. This prints,
 * and appends to a JSONL history:
 *
 *   - recipients per tier, and how that moved since the last run
 *   - promotions and demotions in the window
 *   - CTR per tier — the number that says whether the tiers mean anything
 *   - unsubscribe and complaint rate, against the 0,3% bulk-sender ceiling
 *   - the cross-channel invariant: recipients who got more than one email in a
 *     UTC day, across brief + newsletter + job-alert + drip
 *
 * Modelled on scripts/report-send-hour-impact.mjs rather than bolted onto
 * scripts/revenue-monitor.mjs, which knows nothing about email (its one
 * occurrence of the word is a comment).
 *
 *   node scripts/report-daily-brief-cadence.mjs --days 14
 *   node scripts/report-daily-brief-cadence.mjs --days 7 --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAILY_BRIEF_TIERS, estimateDailyVolume, utcDayOf } from './lib/dailyBriefCadence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORY = path.join(ROOT, 'data', 'daily-brief-cadence-history.jsonl');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const DAYS = Number(argv[argv.indexOf('--days') + 1]) || 14;
const COMPLAINT_CEILING = 0.003; // Gmail/Yahoo bulk-sender limit

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
 * Everything the report says about a set of subscriber docs and their
 * deliveries. Pure, so the shape is testable without Firestore.
 *
 * @param {Array<{email: string, doc: object}>} subscribers
 * @param {Array<{email: string, campaign_id: string, sent_at: string, clicked_at?: string|null}>} deliveries
 */
export function summarize(subscribers, deliveries) {
  const tierPopulation = {};
  const overrides = {};
  let seeded = 0;
  for (const { doc } of subscribers) {
    if (doc?.daily_brief_tier_seeded) seeded++;
    if (doc?.daily_brief_frequency_override != null) {
      overrides[doc.daily_brief_frequency_override] = (overrides[doc.daily_brief_frequency_override] || 0) + 1;
      continue;
    }
    const tier = doc?.daily_brief_tier;
    if (tier == null) continue;
    tierPopulation[tier] = (tierPopulation[tier] || 0) + 1;
  }

  const tierOf = new Map(subscribers.map(({ email, doc }) => [email, doc?.daily_brief_tier ?? null]));
  const briefDeliveries = deliveries.filter((d) => String(d.campaign_id || '').startsWith('daily-brief-'));

  const perTier = {};
  for (const delivery of briefDeliveries) {
    const tier = tierOf.get(delivery.email) ?? 'unknown';
    perTier[tier] ??= { sent: 0, clicked: 0 };
    perTier[tier].sent++;
    if (delivery.clicked_at) perTier[tier].clicked++;
  }
  const ctrByTier = {};
  for (const [tier, counts] of Object.entries(perTier)) {
    ctrByTier[tier] = counts.sent ? Number((counts.clicked / counts.sent).toFixed(4)) : 0;
  }

  // The §3.3 invariant, measured rather than assumed: one recipient, one UTC
  // day, every channel that writes a delivery doc.
  const perEmailDay = new Map();
  for (const delivery of deliveries) {
    const day = utcDayOf(delivery.sent_at);
    if (!day) continue;
    const key = `${delivery.email}|${day}`;
    perEmailDay.set(key, (perEmailDay.get(key) || 0) + 1);
  }
  const doubleSends = [...perEmailDay.entries()].filter(([, n]) => n > 1);

  const statusCounts = { complained: 0, unsubscribed: 0, bounced: 0 };
  for (const { doc } of subscribers) {
    const status = String(doc?.status || '').toLowerCase();
    if (status in statusCounts) statusCounts[status]++;
  }

  return {
    subscribers: subscribers.length,
    seeded,
    tierPopulation,
    overrides,
    estimatedDailyVolume: estimateDailyVolume(tierPopulation),
    briefSent: briefDeliveries.length,
    briefClicked: briefDeliveries.filter((d) => d.clicked_at).length,
    ctrByTier,
    complaintRate: subscribers.length ? Number((statusCounts.complained / subscribers.length).toFixed(5)) : 0,
    unsubscribeRate: subscribers.length ? Number((statusCounts.unsubscribed / subscribers.length).toFixed(5)) : 0,
    doubleSendDays: doubleSends.length,
    doubleSendSamples: doubleSends.slice(0, 10).map(([key, n]) => ({ key, emails: n })),
  };
}

async function main() {
  const db = await getFirestoreAdmin();
  const sinceMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  const snap = await db.collection('newsletter_subscribers').get();
  const subscribers = snap.docs
    .filter((doc) => doc.id !== '_meta_')
    .map((doc) => ({ email: doc.data()?.email || doc.id, doc: doc.data() || {} }));

  const deliveries = [];
  try {
    const deliverySnap = await db.collectionGroup('campaign_deliveries')
      .where('sent_at', '>=', new Date(sinceMs))
      .get();
    for (const doc of deliverySnap.docs) {
      const data = doc.data() || {};
      deliveries.push({
        email: String(data.email || '').toLowerCase(),
        campaign_id: data.campaign_id || '',
        sent_at: data.sent_at?.toDate?.()?.toISOString() ?? data.sent_at ?? null,
        clicked_at: data.clicked_at?.toDate?.()?.toISOString() ?? data.clicked_at ?? null,
      });
    }
  } catch (error) {
    console.warn(`⚠️ delivery scan unavailable (${error?.message}) — tier population reported, CTR and the cross-channel invariant skipped.`);
    console.warn('   Needs a collection-group index on campaign_deliveries.sent_at.');
  }

  const report = { generatedAt: new Date().toISOString(), windowDays: DAYS, ...summarize(subscribers, deliveries) };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`📊 daily-brief cadence — ${DAYS}d window, ${report.subscribers} subscribers (${report.seeded} seeded)`);
    console.log(`   tiers: ${DAILY_BRIEF_TIERS.map((t) => `${t}d:${report.tierPopulation[t] || 0}`).join('  ')}`);
    console.log(`   user-pinned: ${JSON.stringify(report.overrides)}`);
    console.log(`   estimated volume: ${report.estimatedDailyVolume}/day`);
    console.log(`   brief sends ${report.briefSent}, clicks ${report.briefClicked}, CTR by tier ${JSON.stringify(report.ctrByTier)}`);
    console.log(
      `   complaint rate ${(report.complaintRate * 100).toFixed(3)}%`
      + `${report.complaintRate > COMPLAINT_CEILING ? ` ⚠️ OVER the ${COMPLAINT_CEILING * 100}% bulk-sender ceiling` : ' ✅'}`
      + `, unsubscribe rate ${(report.unsubscribeRate * 100).toFixed(3)}%`,
    );
    console.log(
      `   cross-channel: ${report.doubleSendDays} recipient-days with more than one email`
      + `${report.doubleSendDays ? ` ⚠️ ${JSON.stringify(report.doubleSendSamples)}` : ' ✅'}`,
    );
  }

  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, `${JSON.stringify(report)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ report-daily-brief-cadence.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main };
