import { buildEngagementScoreUpdate } from './engagementScore.js';
import { buildPreferredSendHourUpdate } from './preferredSendHour.js';

/**
 * Combine high-frequency newsletter metrics with a webhook's subscriber
 * update. The caller merges the returned fields into its existing transaction
 * write, so open/click events write the subscriber document only once.
 *
 * @param {{transaction: *, subscriberRef: *, current: object, FieldValue: *, subscriberUpdate: object, type: string, occurredAt: *}} args
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildNewsletterEventMetricsUpdate({
 transaction,
 subscriberRef,
 current,
 FieldValue,
 subscriberUpdate,
 type,
 occurredAt,
}) {
 if (!['open', 'click', 'send'].includes(type)) return {};

 const nowMs = Date.now();
 const update = buildEngagementScoreUpdate(current, FieldValue, { subscriberUpdate, nowMs });

 if (type === 'open' || type === 'click') {
  try {
   const preferred = await buildPreferredSendHourUpdate({
    transaction,
    subscriberRef,
    current,
    FieldValue,
    currentEvent: { type, occurredAt },
    eventAlreadyPersisted: false,
    nowMs,
   });
   Object.assign(update, preferred.update);
  } catch (error) {
   // Preferred-hour scoring is non-critical. Preserve the provider event even
   // if the one-time history backfill or derived calculation cannot run.
   console.warn('[preferredSendHour] webhook projection failed:', error?.message);
  }
 }

 return update;
}
