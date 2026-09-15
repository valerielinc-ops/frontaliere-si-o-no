#!/usr/bin/env node

/**
 * Read-only L7 experiment outcome export.
 *
 * The current bounded experiment is G4 affiliate contextual recommendations.
 * Assignment is stable for an experiment session in sessionStorage and the
 * exposure/click evidence is persisted by PostHog. This exporter joins only
 * categorical events on `properties.$session_id`; it never reads email, URL, identity,
 * partner revenue, or any user-level payload and never mutates traffic, price,
 * inventory, or Remote Config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleDataClient } from './export-loop-outcomes.mjs';
import { runHogQL } from '../lib/posthog-client.mjs';
import { validateLoopRegistry } from '../lib/loop-fleet-contract.mjs';

export const DEFAULT_L7_WINDOW_DAYS = 8;
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
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

const DAY_MS = 86_400_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function finiteDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function nonNegativeInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`PostHog returned invalid ${label}`);
  return parsed;
}

function postHogRow(response, name) {
  const columns = response?.columns || [];
  const row = response?.results?.[0];
  if (Array.isArray(row)) {
    const index = columns.indexOf(name);
    return index === -1 ? null : row[index];
  }
  return row?.[name] ?? null;
}

function completeUtcWindow(now, days) {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days must be an integer between 1 and 31');
  const endMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return {
    start: new Date(endMs - days * DAY_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readL7Policy(registryPath) {
  const registry = validateLoopRegistry(readJson(registryPath, 'loop fleet registry'));
  const policy = Array.isArray(registry.loops)
    ? registry.loops.find((loop) => loop?.loopId === 'L7')
    : null;
  if (!isObject(policy)) throw new Error('L7 policy is missing from the loop fleet registry');
  return policy;
}

function readRemoteConfigValue(template, name) {
  const value = template?.parameters?.[name]?.defaultValue?.value
    ?? template?.parameters?.[name]?.defaultValue
    ?? template?.parameters?.[name]?.value;
  return text(value) ? value : null;
}

async function resolvePostHogConfig(client) {
  let template = null;
  const read = async (envName, remoteName) => {
    if (text(process.env[envName])) return process.env[envName];
    template ||= await client.remoteConfig();
    return readRemoteConfigValue(template, remoteName);
  };
  const apiKey = await read('POSTHOG_PERSONAL_API_KEY', 'SERVER_POSTHOG_PERSONAL_API_KEY');
  const projectId = await read('POSTHOG_PROJECT_ID', 'SERVER_POSTHOG_PROJECT_ID');
  const host = await read('POSTHOG_HOST', 'SERVER_POSTHOG_HOST') || 'https://eu.posthog.com';
  if (!apiKey || !projectId) throw new Error('PostHog credentials are missing from env and Remote Config');
  return { apiKey, projectId, host };
}

function sourceRefs(policy) {
  const refs = policy?.outcome?.sourceRefs || policy?.sourceRefs || [];
  return Array.isArray(refs) ? refs.filter(text).map((ref) => ref.trim()) : [];
}

function registryMetadata(policy, now) {
  const allocation = isObject(policy?.allocationPolicy) ? policy.allocationPolicy : {};
  const contamination = isObject(allocation.contaminationPolicy) ? allocation.contaminationPolicy : {};
  const lifecycle = isObject(policy?.lifecycle) ? policy.lifecycle : {};
  const candidateTtlHours = Number(lifecycle.candidateTtlHours);
  const expiresAt = Number.isFinite(candidateTtlHours) && candidateTtlHours > 0
    ? new Date(now.getTime() + candidateTtlHours * 3_600_000).toISOString()
    : null;
  return {
    preRegistration: {
      outcomeId: text(policy?.outcome?.outcomeId) ? policy.outcome.outcomeId : null,
      primaryMetric: text(policy?.primaryMetric) ? policy.primaryMetric : null,
      minimumSample: integer(policy?.minimumSample) ? policy.minimumSample : null,
      guardrails: Array.isArray(policy?.guardrails) ? policy.guardrails.filter(text) : [],
      expiresAt,
    },
    assignmentLedger: {
      persistent: allocation.persistent === true,
      method: text(allocation.assignmentMethod) ? allocation.assignmentMethod : null,
      key: text(allocation.assignmentKey) ? allocation.assignmentKey : null,
    },
    contaminationPolicy: {
      controlled: contamination.controlled === true,
      key: text(contamination.key) ? contamination.key : null,
      rejectReassignment: contamination.rejectReassignment === true,
      rejectCrossCandidateExposure: contamination.rejectCrossCandidateExposure === true,
    },
    noAutomaticPriceChange: allocation.noAutomaticPriceChange === true,
    trafficMutationAllowed: allocation.trafficMutationAllowed === true,
    priceMutationAllowed: allocation.priceMutationAllowed === true,
  };
}

/**
 * Convert independently queried session counts into the L7 source contract.
 * `independent` means the source join is complete and external to the
 * candidate generator; sample-size and guardrail validity remain the L7
 * validator's responsibility.
 */
export function buildL7ExperimentOutcome({
  counts,
  policy,
  now = new Date(),
  telemetryWindow,
  eventContract = L7_EXPERIMENT_EVENT_CONTRACT,
} = {}) {
  const metadata = registryMetadata(policy, now);
  const completeCounts = counts && [
    'eligibleCohort',
    'assignments',
    'exposures',
    'primaryOutcomes',
    'guardrailBreaches',
    'persistentAssignments',
    'contaminatedAssignments',
  ].every((name) => integer(counts[name]));
  const independent = completeCounts
    && metadata.preRegistration.outcomeId !== null
    && metadata.preRegistration.primaryMetric !== null
    && metadata.preRegistration.minimumSample !== null
    && metadata.preRegistration.guardrails.length > 0
    && metadata.preRegistration.expiresAt !== null
    && metadata.assignmentLedger.persistent
    && metadata.assignmentLedger.method !== null
    && metadata.assignmentLedger.key !== null
    && metadata.contaminationPolicy.controlled
    && metadata.contaminationPolicy.key !== null;
  const quality = independent ? 'observed' : 'partial';
  const values = completeCounts ? {
    eligibleCohort: counts.eligibleCohort,
    assignments: counts.assignments,
    exposures: counts.exposures,
    primaryOutcomes: counts.primaryOutcomes,
    guardrailBreaches: counts.guardrailBreaches,
    persistentAssignments: counts.persistentAssignments,
    contaminatedAssignments: counts.contaminatedAssignments,
  } : {
    eligibleCohort: null,
    assignments: null,
    exposures: null,
    primaryOutcomes: null,
    guardrailBreaches: null,
    persistentAssignments: null,
    contaminatedAssignments: null,
  };
  const start = finiteDate(telemetryWindow?.start);
  const end = finiteDate(telemetryWindow?.end);
  const durationDays = start && end && end > start ? (end.getTime() - start.getTime()) / DAY_MS : null;
  return {
    schemaVersion: 1,
    loopId: 'L7',
    status: quality,
    quality,
    generatedAt: now.toISOString(),
    independent,
    ...values,
    durationDays,
    metrics: { ...values, durationDays },
    variants: isObject(counts?.variants) ? counts.variants : {},
    evidence: {
      source: independent
        ? 'PostHog HogQL, read-only session-level experiment export'
        : 'PostHog HogQL, read-only experiment export incomplete',
      sourceRefs: sourceRefs(policy),
      sessionJoin: eventContract.sessionJoin,
      eventContract: { ...eventContract, contexts: [...eventContract.contexts], variants: [...eventContract.variants] },
      assignmentPersistence: 'sessionStorage assignment joined to persisted PostHog $session_id exposure events',
      status: independent ? 'verified' : 'unverified',
    },
    preRegistration: metadata.preRegistration,
    assignmentLedger: metadata.assignmentLedger,
    contaminationPolicy: metadata.contaminationPolicy,
    telemetryWindow,
    export: {
      schemaVersion: 1,
      experimentId: eventContract.experimentId,
      readOnly: true,
      piiExcluded: true,
      emailExcluded: true,
      urlExcluded: true,
      trafficMutationAllowed: metadata.trafficMutationAllowed,
      priceMutationAllowed: metadata.priceMutationAllowed,
      noAutomaticPriceChange: metadata.noAutomaticPriceChange,
      mutationsPerformed: false,
    },
    _meta: {
      generatedAt: now.toISOString(),
      source: 'PostHog HogQL, read-only live export',
      purpose: 'Fresh assignment/exposure/outcome ledger for Loop L7',
      telemetryWindow,
    },
    reason: independent
      ? 'explicit PostHog session-level experiment outcome satisfies the registered L7 contract'
      : 'PostHog experiment outcome is incomplete; allocation remains disabled',
  };
}

export function buildUnavailableL7ExperimentOutcome({ policy = {}, now = new Date(), eventContract = L7_EXPERIMENT_EVENT_CONTRACT } = {}) {
  return {
    schemaVersion: 1,
    loopId: 'L7',
    status: 'unmeasurable',
    quality: 'unmeasurable',
    generatedAt: now.toISOString(),
    independent: false,
    eligibleCohort: null,
    assignments: null,
    exposures: null,
    primaryOutcomes: null,
    guardrailBreaches: null,
    persistentAssignments: null,
    contaminatedAssignments: null,
    durationDays: null,
    metrics: {
      eligibleCohort: null,
      assignments: null,
      exposures: null,
      primaryOutcomes: null,
      guardrailBreaches: null,
      persistentAssignments: null,
      contaminatedAssignments: null,
      durationDays: null,
    },
    variants: {},
    evidence: {
      source: 'PostHog HogQL, read-only experiment export unavailable',
      sourceRefs: sourceRefs(policy),
      sessionJoin: eventContract.sessionJoin,
      eventContract: { ...eventContract, contexts: [...eventContract.contexts], variants: [...eventContract.variants] },
      status: 'unavailable',
    },
    export: {
      schemaVersion: 1,
      experimentId: eventContract.experimentId,
      readOnly: true,
      unavailable: true,
      mutationsPerformed: false,
      trafficMutationAllowed: false,
      priceMutationAllowed: false,
      noAutomaticPriceChange: true,
    },
    _meta: {
      generatedAt: now.toISOString(),
      source: 'PostHog HogQL, read-only experiment export unavailable',
      purpose: 'Explicit fail-closed placeholder; never a measured outcome',
    },
    reason: 'L7 experiment outcome export unavailable; allocation remains disabled',
  };
}

/** Query only categorical G4 experiment events and aggregate by non-empty session. */
export async function fetchL7ExperimentCounts({
  posthogRunner = runHogQL,
  config,
  start,
  end,
  eventContract = L7_EXPERIMENT_EVENT_CONTRACT,
} = {}) {
  const contexts = eventContract.contexts.map((value) => `'${value}'`).join(', ');
  const variants = eventContract.variants.map((value) => `'${value}'`).join(', ');
  const query = `
    SELECT count() AS eligibleCohort,
      countIf(assignmentEvents > 0) AS assignments,
      countIf(assignmentEvents > 0) AS exposures,
      countIf((assignedVariant IN ('control', 'benefit')) AND mismatchedOutcomeEvents = 0 AND matchingOutcomeEvents > 0) AS primaryOutcomes,
      countIf(assignedVariant = 'control' AND mismatchedOutcomeEvents = 0) AS controlSessions,
      countIf(assignedVariant = 'benefit' AND mismatchedOutcomeEvents = 0) AS benefitSessions,
      countIf(assignedVariant = 'contaminated' OR mismatchedOutcomeEvents > 0) AS contaminatedAssignments,
      countIf(assignedVariant = 'contaminated' OR mismatchedOutcomeEvents > 0) AS guardrailBreaches,
      countIf(assignedVariant IN ('control', 'benefit') AND mismatchedOutcomeEvents = 0) AS persistentAssignments
    FROM (
      SELECT *,
        if(assignedVariant = 'control', controlOutcomeEvents,
          if(assignedVariant = 'benefit', benefitOutcomeEvents, 0)) AS matchingOutcomeEvents,
        if(assignedVariant = 'control', benefitOutcomeEvents + unknownOutcomeEvents,
          if(assignedVariant = 'benefit', controlOutcomeEvents + unknownOutcomeEvents, 0)) AS mismatchedOutcomeEvents
      FROM (
        SELECT *,
          multiIf(
            controlAssignments > 0 AND benefitAssignments = 0, 'control',
            benefitAssignments > 0 AND controlAssignments = 0, 'benefit',
            'contaminated'
          ) AS assignedVariant
        FROM (
          SELECT ${eventContract.sessionJoin},
            countIf(event = '${eventContract.exposureEvent}') AS assignmentEvents,
            countIf(event = '${eventContract.exposureEvent}' AND properties.${eventContract.exposureVariantProperty} = 'control') AS controlAssignments,
            countIf(event = '${eventContract.exposureEvent}' AND properties.${eventContract.exposureVariantProperty} = 'benefit') AS benefitAssignments,
            countIf(event = '${eventContract.outcomeEvent}') AS outcomeEvents,
            countIf(event = '${eventContract.outcomeEvent}' AND properties.${eventContract.outcomeVariantProperty} = 'control') AS controlOutcomeEvents,
            countIf(event = '${eventContract.outcomeEvent}' AND properties.${eventContract.outcomeVariantProperty} = 'benefit') AS benefitOutcomeEvents,
            countIf(event = '${eventContract.outcomeEvent}' AND (properties.${eventContract.outcomeVariantProperty} IS NULL OR properties.${eventContract.outcomeVariantProperty} NOT IN (${variants}))) AS unknownOutcomeEvents
          FROM events
          WHERE timestamp >= '${start}' AND timestamp < '${end}'
            AND event IN ('${eventContract.exposureEvent}', '${eventContract.outcomeEvent}')
            AND properties.surface = '${eventContract.surface}'
            AND properties.campaign = '${eventContract.campaign}'
            AND properties.context IN (${contexts})
            AND properties.${eventContract.sessionJoin.replace('properties.', '')} IS NOT NULL
            AND properties.${eventContract.sessionJoin.replace('properties.', '')} != ''
            AND (
              event = '${eventContract.outcomeEvent}'
              OR properties.${eventContract.exposureVariantProperty} IN (${variants})
            )
          GROUP BY ${eventContract.sessionJoin}
          HAVING assignmentEvents > 0
        )
      )
    )`;
  const response = await posthogRunner(query, config);
  const counts = {
    eligibleCohort: nonNegativeInteger(postHogRow(response, 'eligibleCohort'), 'eligibleCohort'),
    assignments: nonNegativeInteger(postHogRow(response, 'assignments'), 'assignments'),
    exposures: nonNegativeInteger(postHogRow(response, 'exposures'), 'exposures'),
    primaryOutcomes: nonNegativeInteger(postHogRow(response, 'primaryOutcomes'), 'primaryOutcomes'),
    guardrailBreaches: nonNegativeInteger(postHogRow(response, 'guardrailBreaches'), 'guardrailBreaches'),
    persistentAssignments: nonNegativeInteger(postHogRow(response, 'persistentAssignments'), 'persistentAssignments'),
    contaminatedAssignments: nonNegativeInteger(postHogRow(response, 'contaminatedAssignments'), 'contaminatedAssignments'),
    variants: {
      control: nonNegativeInteger(postHogRow(response, 'controlSessions'), 'controlSessions'),
      benefit: nonNegativeInteger(postHogRow(response, 'benefitSessions'), 'benefitSessions'),
    },
  };
  if (counts.persistentAssignments + counts.contaminatedAssignments !== counts.assignments) {
    throw new Error('PostHog experiment assignment counts do not reconcile');
  }
  return counts;
}

export async function exportL7({
  outputPath,
  registryPath = DEFAULT_REGISTRY_PATH,
  now = new Date(),
  days = DEFAULT_L7_WINDOW_DAYS,
  client = null,
  config = null,
  posthogRunner = runHogQL,
} = {}) {
  if (!text(outputPath)) throw new Error('--out is required');
  const policy = readL7Policy(registryPath);
  const window = completeUtcWindow(now, days);
  const posthogConfig = config || await resolvePostHogConfig(client || new GoogleDataClient());
  const counts = await fetchL7ExperimentCounts({
    posthogRunner,
    config: posthogConfig,
    start: window.start,
    end: window.end,
  });
  const outcome = buildL7ExperimentOutcome({ counts, policy, now, telemetryWindow: window });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  const days = Number(valueAfter('--days', String(DEFAULT_L7_WINDOW_DAYS)));
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days must be an integer between 1 and 31');
  return {
    json: argv.includes('--json'),
    unavailable: argv.includes('--unavailable'),
    outputPath: valueAfter('--out', null),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    days,
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  if (!text(options.outputPath)) throw new Error('--out is required');
  const now = new Date();
  const policy = readL7Policy(options.registryPath);
  const result = options.unavailable
    ? buildUnavailableL7ExperimentOutcome({ policy, now })
    : await exportL7({ ...options, now });
  if (options.unavailable) {
    fs.mkdirSync(path.dirname(path.resolve(options.outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(options.outputPath), `${JSON.stringify(result, null, 2)}\n`);
  }
  logger.log(options.json ? JSON.stringify(result, null, 2) : `[L7] experiment outcome exported (${result.independent ? 'independent' : 'unavailable/unverified'})`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L7] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
