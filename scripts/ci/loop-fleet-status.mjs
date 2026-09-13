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
  REQUIRED_LIFECYCLE_EVENT_TYPES,
  validateActionClassAgainstPolicy,
  validateLifecycleEvent,
  validateLoopRegistry,
  validateOutcomeAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const DEFAULT_LEDGER_DIR = path.join('data', 'loop-fleet', 'ledger');
const LOOP_WORKFLOWS = Object.freeze({
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

function artifactName(loopId, runId) {
  if (loopId === 'L11') return `technical-operations-audit-${runId}`;
  return `${LOOP_WORKFLOWS[loopId].replace(/\.yml$/u, '')}-${runId}`;
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

export function summarizeLifecycleEvents(events) {
  const byCandidate = new Map();
  for (const event of events || []) {
    const candidateId = text(event?.candidateId);
    if (!candidateId) continue;
    if (!byCandidate.has(candidateId)) byCandidate.set(candidateId, []);
    byCandidate.get(candidateId).push(event);
  }
  const candidates = [...byCandidate.entries()].map(([candidateId, candidateEvents]) => {
    const eventTypes = [...new Set(candidateEvents.map((event) => event.eventType))];
    const missing = REQUIRED_LIFECYCLE_EVENT_TYPES.filter((eventType) => !eventTypes.includes(eventType));
    const sorted = [...candidateEvents].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    return {
      candidateId,
      owner: candidateEvents[0].owner,
      eventTypes,
      missing,
      complete: missing.length === 0,
      lastEvent: sorted.at(-1) ? {
        eventType: sorted.at(-1).eventType,
        occurredAt: sorted.at(-1).occurredAt,
      } : null,
    };
  });
  const last = [...(events || [])].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)).at(-1);
  return {
    available: true,
    eventCount: (events || []).length,
    candidateCount: candidates.length,
    complete: candidates.length ? candidates.every((candidate) => candidate.complete) : null,
    state: candidates.length === 0
      ? 'no_candidate'
      : (candidates.every((candidate) => candidate.complete) ? 'verified' : 'candidate'),
    lastEvent: last ? { eventType: last.eventType, occurredAt: last.occurredAt } : null,
    candidates,
  };
}

function readDurableLifecycle(ledgerDir, registry) {
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
      byLoop: Object.fromEntries(Object.entries(byLoop).map(([loopId, events]) => [loopId, summarizeLifecycleEvents(events)])),
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

function downloadEvidence(loopId, run, tempRoot, registry) {
  const runId = typeof run === 'object' ? run.databaseId : run;
  const target = path.join(tempRoot, loopId.toLowerCase());
  fs.mkdirSync(target, { recursive: true });
  const downloaded = ghRaw(['run', 'download', String(runId), '--name', artifactName(loopId, runId), '--dir', target], { allowFailure: true });
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
    return { evidence: { ...evidence, health }, lifecycleEvents: summarizeLifecycleEvents(lifecycleEvents), error: null };
  } catch (error) {
    return { evidence: null, error: `canonical evidence is invalid JSON: ${error.message}` };
  }
}

export function buildStatusRows(registry, runResults, evidenceResults) {
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
    const evidenceError = evidenceResult.canonicalError || evidenceResult.error || runResult.error
      || (!outcomePolicyCompliant ? 'canonical outcome policy is missing or noncompliant' : null)
      || (evidence && !lifecycleCompliant ? 'canonical lifecycle evidence is missing or noncompliant' : null);
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
    const nextHumanAction = evidenceError
      ? 'restore or attach the independent source and rerun the loop'
      : (missingOutcome
        ? 'validate or attach the independent outcome before changing exposure'
        : (lifecycleIncomplete
          ? 'advance the candidate through PR, tests, review, merge and post-merge verification'
          : 'review the recorded outcome and close the observation window'));
    return {
      loopId: policy.loopId,
      goal: policy.goal,
      owner: policy.owner,
      cadence: policy.cadence,
      primaryMetric: policy.primaryMetric,
      maxAutonomy: policy.maxAutonomy,
      lifecycle: policy.lifecycle,
      sourceRefs: policy.sourceRefs,
      candidateTtlHours: policy.lifecycle.candidateTtlHours,
      ownerSlaHours: policy.lifecycle.ownerSlaHours,
      postMergeVerificationHours: policy.lifecycle.postMergeVerificationHours,
      lastRun: runResult.run ? {
        id: runResult.run.databaseId || null,
        conclusion: runResult.run.conclusion || runResult.run.status || 'unknown',
        createdAt: runResult.run.createdAt || null,
        updatedAt: runResult.run.updatedAt || null,
        headSha: runResult.run.headSha || null,
        url: runResult.run.url || null,
      } : null,
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
      nextHumanAction,
      nextAction: nextHumanAction,
      issueCount,
      warningCount,
      outcome,
      outcomePolicyCompliant,
      lifecycleEvents,
      lifecycleState: lifecycleEvents?.state || 'unavailable',
      lifecycleEventCount: lifecycleEvents?.eventCount ?? null,
      lifecycleComplete: lifecycleEvents?.complete ?? null,
      historyAvailable: Boolean(durableHealth),
      ledgerLastRun: durableHealth ? {
        id: durableHealth.execution?.runId || null,
        recordedAt: durableHealth.recordedAt || durableHealth.execution?.recordedAt || null,
        headSha: durableHealth.execution?.sha || null,
      } : null,
    };
  });
}

function renderMarkdown(rows) {
  const lines = [
    '## Loop fleet status',
    '',
    '| Loop | Owner | Ultimo run | Ledger durable | Qualità | Issue | Missing outcome | Decisione | Autonomia effettiva / max | TTL / SLA / verify | Lifecycle | Fonti dichiarate | Next human action | Policy |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const run = row.lastRun ? `[${row.lastRun.conclusion}](${row.lastRun.url || '#'})` : 'n/d';
    const ledger = row.ledgerLastRun
      ? `${row.ledgerLastRun.id || 'n/d'} @ ${row.ledgerLastRun.recordedAt || 'n/d'}`
      : 'n/d';
    const autonomy = `${row.actualAutonomy || 'n/d'} / ${row.maxAutonomy}`;
    const lifecycle = `${row.candidateTtlHours}h / ${row.ownerSlaHours}h / ${row.postMergeVerificationHours}h`;
    const lifecycleState = row.lifecycleEvents
      ? `${row.lifecycleState} (${row.lifecycleEventCount ?? 'n/d'})`
      : 'unavailable';
    const sources = row.sourceRefs.join(', ');
    const issue = row.issue || '—';
    const missingOutcome = row.missingOutcome || '—';
    const policy = row.evidenceComplete && row.policyCompliant ? 'ok' : 'incomplete';
    lines.push(`| ${row.loopId} | ${row.owner} | ${run} | ${ledger} | ${row.quality} | ${issue} | ${missingOutcome} | ${row.decision} | ${autonomy} | ${lifecycle} | ${lifecycleState} | ${sources} | ${row.nextHumanAction} | ${policy} |`);
  }
  lines.push('', 'Qualità o evidenza assente = `unmeasurable`; il report non sintetizza zeri.');
  return `${lines.join('\n')}\n`;
}

export function collectStatus({
  registryPath = DEFAULT_REGISTRY_PATH,
  ledgerDir = DEFAULT_LEDGER_DIR,
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-status-')),
  ghRun = latestRun,
  download = downloadEvidence,
} = {}) {
  const registry = validateLoopRegistry(readJson(registryPath));
  const durable = readDurableHealth(ledgerDir, registry);
  const durableLifecycle = readDurableLifecycle(ledgerDir, registry);
  const runResults = {};
  const evidenceResults = {};
  for (const policy of registry.loops) {
    const workflow = LOOP_WORKFLOWS[policy.loopId];
    const runResult = ghRun(workflow);
    runResults[policy.loopId] = runResult;
    const artifactResult = runResult.run
      ? download(policy.loopId, runResult.run, tempRoot, registry)
      : { evidence: null, error: runResult.error };
    evidenceResults[policy.loopId] = {
      ...artifactResult,
      canonicalHealth: durable.byLoop[policy.loopId] || null,
      canonicalLifecycle: durableLifecycle.available
        ? (durableLifecycle.byLoop[policy.loopId] || summarizeLifecycleEvents([]))
        : null,
      canonicalError: durable.error || durableLifecycle.error,
    };
  }
  return buildStatusRows(registry, runResults, evidenceResults);
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outDir = path.resolve(valueAfter(argv, '--out-dir', process.env.REPORT_DIR || process.env.RUNNER_TEMP || os.tmpdir()));
  fs.mkdirSync(outDir, { recursive: true });
  const rows = collectStatus({
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
    ledgerDir: valueAfter(argv, '--ledger-dir', DEFAULT_LEDGER_DIR),
  });
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), rows };
  fs.writeFileSync(path.join(outDir, 'loop-fleet-status.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'loop-fleet-status.md'), renderMarkdown(rows));
  logger.log(renderMarkdown(rows));
  if (argv.includes('--strict') && rows.some((row) => !row.lastRun || !row.evidenceComplete || !row.policyCompliant)) process.exitCode = 2;
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
