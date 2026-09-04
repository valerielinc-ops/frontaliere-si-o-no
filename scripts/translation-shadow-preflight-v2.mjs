#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSafeTranslationShadowOutputPath,
  createTranslationShadowObservationV2,
  digestTranslationShadowDefaultCompanyKeyV2,
  TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES,
  writeTranslationShadowArtifactAtomicV2,
} from './lib/translation-shadow-preflight-v2.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function usage() {
  return 'Usage: node scripts/translation-shadow-preflight-v2.mjs --mode <capture|observe> --decision <decision.json> [--output <observation.json>] [metadata flags]';
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || typeof value !== 'string') {
      throw new TypeError(usage());
    }
    if (flag in values) throw new TypeError(`Duplicate ${flag}`);
    values[flag] = value;
  }
  if (!['capture', 'observe'].includes(values['--mode']) || !values['--decision']
      || (values['--mode'] === 'observe' && !values['--output'])) {
    throw new TypeError(usage());
  }
  return values;
}

function readDecision(filePath, runnerTemp) {
  let descriptor;
  try {
    const resolved = assertSafeTranslationShadowOutputPath(filePath, runnerTemp);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function nullable(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseDefaultBoolean(value, flag) {
  // Su `schedule` il workflow passa comunque il flag, con il valore vuoto di
  // `inputs.<nome>`: la stringa vuota vale «input non fornito», come per
  // parseDefaultInteger, e ricade sul default `false` dichiarato nel workflow.
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${flag} must be true or false`);
}

function parseDefaultInteger(value, flag) {
  if (value === undefined || value === '') return null;
  if (value.length > 16 || !/^[0-9]+$/.test(value)) {
    throw new TypeError(`${flag} must be a bounded non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${flag} must be a bounded non-negative integer`);
  }
  return parsed;
}

export function runTranslationShadowObservationCli(argv, { runnerTemp = process.env.RUNNER_TEMP } = {}) {
  const startedMs = Date.now();
  const values = parseArguments(argv);
  const defaultInputs = {
    companyKeyDigest: digestTranslationShadowDefaultCompanyKeyV2(
      values['--default-company-key'] ?? '',
    ),
    dryRun: parseDefaultBoolean(values['--default-dry-run'], '--default-dry-run'),
    maxJobs: parseDefaultInteger(values['--default-max-jobs'], '--default-max-jobs'),
    mopupMaxJobs: parseDefaultInteger(
      values['--default-mopup-max-jobs'], '--default-mopup-max-jobs',
    ),
    skipHousekeeping: parseDefaultBoolean(
      values['--default-skip-housekeeping'], '--default-skip-housekeeping',
    ),
    skipTranslate: parseDefaultBoolean(
      values['--default-skip-translate'], '--default-skip-translate',
    ),
  };
  const decision = readDecision(values['--decision'], runnerTemp);
  const sourceCommit = nullable(values['--source-commit']);
  const observation = createTranslationShadowObservationV2({
    decision,
    expectedDecisionDigest: nullable(values['--expected-decision-digest']),
    expectedContractDigest: nullable(values['--expected-contract-digest']),
    expectedRunBinding: {
      repository: nullable(values['--source-repository']),
      workflow: nullable(values['--source-workflow']),
      runId: nullable(values['--run-id']),
      runAttempt: nullable(values['--run-attempt']),
      sourceCommit,
      workflowBlobSha: nullable(values['--workflow-blob-sha']),
    },
    eventName: nullable(values['--event-name']),
    eventAction: nullable(values['--event-action']),
    runId: nullable(values['--run-id']),
    runAttempt: nullable(values['--run-attempt']),
    defaultInputs,
    sourceRepository: nullable(values['--source-repository']),
    sourceCommit,
    finalTranslationCommit: nullable(values['--final-translation-commit']),
    observedJobStatus: nullable(values['--observed-job-status']),
    finalizerRunnerMs: Date.now() - startedMs,
  });
  writeTranslationShadowArtifactAtomicV2(values['--output'], observation, { runnerTemp });
  return observation;
}

export function runTranslationShadowBindingCaptureCli(argv, {
  runnerTemp = process.env.RUNNER_TEMP,
} = {}) {
  const values = parseArguments(argv);
  if (values['--mode'] !== 'capture') throw new TypeError(usage());
  const decision = readDecision(values['--decision'], runnerTemp);
  return {
    expectedDecisionDigest: DIGEST_PATTERN.test(decision?.decisionDigest ?? '')
      ? decision.decisionDigest : null,
    expectedContractDigest: DIGEST_PATTERN.test(decision?.snapshot?.sourceRuntimeContractDigest ?? '')
      ? decision.snapshot.sourceRuntimeContractDigest : null,
  };
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    const modeIndex = process.argv.indexOf('--mode');
    if (process.argv[modeIndex + 1] === 'capture') {
      const binding = runTranslationShadowBindingCaptureCli(process.argv.slice(2));
      if (binding.expectedDecisionDigest) {
        process.stdout.write(`expected_decision_digest=${binding.expectedDecisionDigest}\n`);
      }
      if (binding.expectedContractDigest) {
        process.stdout.write(`expected_contract_digest=${binding.expectedContractDigest}\n`);
      }
    } else {
      const observation = runTranslationShadowObservationCli(process.argv.slice(2));
      process.stdout.write(`${JSON.stringify({ observationDigest: observation.observationDigest })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
