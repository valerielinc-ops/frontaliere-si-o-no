#!/usr/bin/env node

/**
 * L10 — Engineering Learning / Fleet Control.
 *
 * This loop checks that loop executions can be trusted as an operational
 * sequence: every run belongs to a registered loop, writes a distinct result,
 * records retries and quota use, and never bypasses a gate. The quota ledger is
 * checked separately from the optional execution-health ledger. Missing health
 * data is not a successful run and never becomes zero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  buildDecision,
  buildOutcome,
  buildObservation,
  loadLoopPolicyForRun,
  validateActionClassAgainstPolicy,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L10';
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_QUOTA_PATH = path.join('data', 'quota-history.jsonl');
export const DEFAULT_HEALTH_PATH = path.join('data', 'loop-health-history.jsonl');
export const DEFAULT_MAX_AGE_HOURS = 48;
export const MINIMUM_SAMPLE = 1;
export const EXPECTED_LOOP_IDS = Object.freeze(Array.from({ length: 12 }, (_, index) => `L${index}`));
const CLOCK_SKEW_HOURS = 5 / 60;
const HEALTH_STATUSES = new Set(['success', 'failure', 'timeout', 'skipped']);
const QUOTA_DECISIONS = new Set(['hold', 'more discovery', 'less discovery']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteDate(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time) : null;
}

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], warnings = [], snapshot = null, candidates = [] }) {
  return {
    loopId: LOOP_ID,
    sourcePath,
    checkedAt: now.toISOString(),
    ok,
    quality,
    reason,
    issues,
    warnings,
    snapshot,
    candidates,
  };
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `fleet control quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function readJsonl(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    return { path: filePath, records: [], parseIssues: [`${label} is missing: ${filePath}`], missing: true };
  }
  const records = [];
  const parseIssues = [];
  for (const [index, line] of fs.readFileSync(absolute, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      parseIssues.push(`line ${index + 1}: invalid JSON (${error.message})`);
    }
  }
  return { path: filePath, records, parseIssues, missing: false };
}

function emptyQuotaSnapshot(sourcePath) {
  return {
    path: sourcePath,
    rowCount: null,
    validRowCount: 0,
    invalidRowCount: null,
    latestAt: null,
    ageHours: null,
    currentQuota: null,
    decisionCounts: {},
  };
}

function emptyHealthSnapshot(sourcePath) {
  return {
    path: sourcePath,
    missing: true,
    quality: 'unmeasurable',
    rowCount: null,
    validRowCount: 0,
    invalidRowCount: null,
    latestAt: null,
    ageHours: null,
    eligibleRuns: null,
    verifiedDecisions: null,
    successfulRuns: null,
    failedRuns: null,
    timeoutRuns: null,
    skippedRuns: null,
    retries: null,
    quotaUnits: null,
    artifactCollisions: null,
  };
}

function validateRegistry(registry, sourcePath) {
  const issues = [];
  let loops = [];
  try {
    ({ loops } = validateLoopRegistry(registry));
  } catch (error) {
    return {
      quality: 'unmeasurable',
      issues: [error.message],
      warnings: [],
      snapshot: { path: sourcePath, loopCount: null, loopIds: [], expectedLoopIds: EXPECTED_LOOP_IDS },
    };
  }
  const ids = loops.map((loop) => loop.loopId);
  const idSet = new Set(ids);
  for (const id of EXPECTED_LOOP_IDS) if (!idSet.has(id)) issues.push(`registry is missing ${id}`);
  for (const id of ids) if (!EXPECTED_LOOP_IDS.includes(id)) issues.push(`registry contains unexpected loop ${id}`);
  if (ids.length !== EXPECTED_LOOP_IDS.length) issues.push(`registry contains ${ids.length} loops; expected ${EXPECTED_LOOP_IDS.length}`);
  return {
    quality: issues.length ? 'partial' : 'observed',
    issues,
    warnings: [],
    snapshot: {
      path: sourcePath,
      schemaVersion: registry.schemaVersion,
      loopCount: loops.length,
      loopIds: ids,
      expectedLoopIds: EXPECTED_LOOP_IDS,
      maxAutonomy: Object.fromEntries(loops.map((loop) => [loop.loopId, loop.maxAutonomy])),
    },
  };
}

function validateQuotaHistory(history, { now, maxAgeHours, sourcePath }) {
  const records = Array.isArray(history?.records) ? history.records : [];
  const issues = Array.isArray(history?.parseIssues) ? [...history.parseIssues] : [];
  const warnings = [];
  const seen = new Set();
  const decisionCounts = {};
  let previous = null;
  let latest = null;
  let validRowCount = 0;
  for (const [index, row] of records.entries()) {
    const prefix = `quota[${index}]`;
    const rowIssues = [];
    if (!object(row)) {
      rowIssues.push('row is not an object');
    } else {
      const stamp = finiteDate(row.tunedAt);
      if (!stamp) rowIssues.push('tunedAt is missing or invalid');
      if (stamp && stamp.getTime() > now.getTime() + CLOCK_SKEW_HOURS * 3_600_000) rowIssues.push('tunedAt is in the future');
      if (stamp && seen.has(stamp.toISOString())) rowIssues.push(`tunedAt duplicates ${stamp.toISOString()}`);
      if (stamp) seen.add(stamp.toISOString());
      if (stamp && previous && stamp.getTime() < previous.getTime()) rowIssues.push('tunedAt is out of append order');
      if (stamp) previous = stamp;
      if (!integer(row.prevQuota)) rowIssues.push('prevQuota is missing or not a non-negative integer');
      if (!integer(row.newQuota)) rowIssues.push('newQuota is missing or not a non-negative integer');
      if (integer(row.newQuota) && row.newQuota > 1000) rowIssues.push('newQuota exceeds safe upper bound 1000');
      if (!QUOTA_DECISIONS.has(row.decision)) rowIssues.push('decision is missing or unsupported');
      if (!text(row.reason)) warnings.push(`${prefix}.reason is missing; quota rationale is weaker`);
      if (QUOTA_DECISIONS.has(row.decision) && integer(row.prevQuota) && integer(row.newQuota)) {
        if (row.decision === 'hold' && row.newQuota !== row.prevQuota) rowIssues.push('hold decision changes quota');
        if (row.decision === 'more discovery' && row.newQuota >= row.prevQuota) rowIssues.push('more discovery does not reduce proven quota');
        if (row.decision === 'less discovery' && row.newQuota <= row.prevQuota) rowIssues.push('less discovery does not increase proven quota');
      }
      const samples = object(row.samples) ? row.samples : null;
      if (!samples) rowIssues.push('samples is missing or not an object');
      for (const segment of ['proven', 'discovery']) {
        const sample = samples?.[segment];
        if (!object(sample) || !integer(sample.winners) || !integer(sample.total)) {
          rowIssues.push(`samples.${segment} is missing valid winners/total integers`);
        } else if (sample.winners > sample.total) {
          rowIssues.push(`samples.${segment}.winners exceeds total`);
        }
      }
      for (const [name, value] of Object.entries({
        provenWinRate: row.provenWinRate,
        discoveryWinRate: row.discoveryWinRate,
      })) if (!rate(value)) rowIssues.push(`${name} is missing or not in [0,1]`);
      if (row.ratio !== null && row.ratio !== undefined && !finiteNumber(row.ratio)) rowIssues.push('ratio must be a non-negative number or null');
      if (stamp && (!latest || stamp.getTime() > latest.stamp.getTime())) latest = { stamp, row };
    }
    if (rowIssues.length) issues.push(`${prefix}: ${rowIssues.join(', ')}`);
    else {
      validRowCount += 1;
      if (text(row.decision)) decisionCounts[row.decision] = (decisionCounts[row.decision] || 0) + 1;
    }
  }
  const ageHours = latest ? hoursBetween(now, latest.stamp) : null;
  if (!records.length) issues.push('quota history has no records');
  if (latest && ageHours < -CLOCK_SKEW_HOURS) issues.push('latest quota record is in the future');
  if (latest && ageHours > maxAgeHours) issues.push(`latest quota record is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  const quality = !records.length ? 'unmeasurable'
    : (ageHours !== null && ageHours > maxAgeHours ? 'stale' : (issues.length ? 'partial' : 'observed'));
  return {
    quality,
    issues,
    warnings,
    snapshot: {
      path: sourcePath,
      rowCount: records.length,
      validRowCount,
      invalidRowCount: records.length - validRowCount,
      latestAt: latest?.stamp.toISOString() || null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
      currentQuota: integer(latest?.row?.newQuota) ? latest.row.newQuota : null,
      decisionCounts,
    },
  };
}

function validateHealthHistory(history, { now, maxAgeHours, sourcePath, loopIds, minimumSample }) {
  if (!history || history.missing) {
    return {
      quality: 'unmeasurable',
      issues: ['loop health history is missing'],
      warnings: ['no execution is counted as verified until a producer writes the health ledger'],
      snapshot: emptyHealthSnapshot(sourcePath),
    };
  }
  const records = Array.isArray(history.records) ? history.records : [];
  const issues = Array.isArray(history.parseIssues) ? [...history.parseIssues] : [];
  const warnings = [];
  const knownLoops = new Set(loopIds);
  const seenRuns = new Set();
  const seenTimestamps = new Set();
  let previous = null;
  let latest = null;
  let validRowCount = 0;
  let eligibleRuns = 0;
  let verifiedDecisions = 0;
  let successfulRuns = 0;
  let failedRuns = 0;
  let timeoutRuns = 0;
  let skippedRuns = 0;
  let retries = 0;
  let quotaUnits = 0;
  let artifactCollisions = 0;

  for (const [index, row] of records.entries()) {
    const prefix = `health[${index}]`;
    const rowIssues = [];
    if (!object(row)) {
      rowIssues.push('row is not an object');
    } else {
      if (!text(row.runId)) rowIssues.push('runId is missing');
      else if (seenRuns.has(row.runId)) rowIssues.push(`duplicate runId ${row.runId}`);
      else seenRuns.add(row.runId);
      if (!knownLoops.has(row.loopId)) rowIssues.push(`loopId is not registered: ${String(row.loopId)}`);
      const stamp = finiteDate(row.generatedAt);
      if (!stamp) rowIssues.push('generatedAt is missing or invalid');
      if (stamp && stamp.getTime() > now.getTime() + CLOCK_SKEW_HOURS * 3_600_000) rowIssues.push('generatedAt is in the future');
      if (stamp && seenTimestamps.has(stamp.toISOString())) rowIssues.push(`generatedAt duplicates ${stamp.toISOString()}`);
      if (stamp) seenTimestamps.add(stamp.toISOString());
      if (stamp && previous && stamp.getTime() < previous.getTime()) rowIssues.push('generatedAt is out of append order');
      if (stamp) previous = stamp;
      if (!HEALTH_STATUSES.has(row.status)) rowIssues.push('status is missing or unsupported');
      if (typeof row.verifiedDecision !== 'boolean') rowIssues.push('verifiedDecision must be boolean');
      if (typeof row.gateBypass !== 'boolean') rowIssues.push('gateBypass must be boolean');
      if (!finiteNumber(row.durationSeconds)) rowIssues.push('durationSeconds is missing or not non-negative');
      if (!integer(row.retryCount)) rowIssues.push('retryCount is missing or not a non-negative integer');
      if (!finiteNumber(row.quotaUnits)) rowIssues.push('quotaUnits is missing or not non-negative');
      if (!integer(row.collisions)) rowIssues.push('collisions is missing or not a non-negative integer');
      if (!Array.isArray(row.artifactsWritten) || row.artifactsWritten.some((value) => !text(value))) {
        rowIssues.push('artifactsWritten must be an array of text');
      } else if (new Set(row.artifactsWritten).size !== row.artifactsWritten.length) {
        rowIssues.push('artifactsWritten contains duplicate paths');
      }
      if (row.status === 'success' && Array.isArray(row.artifactsWritten) && row.artifactsWritten.length === 0) rowIssues.push('success run has no output artifact');
      if (row.status === 'success' && row.verifiedDecision !== true) rowIssues.push('success run is not marked verifiedDecision');
      if (row.status === 'skipped' && row.verifiedDecision === true) rowIssues.push('skipped run cannot be a verified decision');
      if (row.gateBypass === true) rowIssues.push('gateBypass must remain false');
      if (integer(row.collisions) && row.collisions > 0) rowIssues.push(`artifact collisions detected: ${row.collisions}`);
      if (integer(row.retryCount) && row.retryCount > 0) warnings.push(`${prefix} used ${row.retryCount} retry/retries`);
      if (stamp && (!latest || stamp.getTime() > latest.stamp.getTime())) latest = { stamp, row };
    }
    if (rowIssues.length) issues.push(`${prefix}: ${rowIssues.join(', ')}`);
    else {
      validRowCount += 1;
      if (row.status === 'success') successfulRuns += 1;
      if (row.status === 'failure') failedRuns += 1;
      if (row.status === 'timeout') timeoutRuns += 1;
      if (row.status === 'skipped') skippedRuns += 1;
      if (row.status !== 'skipped') eligibleRuns += 1;
      if (row.status === 'success' && row.verifiedDecision && !row.gateBypass) verifiedDecisions += 1;
      retries += row.retryCount;
      quotaUnits += row.quotaUnits;
      artifactCollisions += row.collisions;
    }
  }
  const ageHours = latest ? hoursBetween(now, latest.stamp) : null;
  if (!records.length) issues.push('loop health history has no records');
  if (eligibleRuns > 0 && eligibleRuns < minimumSample) {
    issues.push(`eligible loop runs are below minimum sample (${eligibleRuns} < ${minimumSample})`);
  }
  if (latest && ageHours < -CLOCK_SKEW_HOURS) issues.push('latest loop health record is in the future');
  if (latest && ageHours > maxAgeHours) issues.push(`latest loop health record is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  const quality = !records.length ? 'unmeasurable'
    : (ageHours !== null && ageHours > maxAgeHours ? 'stale' : (eligibleRuns === 0 && issues.length === 0 ? 'zero' : (issues.length ? 'partial' : 'observed')));
  return {
    quality,
    issues,
    warnings,
    snapshot: {
      path: sourcePath,
      missing: false,
      rowCount: records.length,
      validRowCount,
      invalidRowCount: records.length - validRowCount,
      latestAt: latest?.stamp.toISOString() || null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
      eligibleRuns,
      verifiedDecisions,
      successfulRuns,
      failedRuns,
      timeoutRuns,
      skippedRuns,
      retries,
      quotaUnits: Number(quotaUnits.toFixed(3)),
      artifactCollisions,
      quality,
    },
  };
}

export function validateFleetControl({ registry, quota, health = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  registryPath = DEFAULT_REGISTRY_PATH,
  quotaPath = DEFAULT_QUOTA_PATH,
  healthPath = DEFAULT_HEALTH_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  const registryVerdict = validateRegistry(registry, registryPath);
  const quotaVerdict = validateQuotaHistory(quota, { now, maxAgeHours, sourcePath: quotaPath });
  const healthVerdict = validateHealthHistory(health, {
    now,
    maxAgeHours,
    sourcePath: healthPath,
    loopIds: registryVerdict.snapshot?.loopIds || EXPECTED_LOOP_IDS,
    minimumSample,
  });
  const issues = [...registryVerdict.issues, ...quotaVerdict.issues, ...healthVerdict.issues];
  const warnings = [...registryVerdict.warnings, ...quotaVerdict.warnings, ...healthVerdict.warnings];
  const snapshot = {
    source: 'fleet-registry-plus-quota-and-health-ledgers',
    registry: registryVerdict.snapshot,
    quota: quotaVerdict.snapshot,
    health: healthVerdict.snapshot,
  };
  let quality = 'observed';
  if (registryVerdict.quality === 'unmeasurable' || quotaVerdict.quality === 'unmeasurable' || healthVerdict.quality === 'unmeasurable') quality = 'unmeasurable';
  else if (registryVerdict.quality === 'stale' || quotaVerdict.quality === 'stale' || healthVerdict.quality === 'stale') quality = 'stale';
  else if (healthVerdict.quality === 'zero') quality = 'zero';
  else if (issues.length || registryVerdict.quality !== 'observed' || quotaVerdict.quality !== 'observed' || healthVerdict.quality !== 'observed') quality = 'partial';
  const candidates = [];
  if (healthVerdict.quality === 'unmeasurable') {
    candidates.push({
      actionClass: 'route',
      action: 'route every loop producer to append a health row with runId, status, verified decision, artifacts, retries and quota usage',
      reversible: true,
      externalMutation: false,
      gateBypass: false,
    });
  }
  if (registryVerdict.quality !== 'observed' || quotaVerdict.quality !== 'observed' || healthVerdict.quality === 'partial') {
    candidates.push({
      actionClass: 'follow-up',
      action: 'prepare a reviewed PR to repair registry, quota or health schema/cardinality; never bypass a failing gate',
      reversible: true,
      externalMutation: false,
      gateBypass: false,
    });
  }
  if ((healthVerdict.snapshot?.artifactCollisions || 0) > 0 || (healthVerdict.snapshot?.retries || 0) > 0 || healthVerdict.quality !== 'observed') {
    candidates.push({
      actionClass: 'lock+retry',
      action: 'apply a runner-local per-artifact lock, bounded queue and capped retry policy before another write; leave gates enforced',
      reversible: true,
      externalMutation: false,
      gateBypass: false,
    });
  }
  for (const candidate of candidates) {
    try {
      const policy = validateActionClassAgainstPolicy(registry, LOOP_ID, candidate.actionClass);
      candidate.autonomy = policy.requiredAutonomy;
      candidate.maxAutonomy = policy.maxAutonomy;
    } catch (error) {
      candidate.autonomy = null;
      candidate.policyError = error.message;
    }
  }
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath: registryPath,
    now,
    quality,
    ok,
    reason: ok
      ? 'registry, quota decisions and execution-health ledger are fresh and operationally coherent'
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates,
  });
}

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function reportMarkdown(verdict, observation, decision) {
  const registry = verdict.snapshot?.registry || {};
  const quota = verdict.snapshot?.quota || {};
  const health = verdict.snapshot?.health || {};
  const lines = [
    `## L10 Fleet Control — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Registry: ${registry.loopCount ?? 'unmeasurable'} loops (${registry.path || 'missing'})`,
    `- Quota ledger: ${quota.validRowCount ?? 'unmeasurable'} valid rows, latest ${quota.latestAt || 'unmeasurable'}`,
    `- Health ledger: ${health.validRowCount ?? 'unmeasurable'} valid rows, verified decisions ${health.verifiedDecisions ?? 'unmeasurable'}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.slice(0, 100).map((issue) => `- ${issue}`));
  if (verdict.warnings.length) lines.push('', '### Warnings', ...verdict.warnings.slice(0, 60).map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

function buildFleetControlOutcome({ verdict, policy, now }) {
  const health = verdict.snapshot?.health || {};
  const generatedAt = finiteDate(health.latestAt);
  const eligibleRuns = integer(health.eligibleRuns) ? health.eligibleRuns : null;
  const verifiedDecisions = integer(health.verifiedDecisions) ? health.verifiedDecisions : null;
  const measurable = verdict.ok
    && health.quality === 'observed'
    && eligibleRuns !== null
    && verifiedDecisions !== null;
  const outcomeQuality = health.quality || verdict.quality || 'unmeasurable';
  const status = measurable
    ? 'observed'
    : (outcomeQuality === 'stale' ? 'stale' : (outcomeQuality === 'unmeasurable' ? 'unmeasurable' : 'partial'));
  const requiredFieldsPresent = measurable
    ? policy.outcome.requiredFields.slice()
    : (generatedAt ? ['generatedAt'] : []);
  const missingFields = policy.outcome.requiredFields.filter((field) => !requiredFieldsPresent.includes(field));
  const outcome = buildOutcome({
    outcomeId: policy.outcome.outcomeId,
    status,
    independent: measurable,
    sourceRefs: policy.outcome.sourceRefs,
    primaryMetric: policy.primaryMetric,
    numerator: measurable ? verifiedDecisions : null,
    denominator: measurable ? eligibleRuns : null,
    requiredFieldsPresent,
    missingFields,
    reason: measurable
      ? 'fresh health ledger confirms eligible runs, verified decisions and gate-preserving artifacts'
      : `fleet control outcome is ${status}; no throughput is inferred from missing or invalid health rows`,
    observedAt: generatedAt?.toISOString() || null,
    allowNumeratorExceedDenominator: false,
    recordedAt: now.toISOString(),
  });
  return {
    ...outcome,
    loopId: LOOP_ID,
    generatedAt: generatedAt?.toISOString() || null,
    metrics: {
      eligibleRuns,
      verifiedDecisions,
      successfulRuns: integer(health.successfulRuns) ? health.successfulRuns : null,
      failedRuns: integer(health.failedRuns) ? health.failedRuns : null,
      timeoutRuns: integer(health.timeoutRuns) ? health.timeoutRuns : null,
      skippedRuns: integer(health.skippedRuns) ? health.skippedRuns : null,
      retries: integer(health.retries) ? health.retries : null,
      quotaUnits: finiteNumber(health.quotaUnits) ? health.quotaUnits : null,
      artifactCollisions: integer(health.artifactCollisions) ? health.artifactCollisions : null,
    },
    evidence: {
      source: 'loop-health-history',
      sourcePath: health.path,
      sourceRefs: policy.outcome.sourceRefs,
      status: measurable ? 'verified' : 'unverified',
    },
    evidenceStatus: health.missing ? 'missing' : (measurable ? 'verified' : 'unverified'),
    sourcePath: health.path,
    safeToAct: false,
    oneWriterPerArtifact: true,
    boundedRetries: true,
    ledgerWriteMode: 'serialized-atomic',
    gateBypass: false,
    supervisorL11Separate: true,
    publishedDataUntouched: true,
  };
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l10-observation.json', observation],
    ['l10-decision.json', decision],
    ['l10-outcome.json', observation.outcome],
    ['l10-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now, registry) {
  if (!reportDir || verdict.ok) return null;
  if (!registry) return null;
  const actions = verdict.candidates.map((candidate) => {
    const actionClass = candidate.actionClass || 'follow-up';
    const policy = validateActionClassAgainstPolicy(registry, LOOP_ID, actionClass);
    return {
      ...candidate,
      actionClass,
      autonomy: policy.requiredAutonomy,
      maxAutonomy: policy.maxAutonomy,
    };
  });
  const file = path.join(path.resolve(reportDir), 'l10-safe-actions.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    oneWriterPerArtifact: true,
    boundedQueues: true,
    gateBypass: false,
    githubWorkflowInventoryReviewDelegatedTo: 'L11 technical-operations-supervisor',
    actions,
    rollback: 'remove only runner-local lock/queue plans and reports; do not bypass gates or mutate published artifacts',
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten, outcome }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l10-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    warningCount: verdict.warnings.length,
    candidateCount: verdict.candidates.length,
    issued,
    actionsWritten,
    outcome,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  const health = verdict.snapshot?.health || {};
  return [
    'L10 non può considerare affidabile la flotta finché registro, quota e salute delle esecuzioni non sono coerenti.',
    '',
    `- Registry: ${verdict.snapshot?.registry?.path || 'missing'}`,
    `- Quota ledger: ${verdict.snapshot?.quota?.path || 'missing'}`,
    `- Health ledger: ${health.path || 'missing'}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: serializzare le scritture per artifact, limitare retry e code, mantenere i gate obbligatori e proporre le correzioni tramite PR revisionabile. La revisione di tutti i workflow è eseguita dal supervisore tecnico L11.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l10-fleet-control.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL10({
  now = new Date(),
  registryPath = DEFAULT_REGISTRY_PATH,
  quotaPath = DEFAULT_QUOTA_PATH,
  healthPath = DEFAULT_HEALTH_PATH,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  minimumSample = MINIMUM_SAMPLE,
  issue = false,
  apply = false,
  reportDir = null,
  createIssueImpl = createGithubIssue,
  logger = console,
} = {}) {
  const {
    registry: loopRegistry,
    policy: loopPolicy,
    minimumSample: policyMinimumSample,
  } = loadLoopPolicyForRun(registryPath, LOOP_ID, minimumSample);
  let verdict;
  try {
    const quota = readJsonl(quotaPath, 'quota history');
    const health = readJsonl(healthPath, 'loop health history');
    verdict = validateFleetControl({ registry: loopRegistry, quota, health }, {
      now,
      maxAgeHours,
      registryPath,
      quotaPath,
      healthPath,
      minimumSample: policyMinimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({
      sourcePath: registryPath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
      snapshot: {
        source: 'fleet-registry-plus-quota-and-health-ledgers',
        registry: { path: registryPath },
        quota: emptyQuotaSnapshot(quotaPath),
        health: emptyHealthSnapshot(healthPath),
      },
      candidates: [{
        actionClass: 'follow-up',
        action: 'prepare a reviewed PR to restore or repair the fleet control inputs; preserve all gates',
        reversible: true,
        externalMutation: false,
        gateBypass: false,
      }],
    });
  }
  const actionClass = verdict.ok ? 'observe' : 'route+lock+retry+follow-up';
  const actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
  verdict = {
    ...verdict,
    snapshot: {
      ...verdict.snapshot,
      registry: {
        ...(verdict.snapshot?.registry || {}),
        loopId: LOOP_ID,
        maxAutonomy: loopPolicy.maxAutonomy,
        actionClass,
        requiredAutonomy: actionPolicy.requiredAutonomy,
        actionClasses: loopPolicy.actionClasses,
      },
    },
  };
  const outcome = buildFleetControlOutcome({ verdict, policy: loopPolicy, now });
  const measurable = verdict.quality === 'observed' && verdict.ok;
  const health = verdict.snapshot?.health || {};
  const candidateStarts = [
    finiteDate(verdict.snapshot?.quota?.latestAt),
    finiteDate(health.latestAt),
  ].filter((value) => value && value.getTime() <= now.getTime());
  const observationStart = candidateStarts.length
    ? new Date(Math.min(...candidateStarts.map((value) => value.getTime()))).toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    hypothesis: 'A loop decision is operationally useful only when its execution, artifact writes, retries, quota usage and gate status are independently auditable.',
    sourceSnapshot: verdict.snapshot || { registryPath, quotaPath, healthPath },
    observationWindow: { start: observationStart, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'non-skipped-loop-executions-with-verifiable-artifacts',
    numerator: measurable ? health.verifiedDecisions : null,
    denominator: measurable ? health.eligibleRuns : null,
    primaryMetric: loopPolicy.primaryMetric,
    guardrails: loopPolicy.guardrails,
    minimumSample: policyMinimumSample,
    actionClass,
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  observation.outcome = outcome;
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass,
    rollbackPlan: 'remove runner-local queue/lock plans and reports; never bypass a gate or rewrite a published artifact',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + loopPolicy.lifecycle.candidateTtlHours * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let actionsWritten = false;
  if (apply && reportDir) {
    const actionFile = writeActions(reportDir, verdict, now, loopRegistry);
    actionsWritten = Boolean(actionFile);
    if (actionFile) files.push(actionFile);
  }
  let issued = false;
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L10 Fleet Control: execution health or quota ledger is not trustworthy',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'fleet-control', 'loop-l10'],
      workflow: 'Loop L10 Engineering Learning and Fleet Control',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten, outcome });
  if (resultFile) files.push(resultFile);
  logger.log(`[L10] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return { verdict, observation, decision, outcome, files, issued, actionsWritten };
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  const maxAgeHours = Number(valueAfter('--max-age-hours', DEFAULT_MAX_AGE_HOURS));
  const minimumSample = Number(valueAfter('--minimum-sample', MINIMUM_SAMPLE));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('--max-age-hours must be a finite positive number');
  if (!Number.isInteger(minimumSample) || minimumSample < 1) throw new Error('--minimum-sample must be a positive integer');
  return {
    json: argv.includes('--json'),
    issue: argv.includes('--issue'),
    apply: argv.includes('--apply'),
    strict: argv.includes('--strict'),
    dryRun: argv.includes('--dry-run'),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    quotaPath: valueAfter('--quota', DEFAULT_QUOTA_PATH),
    healthPath: valueAfter('--health', DEFAULT_HEALTH_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l10')
      : path.join(os.tmpdir(), 'loop-fleet-l10')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL10({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    outcome: result.outcome,
    issued: result.issued,
    actionsWritten: result.actionsWritten,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L10] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
