#!/usr/bin/env node

/**
 * newsletter-ab-report.mjs — Subject-line A/B open-rate report, per provider.
 *
 * Answers the goal: "which subject-line variant wins the open rate, broken down
 * by sending provider?" Cross-tabulates open rate by (provider × variant) for a
 * weekly campaign and flags the per-provider winner with a significance note.
 *
 * Design — immune to the per-provider webhook inconsistencies:
 *  - DENOMINATOR (sends) comes from the send-time `campaign_deliveries` docs,
 *    where `provider` is authoritative for every cascade provider.
 *  - VARIANT is RE-COMPUTED deterministically via assignSubjectVariant(email,
 *    campaignId) — so it never depends on what a given provider's webhook stored
 *    (only Resend reads tags.variant). The persisted `variant` is used only as a
 *    cross-check.
 *  - NUMERATOR (opens) is an OR of signals so no provider is under-counted:
 *      (a) `opened_at` on the send doc (Resend + any same-doc provider), plus
 *      (b) an 'open' event in the subscriber `events` subcollection for this
 *          campaign (matched by email or message_id) — every provider writes
 *          these, sidestepping the send-doc id divergence between providers.
 *
 * Usage:
 *   node scripts/newsletter-ab-report.mjs                       # latest weekly campaign
 *   node scripts/newsletter-ab-report.mjs --campaign weekly_2026-06-16
 *   node scripts/newsletter-ab-report.mjs --json               # machine-readable
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT.
 * Read-only — never writes to Firestore.
 */

import { assignSubjectVariant, listVariantIds } from '../services/newsletter-subject-variants.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Default campaign id = current week's Monday, matching send-newsletter.mjs. */
function currentWeeklyCampaignId() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  return `weekly_${monday.toISOString().slice(0, 10)}`;
}

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return a.firestore();
}

/** Standard normal CDF (Abramowitz–Stegun erf approximation). */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Two-proportion z-test (two-sided). Returns { z, pValue } or null if either
 * sample is empty.
 */
function twoProportionTest(a, b) {
  if (!a.sends || !b.sends) return null;
  const p1 = a.opens / a.sends;
  const p2 = b.opens / b.sends;
  const pPool = (a.opens + b.opens) / (a.sends + b.sends);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.sends + 1 / b.sends));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue };
}

const pct = (n, d) => (d > 0 ? (100 * n / d) : 0);

async function main() {
  const campaignId = argValue('--campaign') || currentWeeklyCampaignId();
  const variantIds = listVariantIds();
  if (!JSON_OUT) {
    console.log(`\n📊 Newsletter subject A/B report — campaign ${campaignId}`);
    console.log(`   Variants: ${variantIds.join(', ')}\n`);
  }

  const db = await initFirebase();

  // Both queries filter on `campaign_id` only (single-field collectionGroup
  // index) and refine in memory — avoids requiring a composite index. If the
  // single-field collectionGroup index is missing, Firestore returns a
  // FAILED_PRECONDITION with a one-click creation URL, surfaced below.
  const runQuery = async (group, label) => {
    try {
      return await db.collectionGroup(group).where('campaign_id', '==', campaignId).get();
    } catch (e) {
      if (String(e?.message || '').includes('index')) {
        console.error(`❌ Missing Firestore collectionGroup index for "${group}.campaign_id".`);
        console.error(`   Create it via the link in this error, then re-run:\n   ${e.message}`);
        process.exit(2);
      }
      throw e;
    }
  };

  // ── 1. Sends (denominator) + same-doc opens ──
  const sendSnap = await runQuery('campaign_deliveries', 'sends');

  // ── 2. Opens (numerator) from the events subcollection for this campaign ──
  // Every provider writes an 'open' event with provider + campaign_id, even when
  // its delivery-doc id diverges from the send doc.
  const openSnap = await runQuery('events', 'opens');

  const openedEmails = new Set();
  const openedMsgIds = new Set();
  for (const doc of openSnap.docs) {
    const d = doc.data();
    if (d.event_type !== 'open') continue; // refine in memory (no composite index)
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (email) openedEmails.add(email);
    if (d.message_id) openedMsgIds.add(String(d.message_id));
  }

  // cells[provider][variant] = { sends, opens }
  const cells = {};
  const ensure = (provider, variant) => {
    cells[provider] ??= {};
    cells[provider][variant] ??= { sends: 0, opens: 0 };
    return cells[provider][variant];
  };

  let totalSends = 0;
  let mismatchVariant = 0;
  for (const doc of sendSnap.docs) {
    const d = doc.data();
    if (!d.sent_at) continue; // only count real sends
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (!email) continue;
    const provider = d.provider || 'unknown';
    // Variant is recomputed (source of truth); cross-check against persisted.
    const variant = assignSubjectVariant(email, campaignId);
    if (d.variant && d.variant !== variant) mismatchVariant++;

    const cell = ensure(provider, variant);
    cell.sends++;
    const opened = !!d.opened_at || openedEmails.has(email) || (d.message_id && openedMsgIds.has(String(d.message_id)));
    if (opened) cell.opens++;
    totalSends++;
  }

  if (totalSends === 0) {
    console.log(`⚠️  No sends found for campaign "${campaignId}".`);
    console.log(`   Check the campaign id (--campaign weekly_YYYY-MM-DD) or that this run sent emails.`);
    process.exit(0);
  }

  // ── 3. Aggregate + winners ──
  const providers = Object.keys(cells).sort();
  const report = { campaignId, generatedAt: new Date().toISOString(), totalSends, providers: {}, byVariant: {} };

  // Per-variant totals across providers
  for (const v of variantIds) report.byVariant[v] = { sends: 0, opens: 0 };

  for (const provider of providers) {
    const variants = {};
    for (const v of variantIds) {
      const c = cells[provider]?.[v] || { sends: 0, opens: 0 };
      variants[v] = { sends: c.sends, opens: c.opens, openRate: pct(c.opens, c.sends) };
      report.byVariant[v].sends += c.sends;
      report.byVariant[v].opens += c.opens;
    }
    // Winner = highest open rate among variants with ≥1 send.
    let winner = null;
    for (const v of variantIds) {
      if (variants[v].sends > 0 && (!winner || variants[v].openRate > variants[winner].openRate)) winner = v;
    }
    let significance = null;
    if (variantIds.length === 2) {
      significance = twoProportionTest(
        { sends: variants[variantIds[0]].sends, opens: variants[variantIds[0]].opens },
        { sends: variants[variantIds[1]].sends, opens: variants[variantIds[1]].opens },
      );
    }
    report.providers[provider] = { variants, winner, significance };
  }

  for (const v of variantIds) report.byVariant[v].openRate = pct(report.byVariant[v].opens, report.byVariant[v].sends);

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── 4. Human-readable table ──
  for (const provider of providers) {
    const p = report.providers[provider];
    console.log(`▸ ${provider}`);
    for (const v of variantIds) {
      const cell = p.variants[v];
      const flag = p.winner === v && cell.sends > 0 ? '  ◀ winner' : '';
      console.log(`    ${v.padEnd(10)} sends=${String(cell.sends).padStart(5)}  opens=${String(cell.opens).padStart(5)}  open-rate=${cell.openRate.toFixed(1).padStart(5)}%${flag}`);
    }
    if (p.significance) {
      const sig = p.significance.pValue < 0.05 ? '✅ significant (p<0.05)' : `not yet significant (p=${p.significance.pValue.toFixed(2)})`;
      const minSends = Math.min(...variantIds.map(v => p.variants[v].sends));
      const note = minSends < 100 ? ' — small sample, keep collecting' : '';
      console.log(`    → ${sig}${note}`);
    }
    console.log('');
  }

  console.log('Σ by variant (all providers):');
  for (const v of variantIds) {
    const b = report.byVariant[v];
    console.log(`    ${v.padEnd(10)} sends=${String(b.sends).padStart(5)}  opens=${String(b.opens).padStart(5)}  open-rate=${b.openRate.toFixed(1).padStart(5)}%`);
  }
  if (mismatchVariant > 0) {
    console.log(`\n⚠️  ${mismatchVariant} send docs had a persisted variant ≠ recomputed (assignment logic changed since send; report uses recomputed).`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('❌ Report failed:', e?.message || e);
  process.exit(1);
});
