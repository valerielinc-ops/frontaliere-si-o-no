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
 * @param {object} subscriberData Firestore subscriber doc fields
 * @returns {{ score: number, level: 'hot'|'warm'|'cool'|'cold'|'dormant' }}
 */
export function calculateEngagementScore(subscriberData) {
 const sendCount = Number(subscriberData?.send_count || subscriberData?.sendCount) || 0;
 const openCount = Number(subscriberData?.open_count || subscriberData?.openCount) || 0;
 const clickCount = Number(subscriberData?.click_count || subscriberData?.clickCount) || 0;

 const openRate = sendCount > 0 ? openCount / sendCount : 0;
 const clickRate = sendCount > 0 ? clickCount / sendCount : 0;

 const openScore = Math.min(40, Math.round(openRate * 80));
 const clickScore = Math.min(30, Math.round(clickRate * 150));

 const lastEngagement = subscriberData?.last_click_at
  || subscriberData?.lastClickAt
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
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {*} FieldValue admin.firestore.FieldValue
 * @returns {Promise<{ updated: boolean, score?: number, level?: string }>}
 */
export async function refreshEngagementScore(subscriberRef, FieldValue) {
 try {
  const doc = await subscriberRef.get();
  if (!doc.exists) return { updated: false };
  const { score, level } = calculateEngagementScore(doc.data());
  const current = doc.data();
  if (current.engagement_score === score && current.engagement_level === level) {
   return { updated: false, score, level };
  }
  await subscriberRef.set({
   engagement_score: score,
   engagement_level: level,
   engagement_updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { updated: true, score, level };
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
