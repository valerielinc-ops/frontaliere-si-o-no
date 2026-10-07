#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, loadEventDescriptionRewriteCache } from './lib/event-description-policy.mjs';
import {
  countPendingEvents,
  mergeRewriteCaches,
  readJsonFile,
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

function mergeStats(statsFiles, plan, mergedCache, datasetPath) {
  const stats = statsFiles.map((file) => readJson(file, {})).filter(Boolean);
  const sum = (key) => stats.reduce((total, shard) => total + (Number(shard[key]) || 0), 0);
  const durationMs = stats.reduce((max, shard) => Math.max(max, Number(shard.durationMs) || 0), 0);
  const dataset = readJson(datasetPath, { events: [] });
  const queueRemaining = countPendingEvents(dataset, mergedCache);
  const accepted = sum('accepted');
  const acceptedPerDay = accepted * 24;
  return {
    throughputSchemaVersion: 1,
    runId: process.env.GITHUB_RUN_ID || '',
    effectiveShards: Number(plan?.effectiveShards) || stats.length,
    eventsPerShard: Number(plan?.eventsPerShard) || 0,
    quotaErrorThreshold: Number(plan?.quotaErrorThreshold) || 0,
    direction: plan?.direction || '',
    planReason: plan?.reason || '',
    shardCount: stats.length,
    selected: sum('selected'),
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
    eventAttemptsPerSelected: Number((sum('eventAttempts') / Math.max(sum('selected'), 1)).toFixed(2)),
    eventAttemptsPerAccepted: Number((sum('eventAttempts') / Math.max(accepted, 1)).toFixed(2)),
    observedMsPerAccepted: Number((sum('observedElapsedMs') / Math.max(accepted, 1)).toFixed(1)),
    queueRemaining,
    acceptedPerDay,
    estimatedDaysRemaining: acceptedPerDay > 0 ? Number((queueRemaining / acceptedPerDay).toFixed(2)) : null,
    rejectionCodes: stats.reduce((all, shard) => {
      for (const [code, count] of Object.entries(shard.rejectionCodes || {})) all[code] = (all[code] || 0) + (Number(count) || 0);
      return all;
    }, {}),
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

const baseCache = loadEventDescriptionRewriteCache(basePath);
const shardCacheFiles = findFiles(shardDir, 'cache.json');
const shardStatsFiles = findFiles(shardDir, 'stats.json');
const shardCaches = shardCacheFiles.map((file) => readJson(file, { entries: {} }));
const merged = mergeRewriteCaches(baseCache, shardCaches);
const output = {
  schemaVersion: merged.schemaVersion ?? EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  model: merged.model,
  promptVersion: merged.promptVersion,
  entries: merged.entries,
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });

const plan = planPath ? readJson(planPath, {}) : {};
const stats = mergeStats(shardStatsFiles, plan, output, datasetPath);
stats.cacheMerge = merged.mergeStats;
stats.shardArtifacts = shardCacheFiles.length;
if (statsOutput) {
  writeFileSync(path.resolve(statsOutput), `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(stats));
