#!/usr/bin/env node
/**
 * seed-daily-brief-tiers.mjs — give every subscriber a starting cadence for the
 * daily brief, from the engagement history the provider webhooks already wrote
 * (issue #5415 §3.5).
 *
 * WHY SEED AT ALL. The alternative is "everyone daily, demote from there": for
 * the first week that sends ~7k emails a day to ~5k people who have not clicked
 * anything in a month. That is both the spam the cadence exists to prevent and
 * more than the cascade can carry (measured cap ~4.5k/day). Seeding from
 * history starts the channel at roughly 4k/day and lets it settle from there.
 *
 * THE RULE (scripts/lib/dailyBriefCadence.mjs `seedTier`, so the seed and the
 * running engine cannot disagree):
 *   HUMAN click within 30 days       → tier 1 (daily)
 *   opened within 30 days, no click  → tier 3
 *   only ever mailed via Cloudflare  → tier 3   (no webhook = no signal, not disengagement)
 *   nothing                          → tier 7 (weekly)
 *
 * "HUMAN click" is `classifyClickEvents` (#5674): an opt-out click, a scanner
 * address, an automation user-agent and a burst of targets in three seconds are
 * none of them a reader. Without a click history the classifier still sees the
 * one click the document remembers, `last_click_at` beside `last_clicked_url` —
 * which is the case that matters, since on 2026-08-12 that URL was the
 * unsubscribe link for 68 of the 433 recipients this seed had put on daily.
 * `main()` now hands the classifier that full history: `attachClickEvents()`
 * reads each subscriber's `events` subcollection before `planSeed` runs
 * (#5716 item 2), so an earlier HUMAN click behind a later synthetic one is
 * no longer invisible to the seed the way it was to the single-click fallback.
 *
 * IDEMPOTENT. Only writes subscribers that have no `daily_brief_tier` yet, so a
 * rerun after a partial run finishes the job and a rerun after a full one is a
 * no-op. A tier the engine has since moved, or a frequency the user has pinned,
 * is never overwritten.
 *
 * Usage:
 *   node scripts/seed-daily-brief-tiers.mjs --dry-run   # distribution only
 *   node scripts/seed-daily-brief-tiers.mjs             # write
 */

import fs from 'node:fs';
import { isNewsletterExcluded } from '../services/emailSuppression.mjs';
import { isNewsletterOptOutBinding } from '../services/newsletterOptOut.mjs';
import { estimateDailyVolume, seedTier } from './lib/dailyBriefCadence.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 400;
const EVENTS_CONCURRENCY = 20;
// classifyClickEvents' burst-window rule is O(n^2) in the events array length
// (scripts/lib/syntheticClicks.mjs) and was calibrated on the bounded windows
// the daily-brief sender reads, not a full retroactive history (#5716 item 2,
// reviewer guard on #5697). Above this many events for one subscriber, log
// instead of absorbing it silently, so a pathological history is visible in
// the run's own output rather than only in its wall time.
const EVENTS_LOG_THRESHOLD = 500;

/** Runs `fn` over `items` with at most `limit` in flight at once (same idiom
 * as scripts/report-send-hour-impact.mjs / scripts/suppression-decay.mjs). */
async function mapWithConcurrency(items, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Populate `row.clickEvents` from each subscriber's `events` subcollection —
 * the piece #5716 item 2 says was missing: `planSeed` already forwards
 * `row.clickEvents` to `seedTier`, and `seedTier` already classifies it via
 * `classifyClickEvents`, but nothing ever read the subcollection to fill it
 * in, so every seed ran on the single-click fallback (`last_click_at` +
 * `last_clicked_url`) — which cannot see an EARLIER human click behind a
 * later synthetic one (the opt-out-link case measured in seedTier's own
 * comment: 64 of 73 wrongly-daily recipients got there on one click of the
 * unsubscribe link).
 *
 * Per-subscriber subcollection read, bounded concurrency — not a single
 * `collectionGroup('events')` query — because grouping a collectionGroup
 * result back onto ~8.6k rows needs the same parent-chain filter
 * scripts/report-job-alert-engagement-tiers.mjs warns about ('events' is not
 * a name unique to `newsletter_subscribers`), and this file already holds
 * every row's own `doc.ref` from the initial read. Read-only: this function
 * never writes, so it runs the same whether `--dry-run` is set or not.
 *
 * @param {Array<{email: string, doc: object, ref?: FirebaseFirestore.DocumentReference, clickEvents?: object[]|null}>} rows
 */
export async function attachClickEvents(rows) {
  await mapWithConcurrency(rows, EVENTS_CONCURRENCY, async (row) => {
    if (!row.ref) { row.clickEvents = null; return; }
    const snap = await row.ref.collection('events').get();
    const events = snap.docs.map((d) => d.data() || {});
    if (events.length > EVENTS_LOG_THRESHOLD) {
      console.warn(`⚠️ [seed-daily-brief-tiers] ${row.email}: ${events.length} click events — classifyClickEvents' burst window is O(n^2), watch this run's wall time`);
    }
    row.clickEvents = events;
  });
  return rows;
}

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
 * The seed decision for a batch of subscriber docs. Pure, so the distribution
 * a dry-run prints is exactly the one a real run writes.
 * @returns {{ writes: Array<{email: string, tier: number, reason: string}>, skipped: object }}
 */
export function planSeed(rows, nowMs) {
  const writes = [];
  const skipped = { alreadySeeded: 0, pinned: 0, excluded: 0 };
  for (const row of rows) {
    const doc = row.doc || {};
    const status = String(doc.status || '').trim().toLowerCase();
    // isNewsletterExcluded already contains every status isAddressSuppressed
    // does, so the second call was dead. What was genuinely missing is the
    // stamp: a document that opted out through the SPA keeps `status:
    // 'confirmed'` on 458 production rows (#5673), and seeding it a cadence
    // tier is planning a send to someone who asked us to stop (#5688). Shared
    // predicate, so an explicit re-opt-in still gets seeded (#5711).
    if (isNewsletterExcluded(status) || isNewsletterOptOutBinding(doc)) { skipped.excluded++; continue; }
    if (doc.daily_brief_frequency_override != null) { skipped.pinned++; continue; }
    if (doc.daily_brief_tier != null) { skipped.alreadySeeded++; continue; }
    const { tierDays, reason } = seedTier(doc, nowMs, { clickEvents: row.clickEvents ?? null });
    writes.push({ email: row.email, tier: tierDays, reason });
  }
  return { writes, skipped };
}

async function main() {
  const nowMs = Date.now();
  const db = await getFirestoreAdmin();
  console.log(`🌱 seeding daily-brief tiers — mode: ${DRY_RUN ? 'DRY RUN' : 'WRITE'}`);

  const snap = await db.collection('newsletter_subscribers').get();
  const rows = snap.docs
    .filter((doc) => doc.id !== '_meta_')
    .map((doc) => ({ email: doc.data()?.email || doc.id, doc: doc.data() || {}, ref: doc.ref }));
  console.log(`👥 ${rows.length} subscriber documents read`);

  console.log('📥 reading click history (events subcollection, #5716 item 2)…');
  await attachClickEvents(rows);

  const { writes, skipped } = planSeed(rows, nowMs);
  const byTier = {};
  for (const write of writes) byTier[write.tier] = (byTier[write.tier] || 0) + 1;

  console.log(`📊 seed distribution: ${JSON.stringify(byTier)}`);
  console.log(`   skipped: already seeded ${skipped.alreadySeeded}, user-pinned ${skipped.pinned}, excluded/suppressed ${skipped.excluded}`);
  console.log(`   steady-state volume from this seed ≈ ${estimateDailyVolume(byTier)} emails/day`);

  if (DRY_RUN) {
    console.log('✅ [dry-run] nothing written.');
    return;
  }

  const seededAt = new Date().toISOString();
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + BATCH_SIZE)) {
      batch.set(db.collection('newsletter_subscribers').doc(write.email), {
        daily_brief_tier: write.tier,
        daily_brief_sends_since_engagement: 0,
        daily_brief_tier_updated_at: seededAt,
        daily_brief_tier_seeded: true,
      }, { merge: true });
    }
    await batch.commit();
    console.log(`   … ${Math.min(i + BATCH_SIZE, writes.length)}/${writes.length}`);
  }
  console.log(`✅ seeded ${writes.length} subscribers.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ seed-daily-brief-tiers.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main };
