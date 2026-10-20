#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLoopPolicy } from '../lib/loop-fleet-contract.mjs';

/**
 * Fail-closed L7 experiment outcome export.
 *
 * `active-experiments.json` is the declaration source. With no active
 * experiment, the exporter writes an explicit idle result without querying
 * telemetry. With an active experiment, it reports outcomes as unavailable
 * until an approved persistent assignment/outcome/guardrail ledger exists.
 * Configuration metadata and analytics events are not that ledger.
 */
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_ACTIVE_EXPERIMENTS_PATH = path.join('data', 'experiments', 'active-experiments.json');
export const L7_EXPERIMENT_EVENT_CONTRACT = Object.freeze({
  experimentId: 'g4-affiliate-contextual',
  exposureEvent: 'affiliate_experiment_exposure',
  outcomeEvent: 'affiliate_click',
  campaign: 'g4-contextual',
  surface: 'web',
  contexts: Object.freeze(['exchange', 'banks']),
  variants: Object.freeze(['control', 'benefit']),
  sessionJoin: 'properties.$session_id',
  exposureVariantProperty: 'variant',
  outcomeVariantProperty: 'variant',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function finiteDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function readL7Policy(registryPath) {
  return loadLoopPolicy(registryPath, 'L7').policy;
}

const ACTIVE_EXPERIMENT_TEXT_FIELDS = Object.freeze(['experimentId', 'exposureEvent', 'outcomeEvent', 'rcParam']);

/**
 * Parse the declared list of active experiments. Anything but a well-formed
 * file throws: a missing or malformed declaration must not read as "idle".
 */
export function parseActiveExperiments(value, label = DEFAULT_ACTIVE_EXPERIMENTS_PATH) {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.experiments)) {
    throw new Error(`${label} must be { schemaVersion: 1, experiments: [] }`);
  }
  const seen = new Set();
  value.experiments.forEach((entry, index) => {
    const prefix = `${label} experiments[${index}]`;
    if (!isObject(entry)) throw new Error(`${prefix} is not an object`);
    for (const field of ACTIVE_EXPERIMENT_TEXT_FIELDS) {
      if (!text(entry[field])) throw new Error(`${prefix}.${field} is missing`);
    }
    if (!Array.isArray(entry.variants) || entry.variants.length < 2 || entry.variants.some((variant) => !text(variant))) {
      throw new Error(`${prefix}.variants must list at least two variants`);
    }
    if (!finiteDate(entry.startedAt)) throw new Error(`${prefix}.startedAt is missing or invalid`);
    if (seen.has(entry.experimentId)) throw new Error(`${prefix}.experimentId ${entry.experimentId} is duplicated`);
    seen.add(entry.experimentId);
  });
  return value.experiments;
}

export function readActiveExperiments(filePath = DEFAULT_ACTIVE_EXPERIMENTS_PATH) {
  return parseActiveExperiments(JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')), filePath);
}

function sameValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

/** Reject declarations that are not the known L7 client contract. */
export function validateL7ReaderDeclaration(experiments, label = DEFAULT_ACTIVE_EXPERIMENTS_PATH) {
  if (experiments.length === 0) return experiments;
  if (experiments.length !== 1) {
    throw new Error(`${label} declares ${experiments.length} experiments, but the L7 contract maps exactly one`);
  }
  const [experiment] = experiments;
  const mismatches = [];
  for (const field of ['experimentId', 'exposureEvent', 'outcomeEvent']) {
    if (experiment[field] !== L7_EXPERIMENT_EVENT_CONTRACT[field]) {
      mismatches.push(`${field}=${JSON.stringify(experiment[field])}`);
    }
  }
  if (!sameValues(experiment.variants, L7_EXPERIMENT_EVENT_CONTRACT.variants)) {
    mismatches.push(`variants=${JSON.stringify(experiment.variants)}`);
  }
  if (mismatches.length) {
    throw new Error(`${label} experiments[0] does not match the L7 reader contract: ${mismatches.join(', ')}`);
  }
  return experiments;
}

export function readL7ActiveExperiments(filePath = DEFAULT_ACTIVE_EXPERIMENTS_PATH) {
  return validateL7ReaderDeclaration(readActiveExperiments(filePath), filePath);
}

/** An explicit safe zero when the declaration contains no active experiment. */
export function buildIdleL7ExperimentOutcome({
  now = new Date(),
  activeExperimentsPath = DEFAULT_ACTIVE_EXPERIMENTS_PATH,
} = {}) {
  const reason = `no experiment is registered as active (${activeExperimentsPath})`;
  const metrics = {
    eligibleCohort: null,
    assignments: null,
    exposures: null,
    primaryOutcomes: null,
    guardrailBreaches: null,
    persistentAssignments: null,
    contaminatedAssignments: null,
    durationDays: null,
  };
  return {
    schemaVersion: 1,
    loopId: 'L7',
    status: 'idle',
    quality: 'zero',
    generatedAt: now.toISOString(),
    independent: true,
    activeExperiments: 0,
    ...metrics,
    metrics,
    variants: {},
    evidence: {
      source: `${activeExperimentsPath} declares no active experiment; no telemetry source was queried`,
      sourceRefs: [],
      status: 'idle',
    },
    export: {
      schemaVersion: 1,
      experimentId: null,
      readOnly: true,
      idle: true,
      mutationsPerformed: false,
      trafficMutationAllowed: false,
      priceMutationAllowed: false,
      noAutomaticPriceChange: true,
    },
    _meta: {
      generatedAt: now.toISOString(),
      source: activeExperimentsPath,
      purpose: 'Declared idle state for Loop L7: no experiment to allocate',
    },
    reason,
  };
}

/**
 * Active experiments remain unmeasurable until a separately approved,
 * persistent assignment/outcome/guardrail ledger is wired into L7.
 */
export function buildUnavailableL7ExperimentOutcome({ now = new Date() } = {}) {
  const generatedAt = now.toISOString();
  const metrics = {
    eligibleCohort: null,
    assignments: null,
    exposures: null,
    primaryOutcomes: null,
    guardrailBreaches: null,
    persistentAssignments: null,
    contaminatedAssignments: null,
    durationDays: null,
  };
  return {
    schemaVersion: 1,
    loopId: 'L7',
    status: 'unmeasurable',
    quality: 'unmeasurable',
    generatedAt,
    independent: false,
    activeExperiments: null,
    ...metrics,
    metrics,
    variants: {},
    evidence: {
      source: 'no approved persistent L7 assignment/outcome/guardrail ledger is configured',
      sourceRefs: [],
      status: 'unavailable',
    },
    export: {
      schemaVersion: 1,
      readOnly: true,
      unavailable: true,
      idle: false,
      mutationsPerformed: false,
      trafficMutationAllowed: false,
      priceMutationAllowed: false,
      noAutomaticPriceChange: true,
    },
    _meta: {
      generatedAt,
      source: 'no approved persistent L7 assignment/outcome/guardrail ledger is configured',
      purpose: 'Fail-closed placeholder; no experiment outcome is inferred',
    },
    reason: 'No approved persistent assignment/outcome/guardrail ledger is configured; allocation remains disabled',
  };
}

export async function exportL7({
  outputPath,
  registryPath = DEFAULT_REGISTRY_PATH,
  now = new Date(),
  activeExperimentsPath = DEFAULT_ACTIVE_EXPERIMENTS_PATH,
} = {}) {
  if (!text(outputPath)) throw new Error('--out is required');
  readL7Policy(registryPath);
  const experiments = readL7ActiveExperiments(activeExperimentsPath);
  const outcome = experiments.length === 0
    ? buildIdleL7ExperimentOutcome({ now, activeExperimentsPath })
    : { ...buildUnavailableL7ExperimentOutcome({ now }), activeExperiments: experiments.length };
  const absoluteOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  fs.writeFileSync(absoluteOutputPath, `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  return {
    json: argv.includes('--json'),
    unavailable: argv.includes('--unavailable'),
    outputPath: valueAfter('--out', null),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    activeExperimentsPath: valueAfter('--active-experiments', DEFAULT_ACTIVE_EXPERIMENTS_PATH),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  if (!text(options.outputPath)) throw new Error('--out is required');
  const now = new Date();
  let result;
  if (options.unavailable) {
    readL7Policy(options.registryPath);
    result = buildUnavailableL7ExperimentOutcome({ now });
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  } else {
    result = await exportL7({ ...options, now });
  }
  const label = result.activeExperiments === 0 ? 'idle: no active experiment' : 'outcome unavailable';
  logger.log(options.json ? JSON.stringify(result, null, 2) : `[L7] experiment outcome exported (${label})`);
  return result;
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  main().catch((error) => {
    console.error(`[L7] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
