#!/usr/bin/env node

/**
 * Build a live, read-only status table for the loop fleet.
 *
 * It reads the latest completed GitHub run, its immutable evidence artifact and
 * the append-only durable health ledger. Missing artifacts or an unreadable
 * Actions API are explicit states; they are never treated as a healthy zero.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LIFECYCLE_EVENT_TYPES,
  summarizeLifecycleEvents as summarizeLifecycleEventsContract,
  validateActionClassAgainstPolicy,
  validateLifecycleEvent,
  validateLoopRegistry,
  validateOutcomeAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const DEFAULT_LEDGER_DIR = path.join('data', 'loop-fleet', 'ledger');
export const LOOP_WORKFLOWS = Object.freeze({
  L0: 'loop-l0-data-truth.yml',
  L1: 'loop-l1-reliability.yml',
  L2: 'loop-l2-demand-utility.yml',
  L3: 'loop-l3-job-quality.yml',
  L4: 'loop-l4-alert-return.yml',
  L5: 'loop-l5-decision-moments.yml',
  L6: 'loop-l6-content-factuality.yml',
  L7: 'loop-l7-experiment-allocator.yml',
  L8: 'loop-l8-revenue-attribution.yml',
  L9: 'loop-l9-employer-activation.yml',
  L10: 'loop-l10-fleet-control.yml',
  L11: 'technical-operations-supervisor.yml',
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function lifecycleSummary(events, now) {
  const records = Array.isArray(events) ? events : [];
  const summary = summarizeLifecycleEventsContract(records, { now });
  const eventCounts = Object.fromEntries(LIFECYCLE_EVENT_TYPES.map((eventType) => [
    eventType,
    records.filter((event) => event?.eventType === eventType).length,
  ]));
  const candidateIds = [...new Set(records
    .map((event) => text(event?.candidateId))
    .filter(Boolean))].sort();
  const ordered = records
    .map((event, index) => ({ event, index, time: Date.parse(event?.occurredAt || '') }))
    .sort((left, right) => (Number.isFinite(left.time) ? left.time : Number.POSITIVE_INFINITY)
      - (Number.isFinite(right.time) ? right.time : Number.POSITIVE_INFINITY)
      || left.index - right.index);
  const lastEvent = ordered.at(-1)?.event || null;
  const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
  const completeCount = candidates.filter((candidate) => candidate.complete === true).length;
  const terminalCount = candidates.filter((candidate) => candidate.terminalEventTypes?.some((eventType) =>
    ['rolled_back', 'inconclusive'].includes(eventType))).length;
  return {
    ...summary,
    lastEvent: lastEvent ? {
      eventType: lastEvent.eventType,
      occurredAt: lastEvent.occurredAt,
      recordId: text(lastEvent.recordId),
    } : null,
    eventCounts,
    candidateIds,
    lifecycleCounts: {
      eventCount: records.length,
      candidateCount: candidates.length,
      completeCount,
      incompleteCount: Math.max(0, candidates.length - completeCount),
      pendingCount: Math.max(0, candidates.length - completeCount - terminalCount),
      rollbackRequestedCount: eventCounts.rollback_requested,
      rolledBackCount: eventCounts.rolled_back,
      inconclusiveCount: eventCounts.inconclusive,
      byEvent: eventCounts,
    },
    ids: {
      candidateIds,
      recordIds: [...new Set(records.map((event) => text(event?.recordId)).filter(Boolean))].sort(),
      sourceRecordIds: [...new Set(records.map((event) => text(event?.sourceRecordId)).filter(Boolean))].sort(),
      artifactOrPrRefs: [...new Set(records.map((event) => text(event?.artifactOrPr)).filter(Boolean))].sort(),
      lastEventRecordId: text(lastEvent?.recordId),
    },
  };
}

function buildFreshness({ now, lastRun, evidence, durableHealth, lifecycleEvents }) {
  const timestamps = {
    runUpdatedAt: lastRun?.updatedAt || lastRun?.createdAt || null,
    evidenceRecordedAt: evidence?.recordedAt || evidence?.generatedAt || evidence?.run?.recordedAt || null,
    healthRecordedAt: durableHealth?.recordedAt || durableHealth?.execution?.recordedAt || null,
    lifecycleLastEventAt: lifecycleEvents?.lastEvent?.occurredAt || null,
  };
  const sources = Object.entries(timestamps)
    .map(([source, value]) => ({ source, value, time: Date.parse(value || '') }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => right.time - left.time);
  const invalidSources = Object.entries(timestamps)
    .filter(([, value]) => value !== null && !Number.isFinite(Date.parse(value)))
    .map(([source]) => source);
  const newest = sources[0] || null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now || '');
  const ageSeconds = newest && Number.isFinite(nowMs) && nowMs >= newest.time
    ? Math.floor((nowMs - newest.time) / 1000)
    : null;
  const future = newest && Number.isFinite(nowMs) && newest.time > nowMs;
  return {
    status: invalidSources.length > 0 || future ? 'unmeasurable' : (newest ? 'available' : 'unavailable'),
    asOf: newest ? new Date(newest.time).toISOString() : null,
    source: newest?.source || null,
    ageSeconds,
    ageHours: ageSeconds === null ? null : Number((ageSeconds / 3600).toFixed(2)),
    timestamps: Object.fromEntries(Object.entries(timestamps).map(([key, value]) => [key, isoTimestamp(value)])),
    invalidSources,
    computedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
  };
}

function readOperationalMetrics(health) {
  const fields = {
    durationSeconds: null,
    retryCount: null,
    quotaUnits: null,
    collisions: null,
    gateBypass: null,
  };
  const missing = [];
  const invalid = [];
  for (const field of Object.keys(fields)) {
    if (!Object.hasOwn(health || {}, field)) {
      missing.push(field);
      continue;
    }
    const value = health[field];
    const valid = field === 'durationSeconds' || field === 'quotaUnits'
      ? nonNegativeNumber(value)
      : field === 'gateBypass'
        ? value === false
        : nonNegativeInteger(value);
    if (!valid) invalid.push(field);
    else fields[field] = value;
  }
  const complete = missing.length === 0
    && invalid.length === 0
    && health?.operationalMetricsComplete === true;
  return {
    ...fields,
    complete,
    missing,
    invalid,
    sources: object(health?.operationalMetricsSources) ? health.operationalMetricsSources : null,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function repo() {
  return process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return JSON.parse(execFileSync('gh', [...args, ...(repo() ? ['--repo', repo()] : [])], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }));
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function ghRaw(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', [...args, ...(repo() ? ['--repo', repo()] : [])], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function latestRun(workflow) {
  const runs = gh(['run', 'list', '--workflow', workflow, '--branch', 'main', '--status', 'completed', '--limit', '1', '--json', 'databaseId,conclusion,status,createdAt,updatedAt,url,headSha'], { allowFailure: true });
  if (!Array.isArray(runs)) return { run: null, error: 'GitHub Actions API is unreadable' };
  return { run: runs[0] || null, error: runs.length ? null : 'no completed run found' };
}

function workflowForPolicy(policy) {
  return policy?.binding?.workflow || LOOP_WORKFLOWS[policy?.loopId] || null;
}

function artifactName(loopId, runId, registry) {
  if (loopId === 'L11') return `technical-operations-audit-${runId}`;
  const policy = registry?.loops?.find((candidate) => candidate.loopId === loopId);
  const workflow = workflowForPolicy(policy);
  return workflow ? `${workflow.replace(/\.ya?ml$/u, '')}-${runId}` : null;
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = findFile(candidate, name);
      if (found) return found;
    }
  }
  return null;
}

function readLastJsonl(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error(`canonical health ledger is invalid JSON: ${error.message}`);
  }
}

function readDurableHealth(ledgerDir, registry) {
  const file = path.resolve(ledgerDir, 'loop-health-history.jsonl');
  if (!fs.existsSync(file)) return { byLoop: {}, error: null };
  try {
    const byLoop = {};
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      let health;
      try {
        health = JSON.parse(line);
      } catch (error) {
        throw new Error(`line ${index + 1} is invalid JSON: ${error.message}`);
      }
      if (!health || health.recordType !== 'health' || !text(health.loopId)) {
        throw new Error(`line ${index + 1} is not a health record`);
      }
      validateActionClassAgainstPolicy(registry, health.loopId, health.actionClass);
      validateOutcomeAgainstPolicy(registry, health.loopId, health.outcome);
      if (!health.execution?.runId || !/^[0-9a-f]{40}$/iu.test(String(health.execution.sha))) {
        throw new Error(`line ${index + 1} has no durable execution identity`);
      }
      const previous = byLoop[health.loopId];
      const currentTime = Date.parse(health.recordedAt || health.execution.recordedAt || '');
      const previousTime = previous
        ? Date.parse(previous.recordedAt || previous.execution?.recordedAt || '')
        : -Infinity;
      if (!previous || (Number.isFinite(currentTime) && currentTime >= previousTime)) byLoop[health.loopId] = health;
    }
    return { byLoop, error: null };
  } catch (error) {
    return { byLoop: {}, error: `durable health ledger is invalid: ${error.message}` };
  }
}

export const summarizeLifecycleEvents = summarizeLifecycleEventsContract;
export const summarizeLifecycleDetails = lifecycleSummary;

function readDurableLifecycle(ledgerDir, registry, now = new Date()) {
  const file = path.resolve(ledgerDir, 'lifecycle-events.jsonl');
  if (!fs.existsSync(file)) return { byLoop: {}, error: null, available: false };
  try {
    const byLoop = {};
    const byId = new Map();
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`line ${index + 1} is invalid JSON: ${error.message}`);
      }
      validateLifecycleEvent(registry, event.loopId, event);
      if (!object(event.execution) || !text(event.execution.runId) || !/^[0-9a-f]{40}$/iu.test(String(event.execution.sha || ''))) {
        throw new Error(`line ${index + 1} has no durable execution identity`);
      }
      const previous = byId.get(event.recordId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
        throw new Error(`line ${index + 1} conflicts with duplicate ${event.recordId}`);
      }
      if (previous) continue;
      byId.set(event.recordId, event);
      if (!byLoop[event.loopId]) byLoop[event.loopId] = [];
      byLoop[event.loopId].push(event);
    }
    return {
      byLoop: Object.fromEntries(Object.entries(byLoop).map(([loopId, events]) => [loopId, lifecycleSummary(events, now)])),
      error: null,
      available: true,
    };
  } catch (error) {
    return { byLoop: {}, error: `lifecycle event ledger is invalid: ${error.message}`, available: true };
  }
}

function evidenceFromDurableHealth(health) {
  if (!health) return null;
  return {
    quality: health.quality || 'unmeasurable',
    evidenceComplete: health.evidenceComplete === true,
    lifecycleCompliant: health.lifecycleCompliant === true,
    policyCompliant: health.policyCompliant === true && health.outcomePolicyCompliant === true,
    outcomePolicyCompliant: health.outcomePolicyCompliant === true,
    decision: health.decision || 'unmeasurable',
    actionClass: health.actionClass || null,
    requiredAutonomy: health.requiredAutonomy || null,
    outcome: health.outcome || null,
    run: health.execution || null,
    health,
    durable: true,
  };
}

function downloadEvidence(loopId, run, tempRoot, registry, now = new Date()) {
  const runId = typeof run === 'object' ? run.databaseId : run;
  const target = path.join(tempRoot, loopId.toLowerCase());
  fs.mkdirSync(target, { recursive: true });
  const artifact = artifactName(loopId, runId, registry);
  if (!artifact) return { evidence: null, error: `no workflow binding is available for ${loopId}` };
  const downloaded = ghRaw(['run', 'download', String(runId), '--name', artifact, '--dir', target], { allowFailure: true });
  void downloaded;
  const file = findFile(target, 'loop-fleet-evidence.json');
  if (!file) return { evidence: null, error: 'canonical loop-fleet-evidence.json is missing from the latest artifact' };
  try {
    const evidence = readJson(file);
    if (evidence.loopId !== loopId) {
      return { evidence: null, error: `canonical evidence belongs to ${evidence.loopId || 'unknown'}, expected ${loopId}` };
    }
    if (String(evidence.run?.runId || '') !== String(runId)) {
      return { evidence: null, error: `canonical evidence belongs to run ${evidence.run?.runId || 'unknown'}, expected ${runId}` };
    }
    if (run?.headSha && evidence.run?.sha && run.headSha !== evidence.run.sha) {
      return { evidence: null, error: 'canonical evidence SHA does not match the selected run' };
    }
    const healthFile = findFile(target, 'loop-health-history.jsonl');
    const health = healthFile ? readLastJsonl(healthFile) : null;
    if (health && (health.loopId !== loopId || String(health.execution?.runId || '') !== String(runId))) {
      return { evidence: null, error: 'canonical health ledger does not match the selected loop/run' };
    }
    const lifecycleFile = findFile(target, 'lifecycle-events.jsonl');
    const lifecycleEvents = lifecycleFile
      ? fs.readFileSync(lifecycleFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          throw new Error(`lifecycle event line ${index + 1} is invalid JSON: ${error.message}`);
        }
        validateLifecycleEvent(registry, loopId, event);
        if (!object(event.execution)
          || String(event.execution.runId || '') !== String(runId)
          || (run?.headSha && String(event.execution.sha || '').toLowerCase() !== String(run.headSha).toLowerCase())) {
          throw new Error(`lifecycle event line ${index + 1} does not match the selected loop/run`);
        }
        return event;
      })
      : null;
    return {
      evidence: { ...evidence, health },
      lifecycleEvents: lifecycleEvents ? lifecycleSummary(lifecycleEvents, now) : null,
      error: null,
    };
  } catch (error) {
    return { evidence: null, error: `canonical evidence is invalid JSON: ${error.message}` };
  }
}

export function buildStatusRows(registry, runResults = {}, evidenceResults = {}, { now = new Date() } = {}) {
  const validated = validateLoopRegistry(registry);
  return validated.loops.map((policy) => {
    const runResult = runResults[policy.loopId] || { run: null, error: 'run not inspected' };
    const evidenceResult = evidenceResults[policy.loopId] || { evidence: null, error: 'evidence not inspected' };
    const durableHealth = evidenceResult.canonicalHealth || null;
    const lifecycleEvents = evidenceResult.canonicalLifecycle || evidenceResult.lifecycleEvents || null;
    const durableEvidence = evidenceFromDurableHealth(durableHealth);
    const evidence = evidenceResult.evidence || durableEvidence;
    const artifactHealth = evidence?.health || null;
    const evidenceRunId = evidence?.run?.runId || evidence?.health?.execution?.runId || null;
    const durableIsCurrent = durableHealth && evidenceRunId
      ? String(durableHealth.execution?.runId || '') === String(evidenceRunId)
      : !artifactHealth;
    const health = (durableIsCurrent ? durableHealth : (artifactHealth || durableHealth)) || {};
    const quality = text(evidence?.quality) || 'unmeasurable';
    const lifecycleCompliant = evidence?.lifecycleCompliant === true;
    const outcomePolicyCompliant = evidence?.outcomePolicyCompliant === true;
    const issueCount = Number.isInteger(health.issueCount) ? health.issueCount : null;
    const warningCount = Number.isInteger(health.warningCount) ? health.warningCount : null;
    const operationalMetrics = readOperationalMetrics(health);
    const operationalMetricsError = operationalMetrics.invalid.length
      ? `operational telemetry invalid: ${operationalMetrics.invalid.join(', ')}`
      : (operationalMetrics.missing.length
        ? `operational telemetry incomplete: ${operationalMetrics.missing.join(', ')}`
        : (operationalMetrics.complete ? null : 'operational telemetry is not marked complete'));
    const evidenceError = evidenceResult.canonicalError || evidenceResult.error || runResult.error
      || (!outcomePolicyCompliant ? 'canonical outcome policy is missing or noncompliant' : null)
      || (evidence && !lifecycleCompliant ? 'canonical lifecycle evidence is missing or noncompliant' : null)
      || operationalMetricsError;
    const issue = evidenceError
      || (issueCount !== null && issueCount > 0 ? `${issueCount} issue(s) recorded` : null)
      || (warningCount !== null && warningCount > 0 ? `${warningCount} warning(s) recorded` : null)
      || (quality !== 'observed' ? 'quality or evidence is incomplete' : null);
    const outcome = evidence?.outcome || health.outcome || null;
    const outcomeMeasured = outcome
      && (outcome.status === 'observed' || outcome.status === 'zero')
      && outcome.independent === true
      && Array.isArray(outcome.missingFields)
      && outcome.missingFields.length === 0;
    const lifecycleIncomplete = lifecycleEvents?.complete === false;
    const missingOutcome = !outcome
      ? 'independent outcome not recorded'
      : (outcomeMeasured ? null : `${outcome.status || 'unmeasurable'}: ${outcome.reason || 'independent outcome unavailable or incomplete'}`);
    const actualAutonomy = text(evidence?.requiredAutonomy) || text(health.requiredAutonomy);
    const lifecycleSla = lifecycleEvents?.sla || null;
    const lifecycleSlaOverdue = lifecycleEvents?.sla?.status === 'overdue'
      || lifecycleEvents?.candidates?.some((candidate) => candidate.sla?.status === 'overdue');
    const nextAutomaticAction = missingOutcome
      ? 'defer exposure and record the missing independent outcome'
      : (evidenceError
        ? (operationalMetricsError
          ? 'defer the decision, restore complete operational telemetry and rerun the loop'
          : 'defer the decision, restore the independent source and rerun the loop')
        : (lifecycleSlaOverdue
          ? 'defer the candidate, enforce its lifecycle SLA and record trusted terminal evidence'
          : (lifecycleIncomplete
            ? 'advance the candidate through PR, tests, automatic review, auto-merge and post-merge verification'
            : 'record the outcome and close the observation window automatically')));
    const lastRun = runResult.run ? {
      id: runResult.run.databaseId || null,
      conclusion: runResult.run.conclusion || runResult.run.status || 'unknown',
      createdAt: runResult.run.createdAt || null,
      updatedAt: runResult.run.updatedAt || null,
      headSha: runResult.run.headSha || null,
      url: runResult.run.url || null,
    } : null;
    const ledgerLastRun = durableHealth ? {
      id: durableHealth.execution?.runId || null,
      recordedAt: durableHealth.recordedAt || durableHealth.execution?.recordedAt || null,
      headSha: durableHealth.execution?.sha || null,
    } : null;
    const freshness = buildFreshness({
      now,
      lastRun,
      evidence,
      durableHealth,
      lifecycleEvents,
    });
    const tableMissing = [];
    if (!lastRun) tableMissing.push('run');
    if (!evidence) tableMissing.push('evidence');
    if (!lifecycleEvents) tableMissing.push('lifecycle');
    if (freshness.status !== 'available' || freshness.ageSeconds === null) tableMissing.push('freshness');
    const lifecycleCounts = lifecycleEvents?.lifecycleCounts || null;
    const lifecycleIds = lifecycleEvents?.ids || {
      candidateIds: [],
      recordIds: [],
      sourceRecordIds: [],
      artifactOrPrRefs: [],
      lastEventRecordId: null,
    };
    const ids = {
      runId: lastRun?.id || null,
      runHeadSha: lastRun?.headSha || null,
      ledgerRunId: ledgerLastRun?.id || null,
      ledgerHeadSha: ledgerLastRun?.headSha || null,
      evidenceRunId: evidenceRunId ? String(evidenceRunId) : null,
      evidenceSha: evidence?.run?.sha || evidence?.health?.execution?.sha || null,
      healthRecordId: durableHealth?.recordId || null,
      candidateIds: lifecycleIds.candidateIds || [],
      lifecycleRecordIds: lifecycleIds.recordIds || [],
      sourceRecordIds: lifecycleIds.sourceRecordIds || [],
      artifactOrPrRefs: lifecycleIds.artifactOrPrRefs || [],
      lastLifecycleEventId: lifecycleIds.lastEventRecordId || null,
    };
    return {
      loopId: policy.loopId,
      goal: policy.goal,
      owner: policy.owner,
      cadence: policy.cadence,
      primaryMetric: policy.primaryMetric,
      maxAutonomy: policy.maxAutonomy,
      actionPolicy: policy.actionPolicy,
      lifecycle: policy.lifecycle,
      sourceRefs: policy.sourceRefs,
      candidateTtlHours: policy.lifecycle.candidateTtlHours,
      ownerSlaHours: policy.lifecycle.ownerSlaHours,
      postMergeVerificationHours: policy.lifecycle.postMergeVerificationHours,
      rollbackOwner: policy.lifecycle.rollbackOwner,
      deadlineAt: lifecycleSla?.nextDeadlineAt || null,
      lastRun,
      quality,
      decision: text(evidence?.decision) || 'unmeasurable',
      actionClass: text(evidence?.actionClass) || null,
      requiredAutonomy: actualAutonomy,
      actualAutonomy,
      policyCompliant: evidence?.policyCompliant === true && lifecycleCompliant && outcomePolicyCompliant,
      evidenceComplete: evidence?.evidenceComplete === true,
      lifecycleCompliant,
      evidenceError,
      issue,
      missingOutcome,
      nextAutomaticAction,
      nextAction: nextAutomaticAction,
      issueCount,
      warningCount,
      operationalMetrics,
      outcome,
      outcomePolicyCompliant,
      lifecycleEvents,
      lifecycleState: lifecycleEvents?.state || 'unavailable',
      lifecycleSla: lifecycleEvents?.sla || null,
      lifecycleEventCount: lifecycleEvents?.eventCount ?? null,
      lifecycleComplete: lifecycleEvents?.complete ?? null,
      lifecycleCounts,
      lifecycleIds,
      ids,
      freshness,
      tableComplete: tableMissing.length === 0,
      tableCompleteness: {
        complete: tableMissing.length === 0,
        missing: tableMissing,
      },
      historyAvailable: Boolean(durableHealth),
      ledgerLastRun,
    };
  });
}

function markdownCell(value) {
  return String(value ?? 'n/d').replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>');
}

function shortSha(value) {
  const normalized = text(value);
  return normalized ? normalized.slice(0, 12) : 'n/d';
}

function renderLifecycleCounts(row) {
  const counts = row.lifecycleCounts;
  if (!counts) return 'unavailable';
  const byEvent = Object.entries(counts.byEvent || {})
    .filter(([, count]) => count > 0)
    .map(([eventType, count]) => `${eventType}:${count}`)
    .join(', ');
  return `state=${row.lifecycleState || 'unavailable'}; candidates ${counts.candidateCount}, complete ${counts.completeCount}, pending ${counts.pendingCount}, events ${counts.eventCount}; ${byEvent || 'no events'}`;
}

function renderIds(row) {
  const ids = row.ids || {};
  const candidates = Array.isArray(ids.candidateIds) ? ids.candidateIds : [];
  const records = Array.isArray(ids.lifecycleRecordIds) ? ids.lifecycleRecordIds : [];
  const sources = Array.isArray(ids.sourceRecordIds) ? ids.sourceRecordIds : [];
  const refs = Array.isArray(ids.artifactOrPrRefs) ? ids.artifactOrPrRefs : [];
  const candidateRange = candidates.length
    ? `${candidates[0]}${candidates.length > 1 ? `…${candidates.at(-1)}` : ''}`
    : 'n/d';
  const recordRange = records.length
    ? `${records[0]}${records.length > 1 ? `…${records.at(-1)}` : ''}`
    : 'n/d';
  return `run=${ids.runId || 'n/d'}; evidence=${ids.evidenceRunId || 'n/d'}; ledger=${ids.ledgerRunId || 'n/d'}; health=${ids.healthRecordId || 'n/d'}; candidates=${candidates.length} (${candidateRange}); records=${records.length} (${recordRange}); sources=${sources.length}; refs=${refs.length}; last=${ids.lastLifecycleEventId || 'n/d'}`;
}

function renderDeadline(row) {
  const sla = row.lifecycleSla;
  if (!sla) return 'unavailable';
  return `${sla.status}; next=${sla.nextDeadlineAt || 'n/d'}; TTL=${row.candidateTtlHours}h owner=${row.ownerSlaHours}h verify=${row.postMergeVerificationHours}h`;
}

function renderCompleteness(row) {
  if (row.tableComplete) return 'complete';
  const missing = row.tableCompleteness?.missing || ['row'];
  return `incomplete: ${missing.join(', ')}`;
}

export function renderMarkdown(rows) {
  const lines = [
    '## Loop fleet status',
    '',
    '| Loop | Owner | Ultimo run (ID/SHA) | Freshness | Ledger durable (ID/SHA) | Qualità | Issue | Missing outcome | Decisione | Autonomia effettiva / max | Telemetria operativa | TTL / SLA / verify | Rollback owner | Lifecycle counts | Lifecycle IDs | Deadline / SLA | Fonti dichiarate | Prossima azione automatica | Policy | Live table |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const run = row.lastRun
      ? `${row.lastRun.url ? `[${row.lastRun.conclusion}](${row.lastRun.url})` : row.lastRun.conclusion} #${row.lastRun.id || 'n/d'} @ ${row.lastRun.updatedAt || row.lastRun.createdAt || 'n/d'} sha ${shortSha(row.lastRun.headSha)}`
      : 'unavailable';
    const freshness = row.freshness
      ? `${row.freshness.status} @ ${row.freshness.asOf || 'n/d'} (${row.freshness.ageHours === null ? 'n/d' : `${row.freshness.ageHours}h`}; ${row.freshness.source || 'n/d'})`
      : 'unavailable';
    const ledger = row.ledgerLastRun
      ? `${row.ledgerLastRun.id || 'n/d'} @ ${row.ledgerLastRun.recordedAt || 'n/d'} sha ${shortSha(row.ledgerLastRun.headSha)}`
      : 'unavailable';
    const autonomy = `${row.actualAutonomy || 'n/d'} / ${row.maxAutonomy}`;
    const lifecycle = `${row.candidateTtlHours}h / ${row.ownerSlaHours}h / ${row.postMergeVerificationHours}h`;
    const telemetry = row.operationalMetrics
      ? `${row.operationalMetrics.complete ? 'complete' : 'partial'} (${row.operationalMetrics.durationSeconds ?? 'n/d'}s, retry ${row.operationalMetrics.retryCount ?? 'n/d'}, quota ${row.operationalMetrics.quotaUnits ?? 'n/d'}, collision ${row.operationalMetrics.collisions ?? 'n/d'}, bypass ${row.operationalMetrics.gateBypass ?? 'n/d'})`
      : 'unavailable';
    const sources = row.sourceRefs.join(', ');
    const issue = row.issue || '—';
    const missingOutcome = row.missingOutcome || '—';
    const policy = row.evidenceComplete && row.policyCompliant ? 'ok' : 'incomplete';
    lines.push(`| ${[
      row.loopId,
      row.owner,
      run,
      freshness,
      ledger,
      row.quality,
      issue,
      missingOutcome,
      row.decision,
      autonomy,
      telemetry,
      lifecycle,
      row.rollbackOwner,
      renderLifecycleCounts(row),
      renderIds(row),
      renderDeadline(row),
      sources,
      row.nextAutomaticAction,
      policy,
      renderCompleteness(row),
    ].map(markdownCell).join(' | ')} |`);
  }
  lines.push('', 'Qualità o evidenza assente = `unmeasurable`; il report non sintetizza zeri. `tableComplete=false` indica una sorgente live mancante o non verificabile.');
  return `${lines.join('\n')}\n`;
}

export function collectStatus({
  registryPath = DEFAULT_REGISTRY_PATH,
  ledgerDir = DEFAULT_LEDGER_DIR,
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-status-')),
  ghRun = latestRun,
  download = downloadEvidence,
  now = new Date(),
} = {}) {
  const registry = validateLoopRegistry(readJson(registryPath));
  const durable = readDurableHealth(ledgerDir, registry);
  const durableLifecycle = readDurableLifecycle(ledgerDir, registry, now);
  const runResults = {};
  const evidenceResults = {};
  for (const policy of registry.loops) {
    const workflow = workflowForPolicy(policy);
    const runResult = ghRun(workflow);
    runResults[policy.loopId] = runResult;
    const artifactResult = runResult.run
      ? download(policy.loopId, runResult.run, tempRoot, registry, now)
      : { evidence: null, error: runResult.error };
    evidenceResults[policy.loopId] = {
      ...artifactResult,
      canonicalHealth: durable.byLoop[policy.loopId] || null,
      canonicalLifecycle: durableLifecycle.available
        ? (durableLifecycle.byLoop[policy.loopId] || lifecycleSummary([], now))
        : null,
      canonicalError: durable.error || durableLifecycle.error,
    };
  }
  return buildStatusRows(registry, runResults, evidenceResults, { now });
}

export function summarizeStatusTable(rows = [], expectedRowCount = rows.length) {
  const missingRows = rows
    .filter((row) => row?.tableComplete !== true)
    .map((row) => ({
      loopId: row?.loopId || null,
      missing: row?.tableCompleteness?.missing || ['row'],
    }));
  return {
    expectedRowCount,
    rowCount: rows.length,
    complete: expectedRowCount > 0 && rows.length === expectedRowCount && missingRows.length === 0,
    missingRows,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outDir = path.resolve(valueAfter(argv, '--out-dir', process.env.REPORT_DIR || process.env.RUNNER_TEMP || os.tmpdir()));
  fs.mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const registryPath = valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH);
  const registry = validateLoopRegistry(readJson(registryPath));
  const rows = collectStatus({
    registryPath,
    ledgerDir: valueAfter(argv, '--ledger-dir', DEFAULT_LEDGER_DIR),
    now,
  });
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    table: summarizeStatusTable(rows, registry.loops.length),
    rows,
  };
  fs.writeFileSync(path.join(outDir, 'loop-fleet-status.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'loop-fleet-status.md'), renderMarkdown(rows));
  logger.log(renderMarkdown(rows));
  if (argv.includes('--strict') && rows.some((row) => !row.lastRun || !row.evidenceComplete || !row.policyCompliant)) process.exitCode = 2;
  if (argv.includes('--strict-live') && !report.table.complete) process.exitCode = 2;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-status] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
