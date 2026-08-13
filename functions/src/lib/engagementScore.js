/**
 * Shared engagement scoring module for newsletter ESP webhooks and send pipeline.
 *
 * Pure function: takes a subscriber document snapshot, returns { score, level }.
 * THE ONLY implementation: services/newsletterSubscribers.ts used to carry a
 * hand-kept twin under a "keep both in sync" comment, and the two had already
 * drifted — this side grew the camelCase spellings and the Firestore Timestamp
 * handling, that side never got them. It re-exports this function now (#5767).
 *
 * Score breakdown (0-100):
 *   - Open rate component:  0-40  pts (open_count / send_count, scaled)
 *   - Click rate component: 0-30  pts (HUMAN clicks / send_count, scaled)
 *   - Recency component:    0-30  pts (days since last open / last HUMAN click)
 *
 * Tier mapping:
 *   - hot     : score >= 70
 *   - warm    : 50-69
 *   - cool    : 30-49
 *   - cold    : 10-29
 *   - dormant : 0-9
 *
 * A CLICK ON THE WAY OUT IS NOT ENGAGEMENT (#5767, review of PR #5774)
 * ───────────────────────────────────────────────────────────────────
 * The third site of the #5674 pattern, and the one with the worst consequence.
 * `click_count` and `last_click_at` were read raw, so a click on the unsubscribe
 * link paid up to 30 points of `clickScore` plus up to 30 of `recencyScore` —
 * 60 of 100, enough on its own for `warm`. `services/newsletter-priority.mjs`
 * sorts sends by that level and `scripts/lib/dormantWinback.mjs` uses it to
 * decide who is past re-engaging, so the gesture that asks to leave was buying
 * a better send priority and an exemption from `cold`/`dormant`.
 *
 * It bites hardest on a FAILED opt-out — expired token, closed page, one-click
 * POST that never landed — because a successful one suppresses the address and
 * this score stops mattering. Measured on 2026-08-13 across the 8.680
 * `newsletter_subscribers` documents: 411 carry an opt-out link as their
 * `last_clicked_url`, and 63 of those are still `confirmed`, i.e. still mailed.
 *
 * WHERE THE RULE COMES FROM. ./syntheticClicks.js, imported — not a pinned copy
 * of its regex. That file is the single definition of "this click does not count
 * as engagement" and its thresholds are calibrated on a measurement written into
 * its comment; a copy here would be the fourth in this repo and the one nobody
 * would remember to update. It lives under functions/ precisely so this Cloud
 * Function can import it: functions/src/ is a hermetic deploy package with zero
 * relative imports that escape it, while services/ and scripts/ already reach
 * INTO functions/src/lib in eight places.
 */

import { classifyClickEvents, toMillis } from './syntheticClicks.js';

const HOT_THRESHOLD = 70;
const WARM_THRESHOLD = 50;
const COOL_THRESHOLD = 30;
const COLD_THRESHOLD = 10;

/**
 * How many of this document's clicks were a person, and when the last one was.
 *
 * Two paths, one rule set. With the `events` subcollection every rule can fire
 * and the human count is exact. Without it — which is what the webhook path has,
 * since reading `events` on every counter increment would be a query per event —
 * only the most recent click is attributable: `click_count` is a bare aggregate
 * with no urls and no instants behind it, so at most ONE click can be subtracted
 * from it. That limitation is measured, not an oversight, and it is the reason
 * the subtraction is `- 1` rather than a reset to zero.
 *
 * @param {object} subscriberData
 * @param {Array<object>|null} clickEvents the `events` docs, if the caller has them
 * @param {number} rawClickCount
 * @returns {{ clickCount: number, lastHumanClickAtMs: number|null }}
 */
function humanClicks(subscriberData, clickEvents, rawClickCount) {
 if (Array.isArray(clickEvents) && clickEvents.length > 0) {
  const verdict = classifyClickEvents(clickEvents);
  return { clickCount: verdict.humanCount, lastHumanClickAtMs: verdict.lastHumanClickAtMs };
 }
 const atMs = toMillis(subscriberData?.last_click_at ?? subscriberData?.lastClickAt);
 if (atMs == null) return { clickCount: rawClickCount, lastHumanClickAtMs: null };
 const url = subscriberData?.last_clicked_url ?? subscriberData?.lastClickedUrl ?? '';
 const verdict = classifyClickEvents([{ at: atMs, url }]);
 return verdict.lastHumanClickAtMs != null
  ? { clickCount: rawClickCount, lastHumanClickAtMs: verdict.lastHumanClickAtMs }
  : { clickCount: Math.max(0, rawClickCount - 1), lastHumanClickAtMs: null };
}

/**
 * @param {object} subscriberData Firestore subscriber doc fields
 * @param {object} [options]
 * @param {Array<object>|null} [options.clickEvents] the `events` subcollection, if the caller has it
 * @param {number} [options.nowMs] injectable clock, for tests
 * @returns {{ score: number, level: 'hot'|'warm'|'cool'|'cold'|'dormant' }}
 */
export function calculateEngagementScore(subscriberData, { clickEvents = null, nowMs = Date.now() } = {}) {
 const sendCount = Number(subscriberData?.send_count || subscriberData?.sendCount) || 0;
 const openCount = Number(subscriberData?.open_count || subscriberData?.openCount) || 0;
 const rawClickCount = Number(subscriberData?.click_count || subscriberData?.clickCount) || 0;

 const { clickCount, lastHumanClickAtMs } = humanClicks(subscriberData, clickEvents, rawClickCount);

 const openRate = sendCount > 0 ? openCount / sendCount : 0;
 const clickRate = sendCount > 0 ? clickCount / sendCount : 0;

 const openScore = Math.min(40, Math.round(openRate * 80));
 const clickScore = Math.min(30, Math.round(clickRate * 150));

 // A synthetic click does not date the account either: recency then measures
 // the last OPEN, or nothing. An opt-out click is a request for less, never
 // evidence of more, and it must not keep a subscriber out of cold/dormant the
 // way a raw last_click_at read did.
 const lastEngagement = lastHumanClickAtMs
  ?? toMillis(subscriberData?.last_open_at ?? subscriberData?.lastOpenAt);

 let recencyScore = 0;
 if (Number.isFinite(lastEngagement)) {
  const daysSince = (nowMs - lastEngagement) / (1000 * 60 * 60 * 24);
  if (daysSince < 7) recencyScore = 30;
  else if (daysSince < 14) recencyScore = 25;
  else if (daysSince < 30) recencyScore = 18;
  else if (daysSince < 60) recencyScore = 10;
  else if (daysSince < 90) recencyScore = 5;
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
