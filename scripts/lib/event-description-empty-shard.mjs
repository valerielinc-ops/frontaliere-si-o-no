/**
 * Dependency-free empty shard contract.
 *
 * The rewrite workflow creates an artifact before npm ci so that later
 * failures still leave a valid shard to inspect. Keep this module limited to
 * Node-independent data construction; runtime policy imports can reach npm
 * packages through events-utils.mjs.
 */

export const THROUGHPUT_SCHEMA_VERSION = 1;
export const REJECTION_MEMORY_SCHEMA_VERSION = 1;
export const EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION = 2;
export const EVENT_DESCRIPTION_REWRITE_MODEL = 'gpt-5.6-luna';
export const EVENT_DESCRIPTION_PROMPT_VERSION = 'event-description-rewrite-v3';
export const EVENT_DESCRIPTION_POLICY_VERSION = 'event-description-policy-v3';

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
