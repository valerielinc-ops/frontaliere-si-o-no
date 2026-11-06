/**
 * Shared age semantics for the translation queue.
 *
 * `firstSeenAt` is the queue's primary age signal and `crawledAt` is the
 * legacy fallback. Keeping this predicate in one small dependency-free module
 * prevents the audit and the repair lane from disagreeing about which jobs
 * have waited long enough to be stale.
 */

export const TRANSLATION_QUEUE_STALE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function translationQueueAgeMs(job, now = Date.now()) {
  const raw = job?.firstSeenAt || job?.crawledAt || null;
  if (!raw) return null;
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? now - timestamp : null;
}

export function isTranslationQueueStale(
  job,
  now = Date.now(),
  staleDays = TRANSLATION_QUEUE_STALE_DAYS,
) {
  const ageMs = translationQueueAgeMs(job, now);
  const days = Number(staleDays);
  return ageMs !== null
    && Number.isFinite(days)
    && ageMs >= days * MS_PER_DAY;
}
