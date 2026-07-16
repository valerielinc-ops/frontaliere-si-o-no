/**
 * newsletter-ab-data.mjs — shared Firestore loader for the subject A/B test.
 *
 * Single source of truth for turning a campaign's Firestore records into
 * per-(provider × variant) send/open totals. Used by BOTH the report
 * (scripts/newsletter-ab-report.mjs) and the send pipeline's auto-promotion
 * resolver, so the open-detection logic can't drift between them.
 *
 * Open detection ORs three signals (immune to the per-provider delivery-doc-id
 * divergence): `opened_at` on the send doc, plus a per-campaign `open` event
 * matched by email or message_id.
 *
 * The variant is taken from the PERSISTED `variant` field on the send doc
 * (authoritative — written at send time for every provider), falling back to a
 * deterministic recompute only for legacy docs predating persistence. Recompute
 * alone is NOT sufficient once auto-promotion biases the split, because the
 * assigned variant is then no longer a pure function of (email, campaignId).
 */

import { assignSubjectVariant } from '../../services/newsletter-subject-assign.mjs';
import { EXPERIMENT_EXCLUDED_PROVIDERS } from '../../functions/src/lib/emailExperimentPostHog.js';
import { buildDeliveryDocId } from '../../functions/src/lib/deliveryDocId.js';
import { toMillis } from './firestoreTimestamp.mjs';

/** Thrown when the single-field collectionGroup index is missing. */
export class MissingIndexError extends Error {
  constructor(group, original) {
    super(`Missing Firestore collectionGroup index for "${group}.campaign_id"`);
    this.name = 'MissingIndexError';
    this.group = group;
    this.original = original;
  }
}

/**
 * Load per-(provider × variant) totals for one campaign.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} campaignId
 * @returns {Promise<{cells:object, byVariant:object, totalSends:number, mismatchVariant:number}>}
 */
export async function loadCampaignVariantTotals(db, campaignId) {
  const runQuery = async (group) => {
    try {
      return await db.collectionGroup(group).where('campaign_id', '==', campaignId).get();
    } catch (e) {
      if (String(e?.message || '').includes('index')) throw new MissingIndexError(group, e);
      throw e;
    }
  };

  const sendSnap = await runQuery('campaign_deliveries');
  const openSnap = await runQuery('events');

  const openedEmails = new Set();
  const openedMsgIds = new Set();
  for (const doc of openSnap.docs) {
    const d = doc.data();
    if (d.event_type !== 'open') continue; // refine in memory (no composite index)
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (email) openedEmails.add(email);
    if (d.message_id) openedMsgIds.add(String(d.message_id));
  }

  const cells = {}; // cells[provider][variant] = { sends, opens }
  const byVariant = {}; // pooled across providers
  const ensure = (provider, variant) => {
    cells[provider] ??= {};
    cells[provider][variant] ??= { sends: 0, opens: 0 };
    byVariant[variant] ??= { sends: 0, opens: 0 };
    return cells[provider][variant];
  };

  let totalSends = 0;
  let mismatchVariant = 0;
  for (const doc of sendSnap.docs) {
    const d = doc.data();
    if (!d.sent_at) continue; // only count real sends
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (!email) continue;
    // Count ONLY the canonical send-path doc. Non-Resend webhooks write their
    // own delivery doc (single-underscore id) and stamp sent_at on the provider
    // 'send' event → without this filter every such subscriber is double-counted
    // (and the webhook doc has no variant → mis-attributed).
    if (doc.id !== buildDeliveryDocId(campaignId, email)) continue;
    const provider = d.provider || 'unknown';
    if (EXPERIMENT_EXCLUDED_PROVIDERS.has(provider)) continue; // e.g. mailtrap sandbox — untracked opens pollute the rate
    // Persisted variant is authoritative; recompute only as a legacy fallback.
    const variant = d.variant || assignSubjectVariant(email, campaignId);
    if (d.variant && d.variant !== assignSubjectVariant(email, campaignId)) mismatchVariant++;

    const cell = ensure(provider, variant);
    cell.sends++;
    byVariant[variant].sends++;
    const opened = !!d.opened_at || openedEmails.has(email) || (d.message_id && openedMsgIds.has(String(d.message_id)));
    if (opened) {
      cell.opens++;
      byVariant[variant].opens++;
    }
    totalSends++;
  }

  return { cells, byVariant, totalSends, mismatchVariant };
}

/**
 * The `weekly_YYYY-MM-DD` campaign ids for the `count` Mondays BEFORE the given
 * campaign (most recent first). Used to pool recent history for promotion.
 * @param {string} campaignId e.g. "weekly_2026-06-15"
 * @param {number} count
 * @returns {string[]}
 */
export function previousCampaignIds(campaignId, count) {
  const m = /^weekly_(\d{4})-(\d{2})-(\d{2})$/.exec(String(campaignId || ''));
  if (!m) return [];
  const base = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  const ids = [];
  for (let k = 1; k <= count; k++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - 7 * k);
    ids.push(`weekly_${d.toISOString().slice(0, 10)}`);
  }
  return ids;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Any single segment's unsubscribe rate for a send never exceeds this — #4299
 * acceptance criterion. Baseline sitewide unsubscribe rate is ~3% (203/6,582
 * subscribers, per the issue), so a 5% cap on a single send's cohort is
 * already a meaningful multiple of normal churn, not a hair-trigger.
 */
export const UNSUB_RATE_CAP_PCT = 5;

/** Segments below this many sends are too thin for a single unsubscribe to be a meaningful rate signal (avoids 1-send-1-unsub = 100% false alarms). */
export const MIN_SENDS_FOR_UNSUB_GUARD = 20;

/**
 * Turn already-fetched, already-normalized per-send records into a
 * per-segment open/click/unsubscribe report. Pure — no Firestore access —
 * so it is unit-testable without an emulator; loadCampaignSegmentReport
 * below is the thin Firestore-querying wrapper around it.
 *
 * @param {Array<{email:string, segment:?string, messageId:?string, openedAt:?number, clickedAt:?number}>} deliveries
 *   one entry per canonical send-doc for the campaign (already deduped)
 * @param {{openedEmails?:Set<string>, openedMsgIds?:Set<string>, clickedEmails?:Set<string>, clickedMsgIds?:Set<string>, unsubscribedEmails?:Set<string>}} signals
 *   cross-provider event fallbacks (mirrors the OR-of-signals open detection in loadCampaignVariantTotals)
 * @returns {{bySegment:object, totalSends:number, totalOpens:number, totalClicks:number, totalUnsubscribes:number, overallUnsubscribeRate:number}}
 */
export function aggregateSegmentReport(deliveries, signals = {}) {
  const {
    openedEmails = new Set(),
    openedMsgIds = new Set(),
    clickedEmails = new Set(),
    clickedMsgIds = new Set(),
    unsubscribedEmails = new Set(),
  } = signals;

  const bySegment = {};
  let totalSends = 0;
  let totalOpens = 0;
  let totalClicks = 0;
  let totalUnsubscribes = 0;

  for (const d of deliveries) {
    const segment = d.segment || 'unsegmented';
    bySegment[segment] ??= { sends: 0, opens: 0, clicks: 0, unsubscribes: 0 };
    const cell = bySegment[segment];
    cell.sends++;
    totalSends++;

    const opened = !!d.openedAt || openedEmails.has(d.email) || (d.messageId && openedMsgIds.has(d.messageId));
    if (opened) { cell.opens++; totalOpens++; }

    const clicked = !!d.clickedAt || clickedEmails.has(d.email) || (d.messageId && clickedMsgIds.has(d.messageId));
    if (clicked) { cell.clicks++; totalClicks++; }

    if (unsubscribedEmails.has(d.email)) { cell.unsubscribes++; totalUnsubscribes++; }
  }

  const pct = (n, d2) => (d2 > 0 ? (100 * n / d2) : 0);
  for (const cell of Object.values(bySegment)) {
    cell.openRate = pct(cell.opens, cell.sends);
    cell.clickRate = pct(cell.clicks, cell.sends);
    cell.unsubscribeRate = pct(cell.unsubscribes, cell.sends);
  }

  return {
    bySegment,
    totalSends,
    totalOpens,
    totalClicks,
    totalUnsubscribes,
    overallUnsubscribeRate: pct(totalUnsubscribes, totalSends),
  };
}

/**
 * Unsubscribe-rate guard (#4299 acceptance criterion: "unsubscribe rate never
 * exceeds +5% per send"). Flags the overall campaign and any individual
 * segment (once it has enough sends to be meaningful) whose unsubscribe rate
 * for THIS send crossed the cap.
 *
 * @param {ReturnType<typeof aggregateSegmentReport>} report
 * @param {number} capPct
 * @returns {Array<{scope:string, rate:number, sends:number, unsubscribes:number}>}
 */
export function unsubscribeGuardBreaches(report, capPct = UNSUB_RATE_CAP_PCT) {
  const breaches = [];
  if (report.totalSends > 0 && report.overallUnsubscribeRate > capPct) {
    breaches.push({ scope: 'overall', rate: report.overallUnsubscribeRate, sends: report.totalSends, unsubscribes: report.totalUnsubscribes });
  }
  for (const [segment, cell] of Object.entries(report.bySegment)) {
    if (cell.sends >= MIN_SENDS_FOR_UNSUB_GUARD && cell.unsubscribeRate > capPct) {
      breaches.push({ scope: segment, rate: cell.unsubscribeRate, sends: cell.sends, unsubscribes: cell.unsubscribes });
    }
  }
  return breaches;
}

/**
 * Firestore-facing wrapper: fetch one campaign's sends + open/click/unsubscribe
 * events and produce the per-segment report. Unsubscribe events don't carry a
 * campaign_id (services/../functions/src/newsletterSubscriptionManagement.js
 * writes them from the standalone unsubscribe endpoint, not the send path), so
 * attribution is by time window: an unsubscribe counts against this campaign
 * when it lands within `attributionWindowDays` of this campaign's sends AND
 * the email is one this campaign actually mailed. The window is kept shorter
 * than the weekly cadence (default 6d < 7d) so it can't bleed into the next
 * week's send.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} campaignId
 * @param {{attributionWindowDays?: number}} [opts]
 * @returns {Promise<ReturnType<typeof aggregateSegmentReport> & {campaignId:string}>}
 */
export async function loadCampaignSegmentReport(db, campaignId, opts = {}) {
  const attributionWindowDays = opts.attributionWindowDays ?? 6;

  const runQuery = async (group) => {
    try {
      return await db.collectionGroup(group).where('campaign_id', '==', campaignId).get();
    } catch (e) {
      if (String(e?.message || '').includes('index')) throw new MissingIndexError(group, e);
      throw e;
    }
  };

  const sendSnap = await runQuery('campaign_deliveries');
  const eventSnap = await runQuery('events');

  const openedEmails = new Set();
  const openedMsgIds = new Set();
  const clickedEmails = new Set();
  const clickedMsgIds = new Set();
  for (const doc of eventSnap.docs) {
    const d = doc.data();
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (d.event_type === 'open') {
      if (email) openedEmails.add(email);
      if (d.message_id) openedMsgIds.add(String(d.message_id));
    } else if (d.event_type === 'click') {
      if (email) clickedEmails.add(email);
      if (d.message_id) clickedMsgIds.add(String(d.message_id));
    }
  }

  const deliveries = [];
  let minSentAt = null;
  let maxSentAt = null;
  for (const doc of sendSnap.docs) {
    const d = doc.data();
    if (!d.sent_at) continue;
    const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
    if (!email) continue;
    // Same canonical-doc dedup as loadCampaignVariantTotals — webhook docs for
    // non-Resend providers write a separate single-underscore doc id.
    if (doc.id !== buildDeliveryDocId(campaignId, email)) continue;
    const provider = d.provider || 'unknown';
    if (EXPERIMENT_EXCLUDED_PROVIDERS.has(provider)) continue;
    const sentAtMs = toMillis(d.sent_at);
    if (sentAtMs != null) {
      minSentAt = minSentAt == null ? sentAtMs : Math.min(minSentAt, sentAtMs);
      maxSentAt = maxSentAt == null ? sentAtMs : Math.max(maxSentAt, sentAtMs);
    }
    deliveries.push({
      email,
      segment: d.segment || null,
      messageId: d.message_id ? String(d.message_id) : null,
      openedAt: toMillis(d.opened_at),
      clickedAt: toMillis(d.clicked_at),
    });
  }

  const sentEmails = new Set(deliveries.map((d) => d.email));
  const unsubscribedEmails = new Set();
  if (minSentAt != null && sentEmails.size > 0) {
    const windowEnd = maxSentAt + attributionWindowDays * DAY_MS;
    let unsubSnap;
    try {
      unsubSnap = await db.collectionGroup('events')
        .where('event_type', '==', 'unsubscribe')
        .where('timestamp', '>=', new Date(minSentAt))
        .where('timestamp', '<', new Date(windowEnd))
        .get();
    } catch (e) {
      if (String(e?.message || '').includes('index')) throw new MissingIndexError('events', e);
      throw e;
    }
    for (const doc of unsubSnap.docs) {
      const d = doc.data();
      const email = (d.email || doc.ref.parent?.parent?.id || '').toLowerCase();
      if (email && sentEmails.has(email)) unsubscribedEmails.add(email);
    }
  }

  const report = aggregateSegmentReport(deliveries, { openedEmails, openedMsgIds, clickedEmails, clickedMsgIds, unsubscribedEmails });
  return { ...report, campaignId };
}
