#!/usr/bin/env node

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_EVENTS_PER_SHARD,
  DEFAULT_SHARD_COUNT,
  QUOTA_ERROR_THRESHOLD,
  adaptThroughput,
  normalizeEventsPerShard,
  normalizeShardCount,
  readJsonFile,
} from './lib/event-description-throughput.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function writeOutput(pathname, values) {
  if (!pathname) return;
  // Keep the output contract statically visible to the workflow audit. The
  // planner still accepts a single values object, but the map written to
  // GITHUB_OUTPUT is declared at the sink so every exported key is provable.
  const lines = {
    effective_shards: values.effectiveShards,
    events_per_shard: values.eventsPerShard,
    quota_error_threshold: values.quotaErrorThreshold,
    circuit_breaker_threshold: values.circuitBreakerThreshold,
    shard_matrix: values.shardMatrix,
    direction: values.direction,
    reason: values.reason,
  };
  appendFileSync(
    pathname,
    `${Object.entries(lines)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n')}\n`,
  );
}

const requestedShards = normalizeShardCount(argument('--requested-shards', DEFAULT_SHARD_COUNT));
const requestedEventsPerShard = normalizeEventsPerShard(argument('--requested-events-per-shard', DEFAULT_EVENTS_PER_SHARD));
const previousPath = argument('--previous-state');
const previousState = previousPath && existsSync(previousPath) ? readJsonFile(previousPath) : null;
const plan = adaptThroughput({
  requestedShards,
  requestedEventsPerShard,
  previousState,
  quotaErrorThreshold: QUOTA_ERROR_THRESHOLD,
});
const output = {
  schemaVersion: 1,
  requestedShards,
  requestedEventsPerShard,
  effectiveShards: plan.shards,
  eventsPerShard: plan.eventsPerShard,
  quotaErrorThreshold: QUOTA_ERROR_THRESHOLD,
  circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
  direction: plan.direction,
  reason: plan.reason,
  shardMatrix: Array.from({ length: plan.shards }, (_, index) => index),
};

const planOutput = argument('--plan-output');
if (planOutput) writeFileSync(planOutput, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
writeOutput(argument('--github-output'), output);
console.log(JSON.stringify(output));
