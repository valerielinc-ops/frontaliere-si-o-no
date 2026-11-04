#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_SHARD_COUNT,
  QUOTA_ERROR_THRESHOLD,
  normalizeShardCount,
} from './lib/event-description-throughput-plan.mjs';
import {
  emptyRewriteStats,
  EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  EVENT_DESCRIPTION_POLICY_VERSION,
  EVENT_DESCRIPTION_PROMPT_VERSION,
  EVENT_DESCRIPTION_REWRITE_MODEL,
  REJECTION_MEMORY_SCHEMA_VERSION,
} from './lib/event-description-empty-shard.mjs';

const DEFAULT_LIMIT = 100;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = CIRCUIT_BREAKER_THRESHOLD;

function optionValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(args, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = optionValue(args, name, undefined);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseArgs(argv) {
  const shardCount = normalizeShardCount(optionValue(argv, '--shard-count', DEFAULT_SHARD_COUNT));
  return {
    shardCount,
    shardIndex: numberOption(argv, '--shard-index', 0, { min: 0, max: shardCount - 1 }),
    limit: numberOption(argv, '--limit', DEFAULT_LIMIT, { min: 1, max: 10_000 }),
    circuitBreakerThreshold: numberOption(argv, '--circuit-breaker-threshold', DEFAULT_CIRCUIT_BREAKER_THRESHOLD, { min: 1, max: 10 }),
    outputCache: optionValue(argv, '--output-cache'),
    statsOutput: optionValue(argv, '--stats-output'),
  };
}

function writeJson(pathname, value) {
  if (!pathname) return;
  const resolved = path.resolve(pathname);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const stats = {
    ...emptyRewriteStats({
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      limit: options.limit,
      startedAt,
    }),
    completedAt: new Date().toISOString(),
    model: EVENT_DESCRIPTION_REWRITE_MODEL,
    promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
    quotaErrorThreshold: QUOTA_ERROR_THRESHOLD,
    circuitBreakerThreshold: options.circuitBreakerThreshold,
  };
  writeJson(options.outputCache, {
    schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
    rejectionMemorySchemaVersion: REJECTION_MEMORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    model: EVENT_DESCRIPTION_REWRITE_MODEL,
    promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
    policyVersion: EVENT_DESCRIPTION_POLICY_VERSION,
    entries: {},
    rejections: {},
  });
  writeJson(options.statsOutput, stats);
  console.log(JSON.stringify(stats));
}

try {
  main();
} catch (error) {
  console.error(`[initialize-event-description-shard] ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
