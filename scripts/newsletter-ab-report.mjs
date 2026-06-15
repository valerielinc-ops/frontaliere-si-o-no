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
 *  - VARIANT comes from the PERSISTED `variant` on the send doc (authoritative,
 *    written at send time for every provider), recomputed deterministically only
 *    as a legacy fallback. Persisted-first is required once auto-promotion biases
 *    the split (the variant is then no longer a pure function of email+campaign).
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

import { listVariantIds } from '../services/newsletter-subject-variants.mjs';
import { twoProportionTest } from '../services/newsletter-ab-stats.mjs';
import { loadCampaignVariantTotals, MissingIndexError } from './lib/newsletter-ab-data.mjs';

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
  // (getDay()+6)%7 = days since Monday — identical to send-newsletter.mjs. The
  // naive `getDate()-getDay()+1` resolves to NEXT Monday on Sundays, which would
  // pick a campaign id that was never sent → "No sends found" on Sunday runs.
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
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

const pct = (n, d) => (d > 0 ? (100 * n / d) : 0);

async function main() {
  const campaignId = argValue('--campaign') || currentWeeklyCampaignId();
  const variantIds = listVariantIds();
  if (!JSON_OUT) {
    console.log(`\n📊 Newsletter subject A/B report — campaign ${campaignId}`);
    console.log(`   Variants: ${variantIds.join(', ')}\n`);
  }

  const db = await initFirebase();

  // Shared loader (same logic the auto-promotion resolver uses). Open detection
  // ORs send-doc opened_at with per-campaign open events → immune to the
  // per-provider delivery-doc-id divergence.
  let cells;
  let totalSends;
  let mismatchVariant;
  try {
    ({ cells, totalSends, mismatchVariant } = await loadCampaignVariantTotals(db, campaignId));
  } catch (e) {
    if (e instanceof MissingIndexError) {
      console.error(`❌ ${e.message}.`);
      console.error(`   Create the single-field collectionGroup index via the link in this error, then re-run:\n   ${e.original?.message || ''}`);
      process.exit(2);
    }
    throw e;
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
