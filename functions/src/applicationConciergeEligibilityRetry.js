/** Private retry metadata shares the qualification cache's 90-day retention. */
import { createHash } from 'node:crypto';

const DELAYS = [60 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, 3 * 86400_000];
export const MAX_ELIGIBILITY_RETRIES_PER_RUN = 8;
export function eligibilityRetryRef(serviceRef, url) {
  return serviceRef.collection('eligibility').doc(`retry-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`);
}

export async function dueEligibilityRetries(serviceRef, nowMs) {
  const result = await serviceRef.collection('eligibility').where('retryAt', '<=', nowMs).orderBy('retryAt')
    .limit(MAX_ELIGIBILITY_RETRIES_PER_RUN).get();
  return result.docs;
}

export async function recordEligibilityRetry({ db, serviceRef, url, result, context, nowMs }) {
  if (['analysis_deferred', 'retry_backoff'].includes(result?.reason)) return;
  const ref = eligibilityRetryRef(serviceRef, url);
  await db.runTransaction(async transaction => {
    const previous = (await transaction.get(ref)).data();
    if (['compatible', 'incompatible', 'clarification_required'].includes(result?.status)) {
      if (previous) transaction.delete(ref);
      return;
    }
    const attempts = previous?.context === context ? (Number(previous.attempts) || 0) + 1 : 1;
    transaction.set(ref, { jobUrl: url, context, attempts,
      retryAt: nowMs + DELAYS[Math.min(attempts - 1, DELAYS.length - 1)] });
  });
}

export async function eligibilityRetrySummary(serviceRef) {
  const pending = serviceRef.collection('eligibility').where('retryAt', '>', 0);
  const [count, first] = await Promise.all([pending.count().get(), pending.orderBy('retryAt').limit(1).get()]);
  return { count: Number(count.data().count) || 0, retryAt: first.docs[0]?.data()?.retryAt || null };
}
