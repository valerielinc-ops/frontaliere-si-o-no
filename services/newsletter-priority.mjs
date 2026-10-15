/**
 * Engagement-based subscriber send order (FRO-17 follow-up).
 *
 * ESPs use the first-hour open/spam rates of a campaign to score deliverability
 * for the rest of the batch. Sending to most-engaged subscribers first builds a
 * positive reputation window for the whole list. Best practice across Klaviyo,
 * Mailmodo, Salesforce, Attentive.
 *
 * Tier order (descending priority):
 *   1. hot      (engagement_score >= 70)
 *   2. warm     (50-69)
 *   3. new      (sendCount < 3 AND subscribed within 14 days — unproven but motivated)
 *   4. cool     (30-49)
 *   5. cold     (10-29)
 *   6. dormant  (0-9)
 *
 * Within tier: sort by engagementScore DESC, then createdAt DESC (newer first).
 */

const TIER_RANK = { hot: 0, warm: 1, new: 2, cool: 3, cold: 4, dormant: 5 };
const NEW_RECENCY_MS = 14 * 24 * 60 * 60 * 1000;
const NEW_SEND_THRESHOLD = 3;

function classify(s, now) {
 const sendCount = Number(s.sendCount) || 0;
 const subscribedAt = s.createdAt instanceof Date ? s.createdAt.getTime() : 0;
 const isRecent = subscribedAt > 0 && (now - subscribedAt) < NEW_RECENCY_MS;
 if (
  sendCount < NEW_SEND_THRESHOLD
  && isRecent
  && (s.engagementLevel === 'cold' || s.engagementLevel === 'dormant')
 ) {
  return 'new';
 }
 return s.engagementLevel || 'dormant';
}

/**
 * @param {Array<object>} subscribers each with engagementLevel, engagementScore, sendCount, createdAt
 * @param {{ logger?: { log: (msg: string) => void } }} [opts]
 * @returns {Array<object>} subscribers sorted in descending priority
 */
export function prioritizeSubscribers(subscribers, opts = {}) {
 const logger = opts.logger || console;
 const now = Date.now();

 const tierCounts = { hot: 0, warm: 0, new: 0, cool: 0, cold: 0, dormant: 0 };
 const enriched = subscribers.map((s) => {
  const tier = classify(s, now);
  tierCounts[tier]++;
  return { sub: s, tier };
 });

 enriched.sort((a, b) => {
  const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (tierDiff !== 0) return tierDiff;
  const scoreDiff = (b.sub.engagementScore || 0) - (a.sub.engagementScore || 0);
  if (scoreDiff !== 0) return scoreDiff;
  const aTs = a.sub.createdAt instanceof Date ? a.sub.createdAt.getTime() : 0;
  const bTs = b.sub.createdAt instanceof Date ? b.sub.createdAt.getTime() : 0;
  return bTs - aTs;
 });

 logger.log(
  `\ud83d\udcca Tier distribution: hot=${tierCounts.hot} warm=${tierCounts.warm} `
  + `new=${tierCounts.new} cool=${tierCounts.cool} cold=${tierCounts.cold} dormant=${tierCounts.dormant}`,
 );

 return enriched.map((e) => e.sub);
}

export const PRIORITY_TIERS = Object.freeze({ ...TIER_RANK });
