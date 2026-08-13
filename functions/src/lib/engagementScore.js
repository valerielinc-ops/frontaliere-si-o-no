/**
 * Shared engagement scoring module for newsletter ESP webhooks and send pipeline.
 *
 * Pure function: takes a subscriber document snapshot, returns { score, level }.
 * Mirrors the TS implementation in services/newsletterSubscribers.ts
 * (calculateEngagementScore — FRO-17). Keep both in sync.
 *
 * Score breakdown (0-100):
 *   - Open rate component:  0-40  pts (open_count / send_count, scaled)
 *   - Click rate component: 0-30  pts (click_count / send_count, scaled)
 *   - Recency component:    0-30  pts (days since last open/click)
 *
 * Tier mapping:
 *   - hot     : score >= 70
 *   - warm    : 50-69
 *   - cool    : 30-49
 *   - cold    : 10-29
 *   - dormant : 0-9
 */

const HOT_THRESHOLD = 70;
const WARM_THRESHOLD = 50;
const COOL_THRESHOLD = 30;
const COLD_THRESHOLD = 10;

/**
 * The opt-out link, in the four locales the mails go out in. PINNED MIRROR of
 * OPT_OUT_LINK_RE in scripts/lib/syntheticClicks.mjs (#5767 same anti-pattern
 * as the job-alert channel had, scripts/lib/jobAlertEngagementTier.mjs): the
 * Cloud Functions bundle has no bundler and cannot import outside `functions/`
 * (same arrangement as functions/src/lib/newsletterOptOut.js), so this is a
 * deliberate copy, not a second independently-invented rule. Change one,
 * change the other in the same PR.
 */
const OPT_OUT_LINK_RE = /[?&]action=unsubscribe|[?&]unsubscribe=|\/unsubscribe\b|\/disiscrivi(?:ti|-[a-z]+)\b|\/abmelden\b|\/desabonnement\b|\/se-desabonner\b|list-unsubscribe/i;

function isOptOutLink(url) {
 return typeof url === 'string' && url !== '' && OPT_OUT_LINK_RE.test(url);
}

/**
 * @param {object} subscriberData Firestore subscriber doc fields
 * @returns {{ score: number, level: 'hot'|'warm'|'cool'|'cold'|'dormant' }}
 */
export function calculateEngagementScore(subscriberData) {
 const sendCount = Number(subscriberData?.send_count || subscriberData?.sendCount) || 0;
 const openCount = Number(subscriberData?.open_count || subscriberData?.openCount) || 0;
 const rawClickCount = Number(subscriberData?.click_count || subscriberData?.clickCount) || 0;

 const lastClickUrl = subscriberData?.last_clicked_url ?? subscriberData?.lastClickedUrl ?? '';
 const lastClickIsOptOut = isOptOutLink(lastClickUrl);

 // The one click this counter can be attributed to (the most recent one) is
 // dropped when it is the way out: clicking "unsubscribe" must never buy a
 // higher score, the way reading click_count/last_click_at raw did (#5767).
 // Earlier clicks folded into the aggregate counter cannot be individually
 // attributed without an event log — a measured limitation, not an oversight.
 const clickCount = lastClickIsOptOut ? Math.max(0, rawClickCount - 1) : rawClickCount;

 const openRate = sendCount > 0 ? openCount / sendCount : 0;
 const clickRate = sendCount > 0 ? clickCount / sendCount : 0;

 const openScore = Math.min(40, Math.round(openRate * 80));
 const clickScore = Math.min(30, Math.round(clickRate * 150));

 // An opt-out click is a request for less, never evidence of more: excluded
 // from the recency signal so it cannot keep a subscriber out of cold/dormant
 // the way a raw last_click_at read did.
 const lastClickAt = lastClickIsOptOut ? null : (subscriberData?.last_click_at || subscriberData?.lastClickAt);
 const lastEngagement = lastClickAt
  || subscriberData?.last_open_at
  || subscriberData?.lastOpenAt;

 let recencyScore = 0;
 if (lastEngagement) {
  const ts = typeof lastEngagement === 'object' && typeof lastEngagement.toDate === 'function'
   ? lastEngagement.toDate().getTime()
   : new Date(lastEngagement).getTime();
  if (Number.isFinite(ts)) {
   const daysSince = (Date.now() - ts) / (1000 * 60 * 60 * 24);
   if (daysSince < 7) recencyScore = 30;
   else if (daysSince < 14) recencyScore = 25;
   else if (daysSince < 30) recencyScore = 18;
   else if (daysSince < 60) recencyScore = 10;
   else if (daysSince < 90) recencyScore = 5;
  }
 }

 const score = Math.min(100, openScore + clickScore + recencyScore);
 const level = scoreToLevel(score);
 return { score, level };
}

/**
 * @param {number} score 0-100
 * @returns {'hot'|'warm'|'cool'|'cold'|'dormant'}
 */
export function scoreToLevel(score) {
 if (score >= HOT_THRESHOLD) return 'hot';
 if (score >= WARM_THRESHOLD) return 'warm';
 if (score >= COOL_THRESHOLD) return 'cool';
 if (score >= COLD_THRESHOLD) return 'cold';
 return 'dormant';
}

/**
 * Re-read a subscriber doc and persist a freshly computed engagement score.
 * Safe to call after any counter increment — failures are swallowed and logged.
 *
 * Wrapped in a Firestore transaction (same idiom as maybeEscalateSoftBounce in
 * bounceClassification.js) so the read-decide-write is atomic: two concurrent
 * webhook deliveries for the same subscriber (open+click landing together, or
 * an ESP retry) can no longer both read a pre-update counter snapshot and race
 * to persist a stale derived score/level.
 *
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {*} FieldValue admin.firestore.FieldValue
 * @returns {Promise<{ updated: boolean, score?: number, level?: string }>}
 */
export async function refreshEngagementScore(subscriberRef, FieldValue) {
 try {
  return await subscriberRef.firestore.runTransaction(async (tx) => {
   const doc = await tx.get(subscriberRef);
   if (!doc.exists) return { updated: false };
   const current = doc.data();
   const { score, level } = calculateEngagementScore(current);
   if (current.engagement_score === score && current.engagement_level === level) {
    return { updated: false, score, level };
   }
   tx.set(subscriberRef, {
    engagement_score: score,
    engagement_level: level,
    engagement_updated_at: FieldValue.serverTimestamp(),
   }, { merge: true });
   return { updated: true, score, level };
  });
 } catch (err) {
  // Non-critical: webhook delivery should not fail because of scoring
  console.warn('[engagementScore] refresh failed:', err?.message);
  return { updated: false };
 }
}

export const ENGAGEMENT_THRESHOLDS = {
 HOT: HOT_THRESHOLD,
 WARM: WARM_THRESHOLD,
 COOL: COOL_THRESHOLD,
 COLD: COLD_THRESHOLD,
};
