import { isExpired, parseQueue } from './social-publish-queue.mjs';

export const INSTAGRAM_REEL_MEASUREMENT_WINDOW_HOURS = 72;

/**
 * Return the active Instagram Reel already waiting for the browser robot.
 *
 * A later experiment must not replace an unpublished treatment: doing so would
 * erase the first cohort before it receives a live observation. Expired queue
 * entries are deliberately ignored so a failed/abandoned experiment can be
 * replaced after its explicit retention window.
 */
export function pendingInstagramReel(queue, now = Date.now()) {
  return parseQueue(queue).pending.find((entry) => (
    entry.channel === 'instagram'
    && entry.kind === 'reel'
    && !isExpired(entry, now)
  )) || null;
}

/**
 * Return the most recent Reel still inside the measurement window.
 *
 * The next scheduled cohort waits for this window so its first 72-hour
 * observation is not mixed with another Reel published too soon afterward.
 */
export function recentInstagramReel(
  ledger,
  now = Date.now(),
  windowHours = INSTAGRAM_REEL_MEASUREMENT_WINDOW_HOURS,
) {
  const posted = Array.isArray(ledger) ? ledger : ledger?.posted;
  if (!Array.isArray(posted)) return null;
  const nowMs = new Date(now).getTime();
  const windowMs = Number(windowHours) * 3600000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) return null;
  return posted
    .filter((entry) => entry?.kind === 'reel')
    .map((entry) => ({ entry, ts: Date.parse(entry?.ts ?? '') }))
    .filter(({ ts }) => Number.isFinite(ts) && nowMs >= ts && nowMs - ts < windowMs)
    .sort((a, b) => b.ts - a.ts)
    .at(0)?.entry || null;
}
