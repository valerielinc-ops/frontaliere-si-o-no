#!/usr/bin/env node

/**
 * newsletter-ab-report.mjs — Subject-line A/B + per-segment open-rate report.
 *
 * Answers two goals:
 *  1. "which subject-line variant wins the open rate, broken down by sending
 *     provider?" Cross-tabulates open rate by (provider × variant) for a
 *     weekly campaign and flags the per-provider winner with a significance note.
 *  2. (#4299) "did each content segment perform, and did any segment's
 *     unsubscribe rate for this send blow past a sane cap?" Breaks
 *     open/click/unsubscribe down by the `segment` stamped on every
 *     campaign_deliveries doc (scripts/lib/newsletter-segments.mjs's
 *     resolveSegment/describeSegment, e.g. "hot_jobs" / "dormant") and flags
 *     any segment whose unsubscribe rate for THIS send crossed
 *     UNSUB_RATE_CAP_PCT (scripts/lib/newsletter-ab-data.mjs).
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
 *  - UNSUBSCRIBES have no campaign_id (the unsubscribe endpoint isn't part of
 *    the send path) so they're attributed to this campaign by time window:
 *    an unsubscribe from one of this campaign's recipients, within a few days
 *    of this campaign's sends — see loadCampaignSegmentReport's doc comment.
 *
 * Usage:
 *   node scripts/newsletter-ab-report.mjs                       # latest weekly campaign
 *   node scripts/newsletter-ab-report.mjs --campaign weekly_2026-06-16
 *   node scripts/newsletter-ab-report.mjs --json               # machine-readable
 *   node scripts/newsletter-ab-report.mjs --fail-on-breach      # exit 3 on unsub-guard breach
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT.
 * Read-only — never writes to Firestore.
 */

import { listVariantIds } from '../services/newsletter-subject-variants.mjs';
import { twoProportionTest } from '../services/newsletter-ab-stats.mjs';
import {
  loadCampaignVariantTotals,
  loadCampaignSegmentReport,
  unsubscribeGuardBreaches,
  UNSUB_RATE_CAP_PCT,
  MissingIndexError,
} from './lib/newsletter-ab-data.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
// Nonzero exit when a segment breaches the unsubscribe-rate guard — opt-in so
// this script stays a pure report by default; a future CI/monitor wiring can
// pass this to alert on it.
const FAIL_ON_BREACH = args.includes('--fail-on-breach');
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

  // ── Per-segment report (#4299 acceptance criterion) ──
  // Segment (engagement level x inferred interest, e.g. "hot_jobs") is stamped
  // on every campaign_deliveries doc by send-newsletter.mjs. Breaks
  // open/click/unsubscribe down per segment and flags any segment whose
  // unsubscribe rate for THIS send breached the +5% guard.
  // A failure here used to abort the whole run, so an unrelated gap in the
  // segment queries took the A/B table — the report's actual subject — down
  // with it. The A/B numbers above are already computed and are worth printing
  // on their own, so the segment half degrades instead of aborting.
  let segmentReport = null;
  let breaches = [];
  let segmentError = null;
  try {
    segmentReport = await loadCampaignSegmentReport(db, campaignId);
    breaches = unsubscribeGuardBreaches(segmentReport);
    report.segments = segmentReport.bySegment;
    report.unsubscribeGuard = { capPct: UNSUB_RATE_CAP_PCT, overallRate: segmentReport.overallUnsubscribeRate, breaches };
    // A consumer reading rates without knowing the window is still open will
    // conclude the newest campaign is the healthiest, every time.
    report.window = { closed: segmentReport.windowClosed, daysRemaining: segmentReport.windowDaysRemaining };
  } catch (e) {
    segmentError = e;
    report.segments = null;
    report.unsubscribeGuard = { capPct: UNSUB_RATE_CAP_PCT, overallRate: null, breaches: null, error: e?.message || String(e) };
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    // Unknown ≠ clean: with the guard unevaluated there is nothing to certify,
    // so --fail-on-breach must not exit 0 just because `breaches` is empty.
    if (segmentError && FAIL_ON_BREACH) process.exit(4);
    if (breaches.length && FAIL_ON_BREACH) process.exit(3);
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

  // ── Per-segment section ──
  if (segmentError) {
    console.log('⚠️  Per-segment breakdown and unsubscribe guard unavailable:');
    console.log(`    ${segmentError.message}`);
    if (segmentError instanceof MissingIndexError && segmentError.original?.message) {
      console.log(`    ${segmentError.original.message}`);
    }
    console.log('    The A/B table above is complete and unaffected.\n');
    if (FAIL_ON_BREACH) process.exit(4);
    return;
  }

  const segments = Object.keys(segmentReport.bySegment).sort();
  console.log(`Per-segment (open/click/unsubscribe) — campaign ${campaignId}:`);
  if (!segmentReport.windowClosed) {
    // Without this line the newest campaign always reads as an improvement:
    // its unsubscribes have not happened yet. Sends are spread over days by
    // the per-subscriber send hour, so the window can still be open a week
    // after the campaign date.
    console.log(
      `    ⚠️  Attribution window still OPEN (${segmentReport.windowDaysRemaining} more day(s)):`
      + ' unsubscribe rates below are partial and can only go up. Not comparable with a closed campaign.',
    );
  }
  if (segments.length === 0) {
    console.log('    (no segment-tagged sends for this campaign)');
  }
  for (const seg of segments) {
    const c = segmentReport.bySegment[seg];
    console.log(
      `    ${seg.padEnd(16)} sends=${String(c.sends).padStart(5)}  opens=${String(c.opens).padStart(5)} (${c.openRate.toFixed(1)}%)`
      + `  clicks=${String(c.clicks).padStart(4)} (${c.clickRate.toFixed(1)}%)`
      + `  unsub=${String(c.unsubscribes).padStart(3)} (${c.unsubscribeRate.toFixed(2)}%)`,
    );
  }
  console.log(`    ${'TOTAL'.padEnd(16)} sends=${String(segmentReport.totalSends).padStart(5)}  unsubscribe-rate=${segmentReport.overallUnsubscribeRate.toFixed(2)}% (guard cap ${UNSUB_RATE_CAP_PCT}%)`);
  if (breaches.length) {
    console.log(`\n🚨 UNSUBSCRIBE GUARD BREACH (cap ${UNSUB_RATE_CAP_PCT}%)`
      + (segmentReport.windowClosed ? ':' : ' — and the window is still open, so this is a floor:'));
    for (const b of breaches) {
      console.log(`    ${b.scope}: ${b.rate.toFixed(2)}% (${b.unsubscribes}/${b.sends} sends)`);
    }
  } else {
    console.log(`\n✅ Unsubscribe guard: no breach (cap ${UNSUB_RATE_CAP_PCT}%).`);
  }
  console.log('');
  if (breaches.length && FAIL_ON_BREACH) process.exit(3);
}

main().catch((e) => {
  console.error('❌ Report failed:', e?.message || e);
  process.exit(1);
});
