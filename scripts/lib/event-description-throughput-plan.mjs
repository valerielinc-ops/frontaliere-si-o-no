/**
 * Dependency-free throughput planning for the event-description workflow.
 *
 * The plan job intentionally skips `npm ci`, so this module must remain
 * limited to Node-independent numeric adaptation. Runtime queue and policy
 * helpers live in event-description-throughput.mjs and may use the full
 * event-description policy graph.
 */

export const DEFAULT_SHARD_COUNT = 3;
export const MIN_SHARD_COUNT = 1;
export const MAX_SHARD_COUNT = 4;
export const DEFAULT_EVENTS_PER_SHARD = 40;
export const MIN_EVENTS_PER_SHARD = 1;
export const MAX_EVENTS_PER_SHARD = 10_000;
export const QUOTA_ERROR_THRESHOLD = 2;
export const CIRCUIT_BREAKER_THRESHOLD = QUOTA_ERROR_THRESHOLD;
export const EVENTS_PER_SHARD_RAMP = 8;

function integerInRange(value, { min, max, fallback }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function normalizeShardCount(value, fallback = DEFAULT_SHARD_COUNT) {
  return integerInRange(value, { min: MIN_SHARD_COUNT, max: MAX_SHARD_COUNT, fallback });
}

export function normalizeEventsPerShard(value, fallback = DEFAULT_EVENTS_PER_SHARD) {
  return integerInRange(value, {
    min: MIN_EVENTS_PER_SHARD,
    max: MAX_EVENTS_PER_SHARD,
    fallback,
  });
}

export function adaptThroughput({
  requestedShards = DEFAULT_SHARD_COUNT,
  requestedEventsPerShard = DEFAULT_EVENTS_PER_SHARD,
  previousState = null,
  quotaErrorThreshold = QUOTA_ERROR_THRESHOLD,
} = {}) {
  const requested = {
    shards: normalizeShardCount(requestedShards),
    eventsPerShard: normalizeEventsPerShard(requestedEventsPerShard),
  };
  const previousShards = normalizeShardCount(previousState?.effectiveShards, 0);
  const previousEvents = normalizeEventsPerShard(previousState?.eventsPerShard, 0);
  if (!previousShards || !previousEvents) {
    return { ...requested, direction: 'default', reason: 'no-previous-run-state' };
  }

  const quotaErrors = Number(previousState?.quotaErrors) || 0;
  if (quotaErrors >= quotaErrorThreshold) {
    return {
      shards: Math.max(MIN_SHARD_COUNT, Math.min(requested.shards, previousShards - 1)),
      eventsPerShard: Math.max(MIN_EVENTS_PER_SHARD, Math.min(requested.eventsPerShard, previousEvents - EVENTS_PER_SHARD_RAMP)),
      direction: 'down',
      reason: `previous-run-quota-errors-${quotaErrors}`,
    };
  }
  if (quotaErrors > 0) {
    return {
      shards: Math.min(requested.shards, previousShards),
      eventsPerShard: Math.min(requested.eventsPerShard, previousEvents),
      direction: 'hold',
      reason: `previous-run-quota-errors-below-threshold-${quotaErrors}`,
    };
  }
  return {
    shards: Math.min(requested.shards, previousShards + 1),
    eventsPerShard: Math.min(requested.eventsPerShard, previousEvents + EVENTS_PER_SHARD_RAMP),
    direction: 'up',
    reason: 'previous-run-without-quota-errors',
  };
}
