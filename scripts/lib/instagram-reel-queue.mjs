import { isExpired, parseQueue } from './social-publish-queue.mjs';

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
