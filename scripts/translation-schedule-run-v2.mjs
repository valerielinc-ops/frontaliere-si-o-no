#!/usr/bin/env node

/**
 * Runtime entrypoint for the translation scheduler v2 shadow lane.
 *
 * The scheduler/state-store modules are deliberately pure libraries. This file
 * is the production seam that gives them a real queue: it scans the committed
 * crawler slices, reads the dedicated translation-state ref, plans and reserves
 * one bounded batch, executes candidates, checkpoints candidates on that ref,
 * and settles the plan. It never creates or pushes a main commit.
 *
 * Shadow mode is intentionally the only mode exposed here. A later publisher
 * can consume the state-ref queue through the existing drainer; this runner is
 * allowed to observe and persist scheduler state, but it has no main-writer
 * capability by construction.
 */

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { needsWork, missingSlots } from './local-mt-mopup.mjs';
import {
  MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2,
  MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2,
  TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
  planTranslationScheduleV2,
} from './lib/translation-completion-scheduler-v2.mjs';
import {
  createJobTranslationUnitIdentityV2,
  createTranslationDerivedPatchV2,
  resolveJobTranslationTargetKeyV2,
} from './lib/translation-derived-patch-v2.mjs';
import { executeTranslationCandidateV2 } from './lib/translation-candidate-executor-v2.mjs';
import {
  MAX_TRANSLATION_STATE_BATCH_V2,
  createTranslationStateStoreV2,
} from './lib/translation-state-store-v2.mjs';
import { digestTranslationDocumentV2 } from './lib/translation-unit-identity-v2.mjs';

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

export const TRANSLATION_SCHEDULER_V2_SCOPE = 'translation-shadow-v2';
export const TRANSLATION_SCHEDULER_V2_ENGINE = 'shadow-engine-v2';
export const TRANSLATION_SCHEDULER_V2_GATE = 'translation-quality-v2';
export const TRANSLATION_SCHEDULER_V2_PROVIDER_SCHEMA = 3;
export const TRANSLATION_SCHEDULER_V2_DEFAULT_MAX_JOBS = 250;
export const TRANSLATION_SCHEDULER_V2_DEFAULT_MAX_UNITS = 25;
export const TRANSLATION_SCHEDULER_V2_DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

const SLICE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionInteger(value, fallback, label, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return boundedInteger(parsed, label, { max });
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new TypeError('translation scheduler repository is required');
  }
  return path.resolve(repository);
}

function normalizeCommit(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 40-character commit sha`);
  }
  return value;
}

function normalizeProviderModule(repository, value) {
  const raw = value || path.join(repository, 'scripts/lib/translation-shadow-provider-v2.mjs');
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('translation scheduler provider module is required');
  }
  if (/^(?:data|file):/u.test(raw)) return raw;
  return pathToFileURL(path.resolve(repository, raw)).href;
}

function normalizeProvider({ repository, providerModule, providerExportName, engineVersion }) {
  if (typeof providerExportName !== 'string' || providerExportName.length === 0) {
    throw new TypeError('translation scheduler provider export is required');
  }
  return Object.freeze({
    schemaVersion: TRANSLATION_SCHEDULER_V2_PROVIDER_SCHEMA,
    costClass: 'zero',
    engineVersion,
    executionClass: 'isolated_callback',
    exportName: providerExportName,
    moduleUrl: normalizeProviderModule(repository, providerModule),
  });
}

function parseQueuedAtMs(job) {
  for (const key of ['datePosted', 'postedDate', 'crawledAt', 'firstSeenAt']) {
    const value = job?.[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function targetOccurrenceKey(target) {
  return `translation-target-occurrence:v2:${digestTranslationDocumentV2({
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    target,
  })}`;
}

function sourceTextFor(job, fieldPath) {
  const value = job?.[fieldPath];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`pending job ${fieldPath} source text is missing`);
  }
  return value;
}

function jobUnitContext(job, slot) {
  const sourceText = sourceTextFor(job, slot.field);
  const identity = createJobTranslationUnitIdentityV2(job, {
    fieldPath: slot.field,
    targetLocale: slot.locale,
  });
  return {
    identity,
    fieldPath: slot.field,
    sourceLang: job.sourceLang || 'it',
    sourceText,
    targetLocale: slot.locale,
    memory: null,
  };
}

function assertJobRecord(job, label) {
  assertPlainObject(job, label);
  if (typeof job.url !== 'string' || job.url.trim().length === 0) {
    throw new TypeError(`${label} has no canonical url`);
  }
}

/**
 * Read all crawler slices and build the bounded scheduler population.
 *
 * The scan digest covers every slice byte, not only the selected queue. That
 * makes an active plan fail closed when the source dataset changes between
 * reserve and execution.
 */
export async function collectTranslationSchedulerInput({
  repository,
  dataDirectory,
  maxInputJobs = MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2,
  maxInputUnits = MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2,
} = {}) {
  const root = normalizeRepository(repository);
  const dataDir = path.resolve(dataDirectory || path.join(root, 'data/jobs/by-crawler'));
  const boundedJobs = boundedInteger(maxInputJobs, 'translation scheduler max input jobs', {
    max: MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2,
  });
  const boundedUnits = boundedInteger(maxInputUnits, 'translation scheduler max input units', {
    max: MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2,
  });
  const entries = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const digest = createHash('sha256');
  const schedulerJobs = [];
  const runtimeJobs = [];
  const metrics = {
    filesScanned: 0,
    jobsScanned: 0,
    pendingJobs: 0,
    pendingJobsWithoutSlots: 0,
    selectedInputJobs: 0,
    selectedInputUnits: 0,
    truncatedPendingJobs: 0,
  };

  for (const entry of entries) {
    if (!SLICE_FILE_PATTERN.test(entry.name)) {
      throw new TypeError(`translation scheduler slice filename is invalid: ${entry.name}`);
    }
    const fullPath = path.join(dataDir, entry.name);
    const raw = await readFile(fullPath, 'utf8');
    const relativeSlicePath = path.posix.join('data/jobs/by-crawler', entry.name);
    digest.update(relativeSlicePath);
    digest.update('\0');
    digest.update(raw);
    let slice;
    try {
      slice = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid JSON in ${relativeSlicePath}: ${error.message}`);
    }
    assertPlainObject(slice, relativeSlicePath);
    if (typeof slice.crawlerKey !== 'string' || slice.crawlerKey.length === 0
        || !Array.isArray(slice.jobs)) {
      throw new TypeError(`${relativeSlicePath} must contain crawlerKey and jobs[]`);
    }
    metrics.filesScanned += 1;
    metrics.jobsScanned += slice.jobs.length;

    for (const [jobIndex, job] of slice.jobs.entries()) {
      assertJobRecord(job, `${relativeSlicePath} jobs[${jobIndex}]`);
      if (!needsWork(job)) continue;
      metrics.pendingJobs += 1;

      const slots = missingSlots(job);
      if (slots.length === 0) {
        metrics.pendingJobsWithoutSlots += 1;
        continue;
      }
      if (schedulerJobs.length >= boundedJobs || metrics.selectedInputUnits + slots.length > boundedUnits) {
        metrics.truncatedPendingJobs += 1;
        continue;
      }

      const units = slots.map((slot) => jobUnitContext(job, slot));
      const target = {
        crawlerKey: slice.crawlerKey,
        slicePath: relativeSlicePath,
        jobKey: resolveJobTranslationTargetKeyV2(job),
        url: job.url,
      };
      // The scheduler validates all target fields. Do this early so a malformed
      // pending record cannot silently disappear from the queue.
      if (typeof target.jobKey !== 'string' || target.jobKey.trim().length === 0) {
        throw new TypeError(`${relativeSlicePath} jobs[${jobIndex}] has no stable job key`);
      }
      schedulerJobs.push({
        target,
        queuedAtMs: parseQueuedAtMs(job),
        units: units.map(({ identity }) => ({ identity, memory: null })),
      });
      runtimeJobs.push({
        crawlerKey: slice.crawlerKey,
        job,
        slicePath: relativeSlicePath,
        target,
        units,
      });
      metrics.selectedInputJobs += 1;
      metrics.selectedInputUnits += units.length;
    }
  }

  return {
    jobs: schedulerJobs,
    runtimeJobs,
    scanDigest: `sha256:${digest.digest('hex')}`,
    metrics,
  };
}

async function readMainCommit(repository) {
  const result = await execFile('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  });
  return normalizeCommit(result.stdout.trim(), 'translation scheduler baselineMainSha');
}

async function attachTranslationMemories(stateStore, input) {
  const identities = [];
  const seen = new Set();
  for (const runtimeJob of input.runtimeJobs) {
    for (const unit of runtimeJob.units) {
      if (seen.has(unit.identity.key)) continue;
      seen.add(unit.identity.key);
      identities.push(unit.identity);
    }
  }
  const memories = new Map();
  for (let offset = 0; offset < identities.length; offset += MAX_TRANSLATION_STATE_BATCH_V2) {
    const batch = identities.slice(offset, offset + MAX_TRANSLATION_STATE_BATCH_V2);
    const result = await stateStore.readTranslationMemories({ identities: batch });
    if (!Array.isArray(result.memories) || result.memories.length !== batch.length) {
      throw new TypeError('translation state store returned an incomplete memory batch');
    }
    batch.forEach((identity, index) => memories.set(identity.key, result.memories[index]));
  }
  for (const runtimeJob of input.runtimeJobs) {
    for (const unit of runtimeJob.units) unit.memory = memories.get(unit.identity.key);
  }
  for (const schedulerJob of input.jobs) {
    for (const unit of schedulerJob.units) unit.memory = memories.get(unit.identity.key);
  }
  return memories;
}

function contextIndex(runtimeJobs) {
  const byOccurrence = new Map();
  for (const runtimeJob of runtimeJobs) {
    byOccurrence.set(targetOccurrenceKey(runtimeJob.target), runtimeJob);
  }
  return byOccurrence;
}

function patchBatches(patches) {
  const groups = new Map();
  for (const item of patches) {
    const groupKey = `${item.crawlerKey}\0${item.slicePath}`;
    const batches = groups.get(groupKey) ?? [];
    let batch = batches.at(-1);
    if (!batch || batch.patches.length >= MAX_TRANSLATION_STATE_BATCH_V2
        || batch.attemptKeys.has(item.patch.candidate.attemptKey)) {
      batch = { crawlerKey: item.crawlerKey, slicePath: item.slicePath, patches: [], attemptKeys: new Set() };
      batches.push(batch);
    }
    batch.patches.push(item.patch);
    batch.attemptKeys.add(item.patch.candidate.attemptKey);
    groups.set(groupKey, batches);
  }
  return [...groups.values()].flat();
}

async function persistCandidateResults(stateStore, executions) {
  const patches = [];
  const rejected = [];
  const rejectedAttempts = new Set();
  for (const execution of executions) {
    const { result, runtimeJob, unit } = execution;
    if (result.status === 'validated') {
      if (result.candidate === null) {
        throw new TypeError('validated translation candidate has no candidate record');
      }
      patches.push({
        crawlerKey: runtimeJob.crawlerKey,
        slicePath: runtimeJob.slicePath,
        patch: createTranslationDerivedPatchV2({
          candidate: result.candidate,
          crawlerKey: runtimeJob.crawlerKey,
          fieldPath: unit.fieldPath,
          job: runtimeJob.job,
          targetLocale: unit.targetLocale,
        }),
      });
    } else if (result.status === 'rejected_candidate' && result.candidate !== null
        && !rejectedAttempts.has(result.candidate.attemptKey)) {
      rejectedAttempts.add(result.candidate.attemptKey);
      rejected.push({ identity: unit.identity, candidate: result.candidate });
    }
  }

  for (const batch of patchBatches(patches)) {
    await stateStore.checkpointBatch({ slicePath: batch.slicePath, patches: batch.patches });
  }
  for (let offset = 0; offset < rejected.length; offset += MAX_TRANSLATION_STATE_BATCH_V2) {
    await stateStore.checkpointRejectedCandidatesBatch(
      rejected.slice(offset, offset + MAX_TRANSLATION_STATE_BATCH_V2),
    );
  }
  return { validated: patches.length, rejected: rejected.length };
}

async function executePlan({
  plan,
  currentScanDigest,
  runtimeJobs,
  provider,
  engineVersion,
  gateVersion,
  providerTimeoutMs,
}) {
  const byOccurrence = contextIndex(runtimeJobs);
  const executions = [];
  const outcomes = [];
  for (const selectedJob of plan.selectedJobs) {
    const runtimeJob = byOccurrence.get(selectedJob.targetOccurrenceKey);
    const units = [];
    for (const selectedUnit of selectedJob.units) {
      const runtimeUnit = runtimeJob?.units.find((unit) => unit.identity.key === selectedUnit.identityKey);
      if (!runtimeJob) {
        units.push({ attemptKey: selectedUnit.attemptKey, status: 'stale_target' });
        continue;
      }
      if (!runtimeUnit) {
        units.push({ attemptKey: selectedUnit.attemptKey, status: 'stale_source' });
        continue;
      }
      if (selectedUnit.disposition === 'reuse') {
        units.push({ attemptKey: selectedUnit.attemptKey, status: 'reused' });
        continue;
      }
      const result = await executeTranslationCandidateV2({
        currentScanDigest,
        engineVersion,
        gateVersion,
        identity: runtimeUnit.identity,
        memory: runtimeUnit.memory,
        provider,
        providerTimeoutMs,
        quality: {
          field: runtimeUnit.fieldPath,
          protectedTokens: [],
          sourceLang: runtimeUnit.sourceLang,
          sourceText: runtimeUnit.sourceText,
          targetLang: runtimeUnit.targetLocale,
        },
        scanDigest: plan.scanDigest,
      });
      units.push({ attemptKey: selectedUnit.attemptKey, status: result.status });
      executions.push({ result, runtimeJob, unit: runtimeUnit });
    }
    outcomes.push({ schedulingKey: selectedJob.schedulingKey, units });
  }
  return { executions, outcomes };
}

function countOutcomeStatuses(outcomes) {
  const counts = {};
  for (const outcome of outcomes) {
    for (const unit of outcome.units) counts[unit.status] = (counts[unit.status] || 0) + 1;
  }
  return counts;
}

async function writeReport(report, reportPath) {
  if (!reportPath) return;
  const absolute = path.resolve(reportPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Run one bounded shadow scheduling cycle.
 *
 * @returns {Promise<object>} a redacted, metric-only run report
 */
export async function runTranslationScheduleV2(options = {}) {
  assertPlainObject(options, 'translation scheduler options');
  const repository = normalizeRepository(options.repository || REPO_ROOT);
  const mode = options.mode || 'shadow';
  if (mode !== 'shadow') throw new TypeError('translation scheduler v2 only supports shadow mode');
  const scopeKey = options.scopeKey || process.env.TRANSLATION_SCHEDULER_SCOPE || TRANSLATION_SCHEDULER_V2_SCOPE;
  const engineVersion = options.engineVersion || process.env.TRANSLATION_SCHEDULER_ENGINE || TRANSLATION_SCHEDULER_V2_ENGINE;
  const gateVersion = options.gateVersion || process.env.TRANSLATION_SCHEDULER_GATE || TRANSLATION_SCHEDULER_V2_GATE;
  const maxJobs = optionInteger(
    options.maxJobs ?? process.env.TRANSLATION_SHADOW_MAX_JOBS,
    TRANSLATION_SCHEDULER_V2_DEFAULT_MAX_JOBS,
    'translation scheduler maxJobs',
    250,
  );
  const maxUnits = optionInteger(
    options.maxUnits ?? process.env.TRANSLATION_SHADOW_MAX_UNITS,
    TRANSLATION_SCHEDULER_V2_DEFAULT_MAX_UNITS,
    'translation scheduler maxUnits',
    250,
  );
  const providerTimeoutMs = optionInteger(
    options.providerTimeoutMs ?? process.env.TRANSLATION_SHADOW_PROVIDER_TIMEOUT_MS,
    TRANSLATION_SCHEDULER_V2_DEFAULT_PROVIDER_TIMEOUT_MS,
    'translation scheduler providerTimeoutMs',
    300_000,
  );
  const stateStore = options.stateStore || createTranslationStateStoreV2({
    repository,
    ref: options.stateRef || process.env.TRANSLATION_STATE_REF_V2,
  });
  const provider = options.provider || normalizeProvider({
    repository,
    providerModule: options.providerModule || process.env.TRANSLATION_SCHEDULER_PROVIDER_MODULE,
    providerExportName: options.providerExportName || process.env.TRANSLATION_SCHEDULER_PROVIDER_EXPORT || 'translate',
    engineVersion,
  });
  const logger = options.logger || console;
  const baselineMainSha = options.baselineMainSha || await readMainCommit(repository);
  const input = await collectTranslationSchedulerInput({
    repository,
    dataDirectory: options.dataDirectory || path.join(repository, 'data/jobs/by-crawler'),
  });

  await stateStore.initialize();
  const before = await stateStore.readSchedulerScope({ scopeKey });
  await attachTranslationMemories(stateStore, input);
  const planned = planTranslationScheduleV2({
    activePlan: before.activePlan,
    baselineMainSha,
    cursor: before.cursor,
    engineVersion,
    gateVersion,
    jobs: input.jobs,
    limits: {
      fairnessDenominator: 5,
      fairnessNumerator: 1,
      maxJobs,
      maxUnits,
    },
    scanDigest: input.scanDigest,
    scopeKey,
  });

  if (planned.plan.selectedJobs.length === 0) {
    const report = {
      mode,
      status: 'empty',
      scopeKey,
      stateRef: stateStore.ref,
      sourceCommit: baselineMainSha,
      scanDigest: input.scanDigest,
      planHash: null,
      scan: input.metrics,
      scheduler: { selectedJobs: 0, selectedUnits: 0, outcomeCounts: {} },
      state: { before: before.commit, after: before.commit, reserved: false, settled: false },
    };
    await writeReport(report, options.reportPath || process.env.TRANSLATION_SHADOW_REPORT_PATH);
    logger.log(`translation scheduler v2 shadow: empty queue (${input.metrics.pendingJobs} pending jobs scanned)`);
    return report;
  }

  let reserved = false;
  if (before.activePlan === null) {
    const reservation = await stateStore.reserveSchedulerPlan({
      cursor: planned.cursor,
      expectedCursorHash: planned.plan.cursorBeforeHash,
      plan: planned.plan,
      scopeKey,
    });
    reserved = reservation.changed;
  }

  const executed = await executePlan({
    currentScanDigest: input.scanDigest,
    engineVersion,
    gateVersion,
    plan: planned.plan,
    provider,
    providerTimeoutMs,
    runtimeJobs: input.runtimeJobs,
  });
  const persisted = await persistCandidateResults(stateStore, executed.executions);
  const settled = await stateStore.settleSchedulerPlan({
    outcomes: executed.outcomes,
    planHash: planned.plan.planHash,
    scopeKey,
  });
  const selectedUnits = planned.plan.selectedJobs.reduce((sum, job) => sum + job.units.length, 0);
  const report = {
    mode,
    status: 'settled',
    scopeKey,
    stateRef: stateStore.ref,
    sourceCommit: baselineMainSha,
    scanDigest: input.scanDigest,
    planHash: planned.plan.planHash,
    scan: input.metrics,
    scheduler: {
      selectedJobs: planned.plan.selectedJobs.length,
      selectedUnits,
      outcomeCounts: countOutcomeStatuses(executed.outcomes),
      settlement: settled.settlement.metrics,
    },
    candidates: persisted,
    state: {
      before: before.commit,
      after: settled.commit,
      reserved,
      settled: settled.changed,
    },
  };
  await writeReport(report, options.reportPath || process.env.TRANSLATION_SHADOW_REPORT_PATH);
  logger.log(`translation scheduler v2 shadow: ${report.scheduler.selectedUnits} unit(s), ${JSON.stringify(report.scheduler.outcomeCounts)}`);
  logger.log(`translation scheduler v2 state ref: ${stateStore.ref} @ ${settled.commit}`);
  return report;
}

function parseCli(argv) {
  const options = {};
  const valueFlags = new Map([
    ['--repository', 'repository'],
    ['--data-directory', 'dataDirectory'],
    ['--max-jobs', 'maxJobs'],
    ['--max-units', 'maxUnits'],
    ['--provider-timeout-ms', 'providerTimeoutMs'],
    ['--provider-module', 'providerModule'],
    ['--provider-export', 'providerExportName'],
    ['--scope', 'scopeKey'],
    ['--state-ref', 'stateRef'],
    ['--report', 'reportPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run' || flag === '--shadow') continue;
    const key = valueFlags.get(flag);
    if (!key || typeof argv[index + 1] !== 'string' || argv[index + 1].length === 0) {
      throw new TypeError(`unknown or incomplete argument: ${flag}`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  runTranslationScheduleV2(parseCli(process.argv.slice(2))).catch((error) => {
    console.error(`translation scheduler v2 shadow failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
