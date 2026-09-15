/**
 * Client-side PostHog quota controls.
 *
 * Sampling is deterministic per session so an included session keeps its
 * complete event sequence. Session-replay snapshots are never filtered here:
 * they use the same PostHog capture pipeline but a separate replay quota.
 */

/** Keep one in ten client sessions for product analytics. */
export const POSTHOG_EVENT_SAMPLE_RATE = 0.1;

/** Keep one in twenty sessions for Session Replay. */
export const POSTHOG_SESSION_REPLAY_SAMPLE_RATE = 0.05;

export interface PostHogQuotaEvent {
  event?: string;
  distinct_id?: unknown;
  properties?: {
    $session_id?: unknown;
    distinct_id?: unknown;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

const POSTHOG_UNSAMPLED_EVENTS = new Set([
  '$snapshot',
  '$identify',
  '$set',
  '$set_once',
  '$groupidentify',
  '$create_alias',
]);

function stableHashToUnitInterval(value: string): number {
  // FNV-1a keeps the decision stable without adding a dependency or storing
  // another identifier in the browser.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

/**
 * Return whether a client event should reach PostHog's analytics endpoint.
 * Missing identifiers fail open so a future SDK payload change cannot drop
 * all analytics silently.
 */
export function shouldCapturePostHogEvent(
  event: PostHogQuotaEvent | null | undefined,
  sampleRate: number = POSTHOG_EVENT_SAMPLE_RATE,
): boolean {
  if (!event) return false;

  // Replay snapshots are billed as recordings, not analytics events. Dropping
  // them here would silently corrupt recordings for sampled sessions.
  if (POSTHOG_UNSAMPLED_EVENTS.has(event.event || '')) return true;

  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;

  const properties = event.properties || {};
  const sampleKey = properties.$session_id ?? properties.distinct_id ?? event.distinct_id;
  if (sampleKey === null || sampleKey === undefined || sampleKey === '') return true;

  return stableHashToUnitInterval(String(sampleKey)) < sampleRate;
}

/** Adapter for PostHog's `before_send` hook. */
export function createPostHogQuotaFilter(
  sampleRate: number = POSTHOG_EVENT_SAMPLE_RATE,
) {
  return function postHogQuotaFilter(event: PostHogQuotaEvent | null): PostHogQuotaEvent | null {
    if (!event) return null;
    return shouldCapturePostHogEvent(event, sampleRate) ? event : null;
  };
}
