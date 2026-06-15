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
    const provider = d.provider || 'unknown';
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
