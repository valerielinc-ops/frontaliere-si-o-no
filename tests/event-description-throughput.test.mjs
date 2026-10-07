import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  adaptThroughput,
  DEFAULT_EVENTS_PER_SHARD,
  DEFAULT_SHARD_COUNT,
  classifyCodexFailure,
  exponentialBackoffMs,
  mergeRewriteCaches,
  partitionQueue,
  selectShardQueue,
} from '../scripts/lib/event-description-throughput.mjs';

const workflow = readFileSync(path.join(process.cwd(), '.github/workflows/event-description-rewrite.yml'), 'utf8');

test('workflow data PR body writes actual newlines', () => {
  assert.match(workflow, /\]\.join\("\\n"\);/u);
  assert.doesNotMatch(workflow, /\]\.join\("\\\\n"\);/u);
});

test('workflow publishes the site data PR with the site write credential', () => {
  assert.match(workflow, /\$\{GITHUB_PAT:\?GITHUB_PAT was not loaded from Remote Config\}/u);
  assert.match(workflow, /GH_TOKEN="\$GITHUB_PAT" bash scripts\/lib\/open-data-refresh-pr\.sh/u);
  assert.doesNotMatch(workflow, /GITHUB_PAT_NANAKO/u);
});

test('workflow defaults stay linked to the planner defaults', () => {
  assert.match(workflow, new RegExp(`default: '${DEFAULT_SHARD_COUNT}'`));
  assert.match(workflow, new RegExp(`default: '${DEFAULT_EVENTS_PER_SHARD}'`));
  assert.match(workflow, /cron: '0 \* \* \* \*'/u);
});

test('planner emits every workflow output without replacing existing step outputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'event-description-plan-'));
  const outputPath = path.join(root, 'github-output');
  writeFileSync(outputPath, 'existing=kept\n');

  const stdout = execFileSync(process.execPath, [
    path.join(process.cwd(), 'scripts/plan-event-description-rewrite.mjs'),
    '--requested-shards', String(DEFAULT_SHARD_COUNT),
    '--requested-events-per-shard', String(DEFAULT_EVENTS_PER_SHARD),
    '--github-output', outputPath,
  ], { encoding: 'utf8' });
  const plan = JSON.parse(stdout);
  const outputs = Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

  assert.deepEqual(outputs, {
    existing: 'kept',
    effective_shards: String(plan.effectiveShards),
    events_per_shard: String(plan.eventsPerShard),
    quota_error_threshold: String(plan.quotaErrorThreshold),
    circuit_breaker_threshold: String(plan.circuitBreakerThreshold),
    shard_matrix: JSON.stringify(plan.shardMatrix),
    direction: plan.direction,
    reason: plan.reason,
  });
});

test('hash partition is deterministic, disjoint and exhaustive', () => {
  const queue = Array.from({ length: 97 }, (_, index) => ({ id: `event-${index}` }));
  const first = partitionQueue(queue, 4);
  const second = partitionQueue(queue, 4);
  assert.deepEqual(first, second);

  const memberships = new Map();
  for (const [shardIndex, shard] of first.entries()) {
    for (const record of shard) {
      assert.equal(memberships.has(record.id), false, `duplicate ${record.id}`);
      memberships.set(record.id, shardIndex);
    }
  }
  assert.deepEqual([...memberships.keys()].sort(), queue.map((record) => record.id).sort());
  assert.deepEqual(selectShardQueue(queue, { shardCount: 4, shardIndex: 2, limit: 3 }), first[2].slice(0, 3));
});

test('cache merge is idempotent and stable when shard artifacts overlap', () => {
  const base = { schemaVersion: 1, entries: { base: { id: 'base', value: 'main' } } };
  const shards = [
    { entries: { one: { id: 'one' }, duplicate: { id: 'duplicate', value: 'z' } } },
    { entries: { two: { id: 'two' }, duplicate: { id: 'duplicate', value: 'a' } } },
  ];
  const merged = mergeRewriteCaches(base, shards);
  const repeated = mergeRewriteCaches(merged, shards);
  assert.deepEqual(repeated.entries, merged.entries);
  assert.equal(merged.entries.base.value, 'main');
  assert.equal(merged.entries.duplicate.value, 'a');
});

test('quota state steps down, holds below threshold, and ramps up without errors', () => {
  assert.deepEqual(adaptThroughput({ requestedShards: 3, requestedEventsPerShard: 40 }), {
    shards: 3,
    eventsPerShard: 40,
    direction: 'default',
    reason: 'no-previous-run-state',
  });
  assert.deepEqual(adaptThroughput({
    requestedShards: 4,
    requestedEventsPerShard: 40,
    previousState: { effectiveShards: 3, eventsPerShard: 40, quotaErrors: 2 },
  }), {
    shards: 2,
    eventsPerShard: 32,
    direction: 'down',
    reason: 'previous-run-quota-errors-2',
  });
  assert.deepEqual(adaptThroughput({
    requestedShards: 4,
    requestedEventsPerShard: 40,
    previousState: { effectiveShards: 3, eventsPerShard: 40, quotaErrors: 1 },
  }).direction, 'hold');
  assert.deepEqual(adaptThroughput({
    requestedShards: 4,
    requestedEventsPerShard: 40,
    previousState: { effectiveShards: 2, eventsPerShard: 32, quotaErrors: 0 },
  }), {
    shards: 3,
    eventsPerShard: 40,
    direction: 'up',
    reason: 'previous-run-without-quota-errors',
  });
});

test('broker failure classification drives exponential backoff', () => {
  assert.equal(classifyCodexFailure(new Error('HTTP 429 rate limit exceeded')), 'quota');
  assert.equal(classifyCodexFailure(new Error('Codex auth broker execution timed out')), 'timeout');
  assert.equal(classifyCodexFailure(new Error('Codex auth broker temporarily unavailable')), 'transport');
  assert.equal(exponentialBackoffMs(1, 100, 350), 100);
  assert.equal(exponentialBackoffMs(2, 100, 350), 200);
  assert.equal(exponentialBackoffMs(3, 100, 350), 350);
});
