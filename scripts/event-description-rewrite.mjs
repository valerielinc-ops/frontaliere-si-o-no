#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
  EVENT_DESCRIPTION_LOCALES,
  EVENT_DESCRIPTION_POLICY_VERSION,
  EVENT_DESCRIPTION_PROMPT_VERSION,
  EVENT_DESCRIPTION_REWRITE_MODEL,
  factsForPrompt,
  isValidRewriteCacheEntry,
  loadEventDescriptionRewriteCache,
  rewriteCacheKey,
  sourceDescriptionHash,
  validateRewriteBundle,
} from './lib/event-description-policy.mjs';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_SHARD_COUNT,
  REJECTION_MEMORY_SCHEMA_VERSION,
  QUOTA_BACKOFF_BASE_MS,
  QUOTA_BACKOFF_MAX_MS,
  QUOTA_ERROR_THRESHOLD,
  classifyCodexFailure,
  compareQueueAttemptPriority,
  emptyRewriteStats,
  exponentialBackoffMs,
  isCircuitBreakerFailure,
  normalizeShardCount,
  recordRejectionMemory,
  queueStateForEvent,
  selectShardQueue,
  summarizeRewriteQueue,
} from './lib/event-description-throughput.mjs';
import {
  buildMinimalRewriteDescriptions,
  meetsPoorSourceWordFloor,
} from './lib/event-description-fallback.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_DATASET = path.join(REPO_ROOT, 'data', 'events.json');
const DEFAULT_CACHE = path.join(REPO_ROOT, 'data', 'events-description-rewrites.json');
const DEFAULT_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_MAX_INPUT_CHARS = 60_000;
const DEFAULT_MAX_TOTAL_INPUT_CHARS = 1_000_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rewrites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          it: { type: 'string' },
          en: { type: 'string' },
          de: { type: 'string' },
          fr: { type: 'string' },
        },
        required: ['id', 'it', 'en', 'de', 'fr'],
      },
    },
  },
  required: ['rewrites'],
};

const HELP = `Usage: node scripts/event-description-rewrite.mjs [options]

Options:
  --source-export PATH       Private JSON/JSONL source export (required)
  --dataset PATH             Assembled events dataset (default: data/events.json)
  --cache PATH               Rewrite cache (default: data/events-description-rewrites.json)
  --limit N                  Maximum events selected for this run (default: 100)
  --days N                   Restrict selection to the next N days; 0 means all
  --batch-size N             Events per Codex call (default: 4)
  --max-input-chars N        Prompt input cap per call (default: 60000)
  --max-total-input-chars N  Prompt input cap for the complete run (default: 1000000)
  --max-attempts N           Calls per invalid batch/item (default: 3)
  --timeout-ms N             Timeout per Codex call in milliseconds (default: 120000)
  --shard-count N            Number of deterministic queue shards (default: 1)
  --shard-index N            Zero-based shard index (default: 0)
  --circuit-breaker-threshold N  Transient broker errors before this shard stops (default: 2)
  --quota-backoff-base-ms N  First quota/timeout backoff in milliseconds (default: 15000)
  --quota-backoff-max-ms N   Maximum quota/timeout backoff in milliseconds (default: 120000)
  --output-cache PATH        Write only this shard's accepted cache entries
  --stats-output PATH        Write aggregate stats JSON without source text
  --dry-run                  Select and report, but do not call Codex or write cache
  --empty                    Write an empty shard result without a source export
`;

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
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const empty = argv.includes('--empty');
  const sourceExport = optionValue(argv, '--source-export');
  if (!sourceExport && !empty) throw new Error('--source-export is required');
  const shardCount = normalizeShardCount(optionValue(argv, '--shard-count', DEFAULT_SHARD_COUNT));
  const shardIndex = numberOption(argv, '--shard-index', 0, { min: 0, max: shardCount - 1 });
  return {
    sourceExport: sourceExport ? path.resolve(sourceExport) : '',
    dataset: path.resolve(optionValue(argv, '--dataset', DEFAULT_DATASET)),
    cache: path.resolve(optionValue(argv, '--cache', DEFAULT_CACHE)),
    limit: numberOption(argv, '--limit', DEFAULT_LIMIT, { min: 1, max: 10_000 }),
    days: numberOption(argv, '--days', 0, { min: 0, max: 3_650 }),
    batchSize: numberOption(argv, '--batch-size', DEFAULT_BATCH_SIZE, { min: 1, max: 50 }),
    maxInputChars: numberOption(argv, '--max-input-chars', DEFAULT_MAX_INPUT_CHARS, { min: 10_000, max: 500_000 }),
    maxTotalInputChars: numberOption(argv, '--max-total-input-chars', DEFAULT_MAX_TOTAL_INPUT_CHARS, { min: 50_000, max: 10_000_000 }),
    maxAttempts: numberOption(argv, '--max-attempts', DEFAULT_MAX_ATTEMPTS, { min: 1, max: 5 }),
    timeoutMs: numberOption(argv, '--timeout-ms', DEFAULT_TIMEOUT_MS, { min: 30_000, max: 600_000 }),
    shardCount,
    shardIndex,
    circuitBreakerThreshold: numberOption(argv, '--circuit-breaker-threshold', CIRCUIT_BREAKER_THRESHOLD, { min: 1, max: 10 }),
    quotaBackoffBaseMs: numberOption(argv, '--quota-backoff-base-ms', QUOTA_BACKOFF_BASE_MS, { min: 0, max: 600_000 }),
    quotaBackoffMaxMs: numberOption(argv, '--quota-backoff-max-ms', QUOTA_BACKOFF_MAX_MS, { min: 0, max: 1_800_000 }),
    outputCache: optionValue(argv, '--output-cache', undefined),
    statsOutput: optionValue(argv, '--stats-output', undefined),
    dryRun: argv.includes('--dry-run'),
    empty,
  };
}

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

function loadSourceRecords(pathname) {
  const raw = readFileSync(pathname, 'utf8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.records)) return parsed.records;
    return [parsed];
  } catch {
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

function sourceTexts(record) {
  return [
    ...Object.values(record.sourceDescriptionByLocale || {}),
    record.sourceDescription,
  ].filter((value) => typeof value === 'string' && value.trim());
}

function sourceHashForRecord(record) {
  if (typeof record.sourceDescriptionHash === 'string' && record.sourceDescriptionHash) return record.sourceDescriptionHash;
  return sourceDescriptionHash({
    description: record.sourceDescription,
    descriptionByLocale: record.sourceDescriptionByLocale,
  });
}

function sourceFacts(record, currentEvent) {
  return currentEvent ? factsForPrompt(currentEvent) : (record.facts || {});
}

function compareDate(a, b) {
  const left = a.startDate || '9999-99-99';
  const right = b.startDate || '9999-99-99';
  return left.localeCompare(right) || String(a.id).localeCompare(String(b.id));
}

const CANTON_PRIORITY = new Map([['TI', 0], ['GR', 1], ['VS', 2], ['ZH', 3]]);

function priorityCompare(a, b) {
  const now = new Date().toISOString().slice(0, 10);
  const aPast = a.startDate < now;
  const bPast = b.startDate < now;
  if (aPast !== bPast) return Number(aPast) - Number(bPast);
  const todayMs = Date.parse(`${now}T00:00:00Z`);
  const aDistance = Math.abs((Date.parse(`${a.startDate}T00:00:00Z`) || todayMs) - todayMs);
  const bDistance = Math.abs((Date.parse(`${b.startDate}T00:00:00Z`) || todayMs) - todayMs);
  if (aDistance !== bDistance) return aDistance - bDistance;
  const cantonDiff = (CANTON_PRIORITY.get(String(a.canton || '').toUpperCase()) ?? 4)
    - (CANTON_PRIORITY.get(String(b.canton || '').toUpperCase()) ?? 4);
  if (cantonDiff !== 0) return cantonDiff;
  return compareDate(a, b);
}

function withinDays(startDate, days) {
  if (!days) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  const date = new Date(`${startDate}T00:00:00`);
  return Number.isFinite(date.getTime()) && date >= today && date <= end;
}

function factsContext(facts) {
  return Object.values(facts || {}).flatMap((value) => {
    if (value === null || value === undefined) return [];
    if (typeof value === 'object') return [JSON.stringify(value)];
    return [String(value)];
  });
}

const POOR_SOURCE_MAX_WORDS = 7;
const POOR_SOURCE_MAX_CHARS = 60;
const POOR_SOURCE_MIN_WORDS = 50;

function isPoorSource(sourceTextsForRecord) {
  const richest = (sourceTextsForRecord || []).reduce((best, value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > best.length ? text : best;
  }, '');
  const words = richest ? richest.split(/\s+/u).filter(Boolean).length : 0;
  return words <= POOR_SOURCE_MAX_WORDS || richest.length < POOR_SOURCE_MAX_CHARS;
}

function buildBatchPrompt(batch, retryReasons = new Map()) {
  const records = batch.map((record) => ({
    id: record.id,
    facts: record.facts,
    sourceDescriptions: record.sourceDescriptionByLocale || (record.sourceDescription ? { source: record.sourceDescription } : {}),
    sourceQuality: record.sourceQuality,
    retry: retryReasons.get(record.id) || undefined,
  }));
  return [
    `You are Codex Luna Max (${EVENT_DESCRIPTION_REWRITE_MODEL}) rewriting event descriptions. Prompt version: ${EVENT_DESCRIPTION_PROMPT_VERSION}.`,
    'Return exactly the JSON object required by the supplied schema.',
    'For every input id, return it, en, de and fr. Each value must contain 2 or 3 original, neutral, informative sentences.',
    'Use only facts present in the supplied event facts or source descriptions. Structured fields (title, venue, municipality, canton, region, organiser, performer, date, time and price) are authoritative and may be expressed in the target language with equivalent spelling, inflection or date/number format. Do not add names, dates, times, prices, places, performers or organisers that are not present there.',
    'Do not copy any sequence of eight consecutive normalized words from any source description. Dates, times, prices and full addresses are already shown as factual metadata: normally omit them from the prose, especially day/date/time combinations. Never reproduce a long event title verbatim; if the title itself is long, refer to the event generically (for example “l’appuntamento”, “the concert”, “die Veranstaltung” or “le rendez-vous”). Paraphrase the facts; never translate by sentence substitution.',
    'Do not use promotional superlatives, calls to action, invented context, citations, Markdown, HTML, bullet lists or labels.',
    'On a retry for source-ngram-8, change the wording and sentence structure completely, omit dates/times/addresses and long title fragments, and use only broad factual statements. On a retry for new-name, keep proper names only when they occur in the supplied facts or source context, or use an obvious translation/inflection of a structured place or venue. On a retry for sentence-count, return exactly two complete sentences per language. For sourceQuality=poor, write an event-specific factual description of at least 50 words in each locale using at least two structured fields; if the structured context is insufficient, do not pad with generic prose because the result will be rejected.',
    'The source descriptions are private inputs. They must not be returned, quoted or mentioned.',
    JSON.stringify({ events: records }),
  ].join('\n\n');
}

function schemaFile(dir) {
  const file = path.join(dir, 'output-schema.json');
  writeFileSync(file, `${JSON.stringify(OUTPUT_SCHEMA)}\n`, { mode: 0o600 });
  return file;
}

function runProcess(command, args, { input, timeoutMs, cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      if (!settled) {
        settled = true;
        reject(new Error('codex-timeout'));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error('codex-process-failed'));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function requestDirectCodex(prompt, timeoutMs) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'event-description-rewrite-'));
  const outputPath = path.join(tempDir, 'last-message.json');
  try {
    const schemaPath = schemaFile(tempDir);
    const directEnv = { ...process.env };
    delete directEnv.CODEX_AUTH_JSON;
    const stdout = await runProcess(
      process.env.CODEX_BIN || 'codex',
      [
        'exec',
        '--ephemeral',
        '--strict-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--cd', tempDir,
        '--model', EVENT_DESCRIPTION_REWRITE_MODEL,
        '-c', 'model_reasoning_effort="max"',
        '--output-last-message', outputPath,
        '--output-schema', schemaPath,
        '-',
      ],
      { input: prompt, timeoutMs, cwd: tempDir, env: directEnv },
    );
    const output = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : stdout;
    return JSON.parse(output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function requestCodex(prompt, timeoutMs) {
  if (process.env.CODEX_AUTH_BROKER_SOCKET) {
    const { requestCodexBrokerJson } = await import('./lib/ai-models.mjs');
    return requestCodexBrokerJson({ prompt, schema: OUTPUT_SCHEMA, timeoutMs });
  }
  return requestDirectCodex(prompt, timeoutMs);
}

function normalizeModelResult(result) {
  const rows = Array.isArray(result?.rewrites) ? result.rewrites : [];
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || byId.has(row.id)) continue;
    byId.set(row.id, Object.fromEntries(EVENT_DESCRIPTION_LOCALES.map((locale) => [locale, row[locale]])));
  }
  return byId;
}

function writeCache(cachePath, cache) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  const orderedEntries = Object.fromEntries(Object.entries(cache.entries || {}).sort(([left], [right]) => left.localeCompare(right)));
  const orderedRejections = Object.fromEntries(Object.entries(cache.rejections || {}).sort(([left], [right]) => left.localeCompare(right)));
  const output = {
    schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION,
    rejectionMemorySchemaVersion: REJECTION_MEMORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    model: EVENT_DESCRIPTION_REWRITE_MODEL,
    promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
    policyVersion: EVENT_DESCRIPTION_POLICY_VERSION,
    entries: orderedEntries,
    rejections: orderedRejections,
  };
  writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, cachePath);
  return output;
}

function makeCacheEntry(record, descriptions) {
  const now = new Date().toISOString();
  return {
    id: record.id,
    sourceDescriptionHash: record.sourceDescriptionHash,
    description: descriptions.it,
    descriptionByLocale: descriptions,
    model: EVENT_DESCRIPTION_REWRITE_MODEL,
    promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
    rewrittenAt: now,
  };
}

function selectQueue(records, dataset, cache, options) {
  const currentById = new Map((dataset.events || []).map((event) => [event.id, event]));
  const queueState = summarizeRewriteQueue(dataset, cache);
  const seen = new Set();
  const queue = [];
  const parkedQueue = [];
  for (const record of records) {
    if (!record?.id) continue;
    const current = currentById.get(record.id);
    const hash = sourceHashForRecord(record);
    if (!current || !hash) continue;
    const recordKey = rewriteCacheKey(record.id, hash);
    if (seen.has(recordKey)) continue;
    seen.add(recordKey);
    const currentHash = current.sourceDescriptionHash || sourceDescriptionHash(current);
    if (currentHash !== hash) continue;
    const state = queueStateForEvent({ ...current, sourceDescriptionHash: hash }, cache);
    const candidate = {
      ...record,
      sourceDescriptionHash: hash,
      facts: sourceFacts(record, current),
      sourceTexts: sourceTexts(record),
      sourceQuality: isPoorSource(sourceTexts(record)) ? 'poor' : 'normal',
      currentEvent: current,
    };
    const cached = cache.entries?.[rewriteCacheKey(candidate.id, hash)];
    if (isValidRewriteCacheEntry(cached, { id: candidate.id, sourceHash: hash })) continue;
    if (!withinDays(current.startDate, options.days)) continue;
    if (state === 'parked') {
      candidate.selectionClass = 'parked';
      parkedQueue.push(candidate);
    } else if (state === 'new' || state === 'retryable') {
      candidate.selectionClass = state === 'new' ? 'new' : 'retryable';
      queue.push(candidate);
    }
  }
  const priority = (left, right) => compareQueueAttemptPriority(left, right) || priorityCompare(left.currentEvent, right.currentEvent);
  queue.sort(priority);
  parkedQueue.sort((a, b) => priorityCompare(a.currentEvent, b.currentEvent));
  return { queue, parkedQueue, queueState };
}

function buildBatches(queue, options) {
  const batches = [];
  const inputBudgetSkipped = [];
  let current = [];
  for (const record of queue) {
    // Measure the real prompt shape, not only the JSON payload: the fixed
    // policy instructions and retry diagnostics also count toward the cap.
    const singlePromptLength = buildBatchPrompt([record]).length;
    if (singlePromptLength > options.maxInputChars) {
      inputBudgetSkipped.push(record);
      continue;
    }
    const candidate = [...current, record];
    if (current.length && (current.length >= options.batchSize || buildBatchPrompt(candidate).length > options.maxInputChars)) {
      batches.push(current);
      current = [];
    }
    current.push(record);
  }
  if (current.length) batches.push(current);
  return { batches, inputBudgetSkipped };
}

function rejectRecords(
  stats,
  records,
  code,
  {
    rejectionMemory = null,
    rejectionEntries = null,
    definitive = false,
    detail = '',
  } = {},
) {
  stats.rejected += records.length;
  stats.rejectionCodes[code] = (stats.rejectionCodes[code] || 0) + records.length;
  if (detail) {
    const detailKey = `${code}:${detail}`;
    stats.rejectionDetails[detailKey] = (stats.rejectionDetails[detailKey] || 0) + records.length;
  }
  for (const record of records) {
    if (record?.selectionClass === 'new') stats.rejectedNeverAttempted += 1;
    if (record?.selectionClass === 'retryable') stats.rejectedRetries += 1;
    if (!definitive || !rejectionMemory || !rejectionEntries || !record?.id) continue;
    stats._rejectionKeys ||= new Set();
    const key = rewriteCacheKey(record.id, record.sourceDescriptionHash);
    if (stats._rejectionKeys.has(key)) continue;
    stats._rejectionKeys.add(key);
    const entry = recordRejectionMemory(rejectionMemory, record, code);
    if (entry) rejectionEntries[key] = entry;
  }
}

function acceptRecord(record, descriptions, cache, acceptedEntries, stats, { fallback = false } = {}) {
  const entry = makeCacheEntry(record, descriptions);
  const key = rewriteCacheKey(record.id, record.sourceDescriptionHash);
  cache.entries[key] = entry;
  delete cache.rejections?.[key];
  acceptedEntries[key] = entry;
  stats.accepted += 1;
  if (fallback) stats.acceptedByFallback += 1;
  else stats.acceptedByModel += 1;
  if (record.selectionClass === 'new') stats.acceptedNeverAttempted += 1;
  if (record.selectionClass === 'retryable') stats.acceptedRetries += 1;
}

async function processBatch(batch, cache, options, stats, acceptedEntries, rejectionEntries, breaker) {
  // The first call keeps the throughput benefit of a batch. Every retry is a
  // singleton, so one invalid event can never make accepted neighbours repeat
  // or disappear. A timed-out batch is also split before its first retry.
  const work = batch.map((record) => ({ record, attempt: 0, retryReason: '' }));
  let firstCall = true;
  while (work.length && !breaker.open) {
    const group = firstCall ? work.splice(0, work.length) : [work.shift()];
    firstCall = false;
    const attempt = group[0].attempt + 1;
    const retryReasons = new Map(group.filter((item) => item.retryReason).map((item) => [item.record.id, item.retryReason]));
    const records = group.map((item) => item.record);
    const prompt = buildBatchPrompt(records, retryReasons);
    if (prompt.length > options.maxInputChars) {
      const skipped = work.length + group.length;
      stats.inputBudgetSkipped += skipped;
      rejectRecords(stats, records.concat(work.map((item) => item.record)), 'input-budget', {
        rejectionMemory: cache.rejections,
        rejectionEntries,
        definitive: true,
      });
      break;
    }
    if (stats.inputChars + prompt.length > options.maxTotalInputChars) {
      const skipped = work.length + group.length;
      stats.inputBudgetSkipped += skipped;
      rejectRecords(stats, records.concat(work.map((item) => item.record)), 'input-budget', {
        rejectionMemory: cache.rejections,
        rejectionEntries,
        definitive: true,
      });
      break;
    }
    stats.calls += 1;
    stats.attempts += 1;
    stats.eventAttempts += group.length;
    stats.inputChars += prompt.length;
    const started = Date.now();
    let result;
    try {
      result = await requestCodex(prompt, options.timeoutMs);
      stats.elapsedMs += Date.now() - started;
      breaker.failureStreak = 0;
    } catch (error) {
      stats.elapsedMs += Date.now() - started;
      const failureKind = classifyCodexFailure(error);
      stats.transportFailures += 1;
      if (failureKind === 'quota') stats.quotaErrors += 1;
      if (failureKind === 'timeout') stats.timeoutErrors += 1;
      if (failureKind === 'transport') stats.brokerErrors += 1;

      // A timeout on a multi-event request is treated as a batch-size signal,
      // not as evidence that the provider is unavailable. Singleton failures
      // still trip the existing circuit breaker after repeated errors.
      const breakerEligible = failureKind === 'quota' || group.length === 1;
      if (breakerEligible && isCircuitBreakerFailure(failureKind)) breaker.failureStreak += 1;
      else breaker.failureStreak = 0;
      const quotaCircuitOpen = failureKind === 'quota' && stats.quotaErrors >= options.circuitBreakerThreshold;
      const transientCircuitOpen = failureKind !== 'quota'
        && breakerEligible
        && isCircuitBreakerFailure(failureKind)
        && breaker.failureStreak >= options.circuitBreakerThreshold;
      const rejectionCode = `${failureKind}-circuit-open`;
      if (quotaCircuitOpen || transientCircuitOpen) {
        breaker.open = true;
        breaker.reason = failureKind;
        stats.circuitBreakerTrips += 1;
        stats.circuitOpen = true;
        stats.circuitReason = failureKind;
        rejectRecords(stats, records, rejectionCode);
        break;
      }
      const retryable = group.filter((item) => item.attempt + 1 < options.maxAttempts);
      const exhausted = group.filter((item) => item.attempt + 1 >= options.maxAttempts);
      if (exhausted.length) rejectRecords(stats, exhausted, `codex-${failureKind}`);
      if (!retryable.length) break;
      stats.retries += retryable.length;
      work.unshift(...retryable.map((item) => ({
        ...item,
        attempt: item.attempt + 1,
        retryReason: `codex-${failureKind}`,
      })).reverse());
      const backoffMs = isCircuitBreakerFailure(failureKind)
        ? exponentialBackoffMs(breaker.failureStreak, options.quotaBackoffBaseMs, options.quotaBackoffMaxMs)
        : Math.min(60_000, 5_000 * (2 ** (attempt - 1)));
      stats.backoffMs += backoffMs;
      await sleep(backoffMs);
      continue;
    }
    const resultText = JSON.stringify(result);
    stats.outputChars += resultText.length;
    const outputById = normalizeModelResult(result);
    const retryable = [];
    for (const item of group) {
      const { record } = item;
      const descriptions = outputById.get(record.id);
      const validation = validateRewriteBundle(descriptions, {
        sourceTexts: record.sourceTexts,
        factTexts: factsContext(record.facts),
      });
      const poorSourceTooShort = record.sourceQuality === 'poor' && !meetsPoorSourceWordFloor(descriptions);
      if (!validation.ok || poorSourceTooShort) {
        const code = Object.values(validation.errors || {})[0] || (poorSourceTooShort ? 'poor-source-word-floor' : 'missing-output');
        if (attempt >= options.maxAttempts) {
          const detail = Object.entries(validation.details || {}).find(([locale]) => validation.errors?.[locale] === code)?.[1] || '';
          rejectRecords(stats, [record], code, {
            rejectionMemory: cache.rejections,
            rejectionEntries,
            definitive: true,
            detail,
          });
        } else {
          stats.retries += 1;
          retryable.push({ record, attempt, retryReason: code });
        }
        continue;
      }
      acceptRecord(record, descriptions, cache, acceptedEntries, stats);
    }
    work.unshift(...retryable.reverse());
    if (retryable.length) {
      const backoffMs = Math.min(60_000, 5_000 * (2 ** (attempt - 1)));
      stats.backoffMs += backoffMs;
      await sleep(backoffMs);
    }
    if (!options.dryRun && stats.accepted) writeCache(options.cache, cache);
  }
  if (breaker.open && work.length) {
    rejectRecords(stats, work.map((item) => item.record), `${breaker.reason}-circuit-open`);
  }
}

function finishStats(stats, queue, options, queueState) {
  // Include retry backoff in the observed throughput. The model call timer is
  // still kept separately so a run can distinguish provider latency from the
  // deliberate quota-friendly pauses.
  const observedElapsedMs = stats.elapsedMs + stats.backoffMs;
  const elapsedHours = Math.max(observedElapsedMs / 3_600_000, 1 / 3_600_000);
  const durationMs = Math.max(0, Date.parse(stats.completedAt) - Date.parse(stats.startedAt));
  const serializableStats = { ...stats };
  delete serializableStats._rejectionKeys;
  return {
    ...serializableStats,
    observedElapsedMs,
    durationMs,
    selected: queue.length,
    queueRemaining: queueState.workable,
    toAttempt: queueState.toAttempt,
    neverAttempted: queueState.neverAttempted,
    retryable: queueState.retryable,
    waitingRetry: queueState.waitingRetry,
    parked: queueState.parked,
    model: EVENT_DESCRIPTION_REWRITE_MODEL,
    promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
    policyVersion: EVENT_DESCRIPTION_POLICY_VERSION,
    rejectionMemorySchemaVersion: REJECTION_MEMORY_SCHEMA_VERSION,
    batchSize: options.batchSize,
    timeoutMs: options.timeoutMs,
    maxInputChars: options.maxInputChars,
    maxTotalInputChars: options.maxTotalInputChars,
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
    limit: options.limit,
    quotaErrorThreshold: QUOTA_ERROR_THRESHOLD,
    circuitBreakerThreshold: options.circuitBreakerThreshold,
    callsPerHour: Number((stats.calls / elapsedHours).toFixed(2)),
    acceptedPerCall: Number((stats.accepted / Math.max(stats.calls, 1)).toFixed(2)),
    eventAttemptsPerSelected: Number((stats.eventAttempts / Math.max(stats.selected || queue.length, 1)).toFixed(2)),
    eventAttemptsPerAccepted: Number((stats.eventAttempts / Math.max(stats.accepted, 1)).toFixed(2)),
    observedMsPerAccepted: Number((observedElapsedMs / Math.max(stats.accepted, 1)).toFixed(1)),
    elapsedHours: Number(elapsedHours.toFixed(4)),
    quota: {
      lunaCalls: stats.calls,
      quotaErrors: stats.quotaErrors,
      timeoutErrors: stats.timeoutErrors,
      circuitBreakerTrips: stats.circuitBreakerTrips,
      retries: stats.retries,
      backoffMs: stats.backoffMs,
      tokenCountersExposed: false,
      note: 'Codex OAuth broker/CLI non espone un contatore token; il gate misura chiamate, errori, caratteri e backoff.',
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.empty) {
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
    if (options.outputCache) writeCache(path.resolve(options.outputCache), { entries: {} });
    if (options.statsOutput) writeFileSync(path.resolve(options.statsOutput), `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(stats));
    return;
  }
  if (!existsSync(options.sourceExport)) throw new Error('private source export not found');
  if (!existsSync(options.dataset)) throw new Error('dataset not found');
  const records = loadSourceRecords(options.sourceExport);
  const dataset = readJson(options.dataset);
  const cache = loadEventDescriptionRewriteCache(options.cache);
  cache.entries ||= {};
  cache.rejections ||= {};
  const { queue, parkedQueue, queueState } = selectQueue(records, dataset, cache, options);
  const selectedQueue = selectShardQueue(queue, {
    shardCount: options.shardCount,
    shardIndex: options.shardIndex,
    limit: options.limit,
  });
  const selectedParkedQueue = options.dryRun
    ? []
    : selectShardQueue(parkedQueue, {
      shardCount: options.shardCount,
      shardIndex: options.shardIndex,
      limit: Math.max(0, options.limit - selectedQueue.length),
    });
  const stats = {
    throughputSchemaVersion: 1,
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
    limit: options.limit,
    startedAt: new Date().toISOString(),
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
    backoffMs: 0,
    rejectionCodes: {},
    rejectionDetails: {},
    selectedNeverAttempted: selectedQueue.filter((record) => record.selectionClass === 'new').length,
    selectedRetries: selectedQueue.filter((record) => record.selectionClass === 'retryable').length,
    acceptedNeverAttempted: 0,
    acceptedRetries: 0,
    rejectedNeverAttempted: 0,
    rejectedRetries: 0,
    parkedFallbackCandidates: 0,
    parkedUnchanged: 0,
    totalCandidateRecords: queueState.pending,
  };
  const acceptedEntries = {};
  const rejectionEntries = {};
  const modelQueue = [];
  if (!options.dryRun) {
    for (const record of selectedParkedQueue) {
      stats.parkedFallbackCandidates += 1;
      const descriptions = buildMinimalRewriteDescriptions(record);
      const validation = validateRewriteBundle(descriptions, {
        sourceTexts: record.sourceTexts,
        factTexts: factsContext(record.facts),
      });
      if (validation.ok && meetsPoorSourceWordFloor(descriptions, POOR_SOURCE_MIN_WORDS)) {
        acceptRecord(record, descriptions, cache, acceptedEntries, stats, { fallback: true });
      } else {
        stats.parkedUnchanged += 1;
      }
    }
    for (const record of selectedQueue) {
      if (record.sourceQuality !== 'poor') {
        modelQueue.push(record);
        continue;
      }
      const descriptions = buildMinimalRewriteDescriptions(record);
      const validation = validateRewriteBundle(descriptions, {
        sourceTexts: record.sourceTexts,
        factTexts: factsContext(record.facts),
      });
      if (validation.ok && meetsPoorSourceWordFloor(descriptions)) acceptRecord(record, descriptions, cache, acceptedEntries, stats, { fallback: true });
      else modelQueue.push(record);
    }
  } else {
    modelQueue.push(...selectedQueue);
  }
  if (!options.dryRun && stats.acceptedByFallback > 0) writeCache(options.cache, cache);
  const { batches, inputBudgetSkipped } = buildBatches(modelQueue, options);
  stats.inputBudgetSkipped += inputBudgetSkipped.length;
  if (inputBudgetSkipped.length) rejectRecords(stats, inputBudgetSkipped, 'input-budget', {
    rejectionMemory: cache.rejections,
    rejectionEntries,
    definitive: true,
  });
  const breaker = { failureStreak: 0, open: false, reason: '' };
  if (!options.dryRun) {
    for (let index = 0; index < batches.length; index += 1) {
      if (breaker.open) {
        const remaining = batches.slice(index).flat();
        const rejectionCode = `${breaker.reason}-circuit-open`;
        rejectRecords(stats, remaining, rejectionCode);
        break;
      }
      await processBatch(batches[index], cache, options, stats, acceptedEntries, rejectionEntries, breaker);
    }
  }
  if (options.outputCache) writeCache(path.resolve(options.outputCache), { ...cache, entries: acceptedEntries, rejections: rejectionEntries });
  const finalQueueState = summarizeRewriteQueue(dataset, cache);
  const finalStats = finishStats({
    ...stats,
    completedAt: new Date().toISOString(),
    quota: {
      lunaCalls: stats.calls,
      quotaErrors: stats.quotaErrors,
      timeoutErrors: stats.timeoutErrors,
      circuitBreakerTrips: stats.circuitBreakerTrips,
      tokenCountersExposed: false,
      note: 'Codex OAuth broker/CLI non espone un contatore token; il gate misura chiamate, errori, caratteri e backoff.',
    },
  }, [...selectedQueue, ...selectedParkedQueue], options, finalQueueState);
  if (options.statsOutput) {
    writeFileSync(path.resolve(options.statsOutput), `${JSON.stringify(finalStats, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(finalStats));
}

try {
  await main();
} catch (error) {
  console.error(`[event-description-rewrite] ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
