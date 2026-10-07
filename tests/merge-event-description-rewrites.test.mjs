import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceDescriptionHash, rewriteCacheKey, EVENT_DESCRIPTION_PROMPT_VERSION, EVENT_DESCRIPTION_REWRITE_MODEL } from '../scripts/lib/event-description-policy.mjs';
import { recordRejectionMemory } from '../scripts/lib/event-description-throughput.mjs';

test('merge computes the estimate from successful runs in the last 24 hours', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'event-description-merge-test-'));
  try {
    const source = { description: 'Synthetic private source text for the merge test.' };
    const hashes = Array.from({ length: 3 }, (_, index) => sourceDescriptionHash({ description: `${source.description} ${index}` }));
    const dataset = { events: hashes.map((hash, index) => ({ id: `synthetic-${index}`, sourceDescriptionHash: hash })) };
    const acceptedKey = rewriteCacheKey('synthetic-0', hashes[0]);
    const accepted = {
      id: 'synthetic-0',
      sourceDescriptionHash: hashes[0],
      description: 'L\'evento presenta informazioni organizzative. La scheda riporta i dati disponibili.',
      descriptionByLocale: {
        it: 'L\'evento presenta informazioni organizzative. La scheda riporta i dati disponibili.',
        en: 'The event presents organisational information. The listing reports the available data.',
        de: 'Die Veranstaltung enthält organisatorische Informationen. Der Eintrag nennt die verfügbaren Daten.',
        fr: 'L’événement présente des informations organisationnelles. La fiche indique les données disponibles.',
      },
      model: EVENT_DESCRIPTION_REWRITE_MODEL,
      promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
      rewrittenAt: new Date().toISOString(),
    };
    const rejectionMemory = {};
    recordRejectionMemory(rejectionMemory, { id: 'synthetic-1', sourceDescriptionHash: hashes[1] }, 'new-name', { now: new Date() });
    const cache = { schemaVersion: 1, entries: {}, rejections: {} };
    const shardDir = path.join(root, 'shards', '0');
    const recentDir = path.join(root, 'recent', 'old');
    const output = path.join(root, 'cache.json');
    const statsOutput = path.join(root, 'stats.json');
    const datasetPath = path.join(root, 'events.json');
    const planPath = path.join(root, 'plan.json');
    mkdirSync(shardDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });
    writeFileSync(datasetPath, `${JSON.stringify(dataset)}\n`);
    writeFileSync(path.join(root, 'base.json'), `${JSON.stringify(cache)}\n`);
    writeFileSync(path.join(shardDir, 'cache.json'), `${JSON.stringify({ entries: { [acceptedKey]: accepted }, rejections: rejectionMemory })}\n`);
    writeFileSync(path.join(shardDir, 'stats.json'), `${JSON.stringify({ shardIndex: 0, selected: 2, accepted: 1, rejected: 1, eventAttempts: 2, observedElapsedMs: 10, rejectionCodes: { 'new-name': 1 }, rejectionDetails: {} })}\n`);
    writeFileSync(path.join(recentDir, 'event-description-rewrite-stats.json'), `${JSON.stringify({ runId: 'old-run', completedAt: new Date().toISOString(), accepted: 10 })}\n`);
    writeFileSync(planPath, JSON.stringify({ effectiveShards: 1, eventsPerShard: 2 }));

    const result = JSON.parse(execFileSync('node', [
      'scripts/merge-event-description-rewrites.mjs',
      '--base', path.join(root, 'base.json'),
      '--shards-dir', path.join(root, 'shards'),
      '--output', output,
      '--dataset', datasetPath,
      '--plan', planPath,
      '--recent-stats-dir', path.join(root, 'recent'),
      '--stats-output', statsOutput,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_RUN_ID: 'current-run' },
      encoding: 'utf8',
    }));
    assert.equal(result.acceptedPerDay, 11);
    assert.equal(result.recentSuccessfulRuns, 2);
    assert.equal(result.toAttempt, 1);
    assert.equal(result.waitingRetry, 1);
    assert.equal(result.queueRemaining, 2);
    assert.equal(result.cacheChanged, true);
    assert.equal(JSON.parse(readFileSync(statsOutput, 'utf8')).estimatedDaysRemaining, 0.18);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
