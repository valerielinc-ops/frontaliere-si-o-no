#!/usr/bin/env node
/**
 * Reproducible local benchmark for the Argos mop-up semantic write boundary.
 *
 * The default embedder is intentionally replaced by a deterministic fake with
 * a fixed delay. This keeps the benchmark runnable on machines that cannot
 * download or execute multilingual-e5-small, while preserving the judge's
 * cache and batching call shape. Run once without --prewarm for the baseline
 * and once with --prewarm after the batch path is available.
 *
 *   node scripts/research/local-mt-semantic-judge-bench.mjs \
 *     --n 500 --latency-ms 5 --batch-size 64
 *   node scripts/research/local-mt-semantic-judge-bench.mjs \
 *     --n 500 --latency-ms 5 --batch-size 64 --prewarm --profile
 *   node scripts/research/local-mt-semantic-judge-bench.mjs \
 *     --n 600 --unique-sources --cache-max 1024 --latency-ms 0 \
 *     --batch-size 64 --prewarm
 *
 * `--prewarm-all` is a regression comparator for the former all-at-once path;
 * production uses `--prewarm`, which consumes each cache-fitting block before
 * warming the next one.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  classifyMopupStructure,
  semanticCandidateBlocks,
} from '../local-mt-mopup.mjs';
import { titleLooksUntranslated } from '../lib/job-locale-utils.mjs';
import {
  createLocalMtSemanticJudge,
  DEFAULT_LOCAL_MT_SEMANTIC_PREWARM_BATCH_SIZE,
} from '../lib/local-mt-semantic-judge.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vectorFor(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const delta = ((hash >>> 0) % 17) / 1000;
  return [1, delta, delta / 2, delta / 3];
}

function makePairs(n, uniqueSources) {
  return Array.from({ length: n }, (_, index) => ({
    sourceText: `Source phrase ${uniqueSources ? index : index % 50}`,
    candidateText: `Translated candidate ${index}`,
  }));
}

function fakeEmbedder({ latencyMs, calls }) {
  return async ({ inputs, prefix }) => {
    calls.push({ count: inputs.length, prefix });
    await sleep(latencyMs);
    return inputs.map(vectorFor);
  };
}

function fingerprint(verdicts) {
  const sequence = verdicts
    .map(({ accepted, score, reason }) => `${accepted ? '1' : '0'}:${score?.toFixed(8) ?? 'null'}:${reason}`)
    .join('|');
  return crypto.createHash('sha256').update(sequence).digest('hex');
}

function batchShape(calls) {
  return calls.reduce((shape, { count }) => {
    const key = String(count);
    shape[key] = (shape[key] || 0) + 1;
    return shape;
  }, {});
}

async function runJudge({ pairs, latencyMs, batchSize, cacheMax, prewarmMode }) {
  const calls = [];
  const judge = createLocalMtSemanticJudge({
    embed: fakeEmbedder({ latencyMs, calls }),
    threshold: 0.8,
    cacheMax,
  });
  const started = performance.now();
  let prewarmMs = 0;
  const verdicts = [];
  const blocks = prewarmMode === 'blocks'
    ? semanticCandidateBlocks(pairs, cacheMax)
    : [pairs];
  for (const block of blocks) {
    if (prewarmMode !== 'none') {
      const warmupStarted = performance.now();
      await judge.prewarm(
        block.flatMap(({ sourceText, candidateText }) => [sourceText, candidateText]),
        { batchSize },
      );
      prewarmMs += performance.now() - warmupStarted;
    }
    for (const pair of block) verdicts.push(await judge(pair));
  }
  const judgeMs = performance.now() - started - prewarmMs;
  return {
    totalMs: performance.now() - started,
    prewarmMs,
    judgeMs,
    calls,
    inputCount: calls.reduce((sum, call) => sum + call.count, 0),
    candidateBlocks: prewarmMode === 'blocks' ? blocks.length : 1,
    verdicts,
    fingerprint: fingerprint(verdicts),
  };
}

function profileGuardsAndIo(n) {
  const job = {
    sourceLang: 'de',
    title: 'Source phrase',
    titleByLocale: {},
    descriptionByLocale: {},
  };
  const structuralStarted = performance.now();
  let writes = 0;
  for (let index = 0; index < n; index++) {
    const result = classifyMopupStructure({
      job,
      locale: 'it',
      field: 'title',
      rawText: `Candidato italiano ${index}`,
    });
    if (result.decision === 'write') writes++;
  }
  const structuralMs = performance.now() - structuralStarted;

  const titleStarted = performance.now();
  for (let index = 0; index < n; index++) {
    titleLooksUntranslated({
      title: `Candidato italiano ${index}`,
      sourceLang: 'de',
      targetLocale: 'it',
    });
  }
  const titleMs = performance.now() - titleStarted;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mt-judge-bench-'));
  const payload = JSON.stringify({ jobs: Array.from({ length: 10 }, (_, index) => ({ id: index, title: 'fixture' })) });
  const files = Array.from({ length: Math.max(1, Math.ceil(n / 10)) }, (_, index) => path.join(tempDir, `${index}.json`));
  for (const file of files) fs.writeFileSync(file, payload, 'utf8');
  const readStarted = performance.now();
  for (const file of files) JSON.parse(fs.readFileSync(file, 'utf8'));
  const readMs = performance.now() - readStarted;
  const writeStarted = performance.now();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.jobs[0].title = 'updated';
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  }
  const writeMs = performance.now() - writeStarted;
  fs.rmSync(tempDir, { recursive: true, force: true });

  return { structuralMs, writes, titleMs, readMs, writeMs, files: files.length };
}

async function main() {
  const n = Math.max(500, Number(option('--n', '500')) || 500);
  const latencyMs = Math.max(0, Number(option('--latency-ms', '5')) || 0);
  const batchSize = Math.max(
    1,
    Number(option('--batch-size', String(DEFAULT_LOCAL_MT_SEMANTIC_PREWARM_BATCH_SIZE)))
      || DEFAULT_LOCAL_MT_SEMANTIC_PREWARM_BATCH_SIZE,
  );
  const cacheMax = Math.max(1, Number(option('--cache-max', '1024')) || 1024);
  const uniqueSources = hasFlag('--unique-sources');
  const prewarmMode = hasFlag('--prewarm-all') ? 'all' : hasFlag('--prewarm') ? 'blocks' : 'none';
  const pairs = makePairs(n, uniqueSources);
  const profile = hasFlag('--profile') ? profileGuardsAndIo(n) : null;
  const result = await runJudge({
    pairs,
    latencyMs,
    batchSize,
    cacheMax,
    prewarmMode,
  });
  const output = {
    mode: prewarmMode === 'blocks' ? 'prewarm' : prewarmMode === 'all' ? 'prewarm-all' : 'baseline',
    n,
    uniqueSources,
    latencyMs,
    batchSize,
    cacheMax,
    candidateBlocks: result.candidateBlocks,
    totalMs: Number(result.totalMs.toFixed(2)),
    prewarmMs: Number(result.prewarmMs.toFixed(2)),
    judgeMs: Number(result.judgeMs.toFixed(2)),
    embedCalls: result.calls.length,
    embeddedInputs: result.inputCount,
    singleTextEmbeds: result.calls.filter(({ count }) => count === 1).length,
    batchShape: batchShape(result.calls),
    verdictFingerprint: result.fingerprint,
  };
  if (profile) output.profile = profile;
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
