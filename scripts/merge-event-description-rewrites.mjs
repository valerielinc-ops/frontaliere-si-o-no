#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  EVENT_DESCRIPTION_POLICY_VERSION,
  EVENT_DESCRIPTION_PROMPT_VERSION,
  EVENT_DESCRIPTION_REWRITE_MODEL,
  loadEventDescriptionRewriteCache,
} from './lib/event-description-policy.mjs';
import {
  REJECTION_MEMORY_SCHEMA_VERSION,
  mergeRewriteCaches,
  summarizeRewriteQueue,
} from './lib/event-description-throughput.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(pathname, fallback = null) {
  try {
    return JSON.parse(readFileSync(pathname, 'utf8'));
  } catch {
    return fallback;
  }
}

function findFiles(root, basename) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      else if (entry.isFile() && entry.name === basename) files.push(pathname);
    }
  };
  visit(root);
  return files.sort();
}

function sumStats(stats, key) {
  return stats.reduce((total, shard) => total + (Number(shard[key]) || 0), 0);
}

function mergeCounterMaps(stats, key) {
  return stats.reduce((all, item) => {
    for (const [name, count] of Object.entries(item[key] || {})) all[name] = (all[name] || 0) + (Number(count) || 0);
    return all;
  }, {});
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function recentSuccessfulRuns(currentStats, recentStatsFiles) {
  const candidates = [
    currentStats,
    ...recentStatsFiles.map((file) => readJson(file, null)).filter(Boolean),
  ];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const seen = new Set();
  return candidates.filter((run, index) => {
    const accepted = Number(run?.accepted);
    if (!Number.isFinite(accepted) || accepted <= 0) return false;
    const completedAt = Date.parse(run.completedAt || run.startedAt || '');
    if (!Number.isFinite(completedAt) || completedAt < cutoff) return false;
    const runId = String(run.runId ?? '');
    const key = runId ? `run-${runId}` : `file-${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeStats(statsFiles, plan, mergedCache, datasetPath, recentStatsFiles = []) {
  const stats = statsFiles.map((file) => readJson(file, {})).filter(Boolean);
  const sum = (key) => sumStats(stats, key);
  const durationMs = stats.reduce((max, shard) => Math.max(max, Number(shard.durationMs) || 0), 0);
  const dataset = readJson(datasetPath, { events: [] });
  const queueState = summarizeRewriteQueue(dataset, mergedCache);
  const accepted = sum('accepted');
  const currentStats = {
    runId: process.env.GITHUB_RUN_ID || '',
    completedAt: new Date().toISOString(),
    accepted,
  };
  const recentRuns = recentSuccessfulRuns(currentStats, recentStatsFiles);
  const acceptedPerDay = recentRuns.reduce((total, run) => total + (Number(run.accepted) || 0), 0);
  const selected = sum('selected');
  return {
    throughputSchemaVersion: 2,
    runId: currentStats.runId,
    completedAt: currentStats.completedAt,
    effectiveShards: Number(plan?.effectiveShards) || stats.length,
    eventsPerShard: Number(plan?.eventsPerShard) || 0,
    quotaErrorThreshold: Number(plan?.quotaErrorThreshold) || 0,
    direction: plan?.direction || '',
    planReason: plan?.reason || '',
    shardCount: stats.length,
    selected,
    accepted,
    rejected: sum('rejected'),
    calls: sum('calls'),
    attempts: sum('attempts'),
    eventAttempts: sum('eventAttempts'),
    retries: sum('retries'),
    quotaErrors: sum('quotaErrors'),
    timeoutErrors: sum('timeoutErrors'),
    brokerErrors: sum('brokerErrors'),
    circuitBreakerTrips: sum('circuitBreakerTrips'),
    transportFailures: sum('transportFailures'),
    inputChars: sum('inputChars'),
    outputChars: sum('outputChars'),
    inputBudgetSkipped: sum('inputBudgetSkipped'),
    elapsedMs: sum('elapsedMs'),
    observedElapsedMs: sum('observedElapsedMs'),
    durationMs,
    backoffMs: sum('backoffMs'),
    acceptedByModel: sum('acceptedByModel'),
    acceptedByFallback: sum('acceptedByFallback'),
    eventAttemptsPerSelected: Number((sum('eventAttempts') / Math.max(selected, 1)).toFixed(2)),
    eventAttemptsPerAccepted: Number((sum('eventAttempts') / Math.max(accepted, 1)).toFixed(2)),
    observedMsPerAccepted: Number((sum('observedElapsedMs') / Math.max(accepted, 1)).toFixed(1)),
    selectedNeverAttempted: sum('selectedNeverAttempted'),
    selectedRetries: sum('selectedRetries'),
    acceptedNeverAttempted: sum('acceptedNeverAttempted'),
    acceptedRetries: sum('acceptedRetries'),
    rejectedNeverAttempted: sum('rejectedNeverAttempted'),
    rejectedRetries: sum('rejectedRetries'),
    parkedFallbackCandidates: sum('parkedFallbackCandidates'),
    parkedUnchanged: sum('parkedUnchanged'),
    toAttempt: queueState.toAttempt,
    neverAttempted: queueState.neverAttempted,
    retryable: queueState.retryable,
    waitingRetry: queueState.waitingRetry,
    parked: queueState.parked,
    queueRemaining: queueState.workable,
    acceptedPerDay,
    recentSuccessfulRuns: recentRuns.length,
    estimatedDaysRemaining: acceptedPerDay > 0 ? Number((queueState.workable / acceptedPerDay).toFixed(2)) : null,
    rejectionCodes: mergeCounterMaps(stats, 'rejectionCodes'),
    rejectionDetails: mergeCounterMaps(stats, 'rejectionDetails'),
    shards: stats.map((shard) => ({
      shardIndex: shard.shardIndex,
      selected: shard.selected,
      accepted: shard.accepted,
      rejected: shard.rejected,
      calls: shard.calls,
      retries: shard.retries,
      quotaErrors: shard.quotaErrors,
      timeoutErrors: shard.timeoutErrors,
      brokerErrors: shard.brokerErrors,
      circuitBreakerTrips: shard.circuitBreakerTrips,
      circuitOpen: shard.circuitOpen,
      circuitReason: shard.circuitReason,
      durationMs: shard.durationMs,
    })),
  };
}

const basePath = path.resolve(argument('--base', 'data/events-description-rewrites.json'));
const shardDir = path.resolve(argument('--shards-dir', '.event-description-shards'));
const outputPath = path.resolve(argument('--output', basePath));
const statsOutput = argument('--stats-output');
const datasetPath = path.resolve(argument('--dataset', 'data/events.json'));
const planPath = argument('--plan');
const recentStatsDirArgument = argument('--recent-stats-dir');
const recentStatsDir = recentStatsDirArgument ? path.resolve(recentStatsDirArgument) : '';

const baseCache = loadEventDescriptionRewriteCache(basePath);
const shardCacheFiles = findFiles(shardDir, 'cache.json');
const shardStatsFiles = findFiles(shardDir, 'stats.json');
const shardCaches = shardCacheFiles.map((file) => readJson(file, { entries: {} }));
const merged = mergeRewriteCaches(baseCache, shardCaches);
const output = {
  schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  rejectionMemorySchemaVersion: REJECTION_MEMORY_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  model: EVENT_DESCRIPTION_REWRITE_MODEL,
  promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
  policyVersion: EVENT_DESCRIPTION_POLICY_VERSION,
  entries: merged.entries,
  rejections: merged.rejections,
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });

const plan = planPath ? readJson(planPath, {}) : {};
const recentStatsFiles = recentStatsDir ? findFiles(recentStatsDir, 'event-description-rewrite-stats.json') : [];
const stats = mergeStats(shardStatsFiles, plan, output, datasetPath, recentStatsFiles);
stats.cacheMerge = merged.mergeStats;
stats.shardArtifacts = shardCacheFiles.length;
stats.cacheChanged = JSON.stringify(stableValue({
  entries: baseCache.entries || {},
  rejections: baseCache.rejections || {},
})) !== JSON.stringify(stableValue({
  entries: output.entries || {},
  rejections: output.rejections || {},
}));
if (statsOutput) {
  writeFileSync(path.resolve(statsOutput), `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(stats));
