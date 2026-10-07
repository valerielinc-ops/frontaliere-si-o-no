import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  EVENT_DESCRIPTION_POLICY_VERSION,
  EVENT_DESCRIPTION_PROMPT_VERSION,
  isValidRewriteCacheEntry,
  isValidSourceDescriptionHash,
  rewriteCacheKey,
  sourceDescriptionHash,
} from './event-description-policy.mjs';

export const THROUGHPUT_SCHEMA_VERSION = 1;
export const REJECTION_MEMORY_SCHEMA_VERSION = 1;
export const MAX_REJECTION_RUNS = 3;
export const REJECTION_WAIT_BASE_MS = 60 * 60 * 1000;
export const DEFAULT_SHARD_COUNT = 3;
export const MIN_SHARD_COUNT = 1;
export const MAX_SHARD_COUNT = 4;
export const DEFAULT_EVENTS_PER_SHARD = 40;
export const MIN_EVENTS_PER_SHARD = 1;
export const MAX_EVENTS_PER_SHARD = 10_000;
export const QUOTA_ERROR_THRESHOLD = 2;
export const CIRCUIT_BREAKER_THRESHOLD = QUOTA_ERROR_THRESHOLD;
export const QUOTA_BACKOFF_BASE_MS = 15_000;
export const QUOTA_BACKOFF_MAX_MS = 120_000;
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

/** Hash the stable event id; the partition never depends on input ordering. */
export function eventIdShard(id, shardCount) {
  const count = normalizeShardCount(shardCount, 0);
  if (!count) throw new Error('shardCount must be an integer between 1 and 4');
  const digest = crypto.createHash('sha256').update(String(id)).digest();
  return digest.readUInt32BE(0) % count;
}

/**
 * Partition an already priority-sorted queue. Each shard keeps the global
 * ordering of its own members, while the hash makes the slices disjoint and
 * exhaustive for every fixed shard count.
 */
export function partitionQueue(queue, shardCount) {
  const count = normalizeShardCount(shardCount, 0);
  if (!count) throw new Error('shardCount must be an integer between 1 and 4');
  const shards = Array.from({ length: count }, () => []);
  for (const record of queue || []) {
    if (!record?.id) continue;
    shards[eventIdShard(record.id, count)].push(record);
  }
  return shards;
}

export function selectShardQueue(queue, { shardCount = 1, shardIndex = 0, limit = Infinity } = {}) {
  const count = normalizeShardCount(shardCount, 0);
  const index = Number.parseInt(String(shardIndex), 10);
  if (!count || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error('shardIndex must identify one of the configured shards');
  }
  const selected = partitionQueue(queue, count)[index];
  const max = Number.isFinite(limit) ? Math.max(0, Number.parseInt(String(limit), 10)) : selected.length;
  return selected.slice(0, Number.isInteger(max) ? max : selected.length);
}

export function rejectionMemoryKey(id, sourceHash) {
  return rewriteCacheKey(id, sourceHash);
}

export function isValidRejectionMemoryEntry(entry, { id, sourceHash } = {}) {
  return Boolean(
    entry
      && typeof entry.id === 'string'
      && entry.id === id
      && isValidSourceDescriptionHash(sourceHash)
      && entry.sourceDescriptionHash === sourceHash
      && typeof entry.code === 'string'
      && /^[a-z0-9-]+$/u.test(entry.code)
      && Number.isInteger(entry.rejectedRuns)
      && entry.rejectedRuns >= 1
      && entry.rejectedRuns <= MAX_REJECTION_RUNS
      && typeof entry.lastAttemptAt === 'string'
      && Number.isFinite(Date.parse(entry.lastAttemptAt))
      && typeof entry.policyVersion === 'string'
      && /^[a-z0-9-]+$/u.test(entry.policyVersion)
      && typeof entry.promptVersion === 'string'
      && /^[a-z0-9-]+$/u.test(entry.promptVersion),
  );
}

export function rejectionWaitMs(rejectedRuns, baseMs = REJECTION_WAIT_BASE_MS) {
  const runs = Math.max(1, Number.parseInt(String(rejectedRuns), 10) || 1);
  return Math.max(0, Number(baseMs) || 0) * (2 ** (runs - 1));
}

/** Return the queue state without persisting a derived status in the cache. */
export function rejectionStatus(
  entry,
  {
    id,
    sourceHash,
    now = new Date(),
    policyVersion = EVENT_DESCRIPTION_POLICY_VERSION,
    promptVersion = EVENT_DESCRIPTION_PROMPT_VERSION,
  } = {},
) {
  if (!isValidRejectionMemoryEntry(entry, { id, sourceHash })) return 'new';
  if (entry.policyVersion !== policyVersion || entry.promptVersion !== promptVersion) return 'retryable';
  if (entry.rejectedRuns >= MAX_REJECTION_RUNS) return 'parked';
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const lastAttemptMs = Date.parse(entry.lastAttemptAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastAttemptMs)) return 'retryable';
  return nowMs >= lastAttemptMs + rejectionWaitMs(entry.rejectedRuns) ? 'retryable' : 'waiting';
}

/** Add one run-level rejection using only the public-safe memory fields. */
export function recordRejectionMemory(
  memory,
  { id, sourceDescriptionHash: sourceHash },
  code,
  {
    now = new Date(),
    policyVersion = EVENT_DESCRIPTION_POLICY_VERSION,
    promptVersion = EVENT_DESCRIPTION_PROMPT_VERSION,
  } = {},
) {
  if (!memory || typeof memory !== 'object' || !id || !isValidSourceDescriptionHash(sourceHash) || !/^[a-z0-9-]+$/u.test(String(code))) return null;
  const key = rejectionMemoryKey(id, sourceHash);
  const previous = memory?.[key];
  const sameContext = isValidRejectionMemoryEntry(previous, { id, sourceHash })
    && previous.policyVersion === policyVersion
    && previous.promptVersion === promptVersion;
  const rejectedRuns = sameContext ? Math.min(MAX_REJECTION_RUNS, previous.rejectedRuns + 1) : 1;
  const entry = {
    id,
    sourceDescriptionHash: sourceHash,
    code: String(code),
    rejectedRuns,
    lastAttemptAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    policyVersion,
    promptVersion,
  };
  memory[key] = entry;
  return entry;
}

export function queueStateForEvent(event, cache, { now = new Date() } = {}) {
  const hash = event?.sourceDescriptionHash || sourceDescriptionHash(event);
  if (!event?.id || !isValidSourceDescriptionHash(hash)) return 'not-candidate';
  const entries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};
  if (isValidRewriteCacheEntry(entries[rewriteCacheKey(event.id, hash)], { id: event.id, sourceHash: hash })) return 'accepted';
  const rejections = cache?.rejections && typeof cache.rejections === 'object' ? cache.rejections : {};
  return rejectionStatus(rejections[rejectionMemoryKey(event.id, hash)], {
    id: event.id,
    sourceHash: hash,
    now,
  });
}

export function summarizeRewriteQueue(dataset, cache, { now = new Date() } = {}) {
  const counts = {
    pending: 0,
    toAttempt: 0,
    neverAttempted: 0,
    retryable: 0,
    waitingRetry: 0,
    parked: 0,
    accepted: 0,
  };
  for (const event of dataset?.events || []) {
    const state = queueStateForEvent(event, cache, { now });
    if (state === 'accepted') {
      counts.accepted += 1;
    } else if (state === 'new') {
      counts.pending += 1;
      counts.toAttempt += 1;
      counts.neverAttempted += 1;
    } else if (state === 'retryable') {
      counts.pending += 1;
      counts.toAttempt += 1;
      counts.retryable += 1;
    } else if (state === 'waiting' || state === 'parked') {
      counts.pending += 1;
      counts[state === 'waiting' ? 'waitingRetry' : 'parked'] += 1;
    }
  }
  return { ...counts, workable: counts.toAttempt + counts.waitingRetry };
}

/** Keep first attempts ahead of retries while preserving the caller's date order. */
export function compareQueueAttemptPriority(left, right) {
  const leftRank = left?.selectionClass === 'new' ? 0 : 1;
  const rightRank = right?.selectionClass === 'new' ? 0 : 1;
  return leftRank - rightRank;
}

function stableValue(value) {
  return JSON.stringify(value);
}

function sortedEntries(entries) {
  return Object.fromEntries(Object.entries(entries || {}).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Merge shard deltas into the current cache without replacing newer main data.
 * A repeated merge has the same entries, and duplicate shard keys are resolved
 * deterministically instead of depending on artifact download order.
 */
export function mergeRewriteCaches(baseCache, shardCaches = []) {
  const baseEntries = baseCache?.entries && typeof baseCache.entries === 'object'
    ? baseCache.entries
    : {};
  const entries = { ...baseEntries };
  const baseKeys = new Set(Object.keys(baseEntries));
  let duplicateKeys = 0;
  let preservedBaseKeys = 0;

  const caches = [...shardCaches].sort((left, right) => stableValue(left).localeCompare(stableValue(right)));
  for (const cache of caches) {
    const shardEntries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};
    for (const key of Object.keys(shardEntries).sort()) {
      const candidate = shardEntries[key];
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        entries[key] = candidate;
        continue;
      }
      if (stableValue(entries[key]) === stableValue(candidate)) continue;
      duplicateKeys += 1;
      if (baseKeys.has(key)) {
        // The checkout's current cache is authoritative when main advanced
        // while shards were running; the exact source hash still gates use.
        preservedBaseKeys += 1;
        continue;
      }
      if (stableValue(candidate).localeCompare(stableValue(entries[key])) < 0) entries[key] = candidate;
    }
  }

  const baseRejections = baseCache?.rejections && typeof baseCache.rejections === 'object'
    ? baseCache.rejections
    : {};
  const rejections = {};
  for (const [key, candidate] of Object.entries(baseRejections)) {
    if (
      isValidRejectionMemoryEntry(candidate, { id: candidate?.id, sourceHash: candidate?.sourceDescriptionHash })
      && key === rejectionMemoryKey(candidate.id, candidate.sourceDescriptionHash)
    ) rejections[key] = candidate;
  }
  let duplicateRejectionKeys = 0;
  for (const cache of caches) {
    const shardRejections = cache?.rejections && typeof cache.rejections === 'object' ? cache.rejections : {};
    for (const key of Object.keys(shardRejections).sort()) {
      const candidate = shardRejections[key];
      if (!isValidRejectionMemoryEntry(candidate, { id: candidate?.id, sourceHash: candidate?.sourceDescriptionHash })) continue;
      const existing = rejections[key];
      if (!existing) {
        rejections[key] = candidate;
        continue;
      }
      if (stableValue(existing) === stableValue(candidate)) continue;
      duplicateRejectionKeys += 1;
      const existingRuns = Number(existing.rejectedRuns) || 0;
      const candidateRuns = Number(candidate.rejectedRuns) || 0;
      const existingAt = Date.parse(existing.lastAttemptAt) || 0;
      const candidateAt = Date.parse(candidate.lastAttemptAt) || 0;
      if (
        candidateRuns > existingRuns
        || (candidateRuns === existingRuns && candidateAt > existingAt)
        || (candidateRuns === existingRuns && candidateAt === existingAt && stableValue(candidate).localeCompare(stableValue(existing)) < 0)
      ) rejections[key] = candidate;
    }
  }
  for (const key of Object.keys(entries)) delete rejections[key];

  return {
    ...baseCache,
    schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
    entries: sortedEntries(entries),
    rejections: sortedEntries(rejections),
    mergeStats: { duplicateKeys, preservedBaseKeys, duplicateRejectionKeys },
  };
}

export function classifyCodexFailure(error) {
  const message = `${error?.name || ''} ${error?.message || error || ''}`.toLowerCase();
  if (/(?:\b429\b|rate[ -]?limit|rate_limit|quota|too many requests|resource exhausted|usage limit|session limit|request limit exhausted|limit reached|capacity)/u.test(message)) {
    return 'quota';
  }
  if (/(?:timeout|timed out|deadline exceeded|queue wait)/u.test(message)) return 'timeout';
  if (/(?:temporarily unavailable|connection closed|socket|econn|broker)/u.test(message)) return 'transport';
  return 'provider';
}

export function isCircuitBreakerFailure(kind) {
  return kind === 'quota' || kind === 'timeout' || kind === 'transport';
}

export function exponentialBackoffMs(failureStreak, baseMs = QUOTA_BACKOFF_BASE_MS, maxMs = QUOTA_BACKOFF_MAX_MS) {
  const streak = Math.max(1, Number.parseInt(String(failureStreak), 10) || 1);
  const base = Math.max(0, Number.parseInt(String(baseMs), 10) || 0);
  const ceiling = Math.max(base, Number.parseInt(String(maxMs), 10) || base);
  return Math.min(ceiling, base * (2 ** (streak - 1)));
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

export function countPendingEvents(dataset, cache) {
  return summarizeRewriteQueue(dataset, cache).pending;
}

export function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function emptyRewriteStats({ shardIndex = 0, shardCount = 1, limit = 0, startedAt = new Date().toISOString() } = {}) {
  return {
    throughputSchemaVersion: THROUGHPUT_SCHEMA_VERSION,
    shardIndex,
    shardCount,
    limit,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    calls: 0,
    attempts: 0,
    eventAttempts: 0,
    retries: 0,
    accepted: 0,
    acceptedByModel: 0,
    acceptedByFallback: 0,
    rejected: 0,
    quotaErrors: 0,
    timeoutErrors: 0,
    brokerErrors: 0,
    circuitBreakerTrips: 0,
    circuitOpen: false,
    circuitReason: '',
    transportFailures: 0,
    inputChars: 0,
    outputChars: 0,
    inputBudgetSkipped: 0,
    elapsedMs: 0,
    observedElapsedMs: 0,
    backoffMs: 0,
    rejectionCodes: {},
    rejectionDetails: {},
    selectedNeverAttempted: 0,
    selectedRetries: 0,
    acceptedNeverAttempted: 0,
    acceptedRetries: 0,
    rejectedNeverAttempted: 0,
    rejectedRetries: 0,
    parkedFallbackCandidates: 0,
    parkedUnchanged: 0,
    totalCandidateRecords: 0,
    selected: 0,
    queueRemaining: 0,
    toAttempt: 0,
    neverAttempted: 0,
    retryable: 0,
    waitingRetry: 0,
    parked: 0,
    model: '',
    promptVersion: '',
    policyVersion: '',
    rejectionMemorySchemaVersion: REJECTION_MEMORY_SCHEMA_VERSION,
    quota: { tokenCountersExposed: false },
  };
}
