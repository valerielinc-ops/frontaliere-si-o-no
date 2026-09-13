#!/usr/bin/env node

/** L6 — Content Learning & Factuality. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  buildDecision,
  buildObservation,
  loadLoopPolicyForRun,
  validateActionClassAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';
import { buildValidatedLoopOutcome } from '../lib/loop-fleet-outcome.mjs';

export const LOOP_ID = 'L6';
export const DEFAULT_HISTORY_PATH = path.join('data', 'quality-alerts-history.jsonl');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'content-factuality-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 36;
export const MINIMUM_SAMPLE = 1;
export const MAX_CANDIDATES = 50;

const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3', 'INFO', 'WARN']);

function finiteDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], warnings = [], snapshot = null, candidates = [], invalidRecords = [] }) {
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
    invalidRecords,
  };
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `content factuality quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function isHeartbeat(record) {
  return record.id === 'heartbeat' || record.message === 'no alerts';
}

function candidateFor(record) {
  const evidence = object(record.evidence) ? record.evidence : {};
  return {
    sourceLine: record.line,
    defectId: record.id,
    severity: record.severity,
    articleId: evidence.articleId ?? evidence.slug ?? evidence.path ?? null,
    locale: evidence.locale ?? null,
    sourceUrl: text(evidence.sourceUrl) ? evidence.sourceUrl.trim() : null,
    actionClass: 'candidate',
    action: 'candidate-only: verify the claim against an external source and open a reviewed PR with a regression test',
    reversible: true,
    generatorIsNotOracle: true,
    publishedContentUntouched: true,
    requiresExternalSource: true,
    requiresLocaleVerification: true,
    requiresRegressionTest: true,
  };
}

/** Parse the append-only alert history without treating model prose as proof. */
export function validateQualityHistory(historyText, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_HISTORY_PATH,
} = {}) {
  const issues = [];
  const warnings = [];
  const candidates = [];
  const invalidRecords = [];
  const records = [];
  const lines = String(historyText ?? '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    const line = index + 1;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      const reason = `history line ${line}: invalid JSON (${error.message})`;
      issues.push(reason);
      invalidRecords.push({ line, raw, reason });
      continue;
    }
    const rowIssues = [];
    if (!object(record)) rowIssues.push('record is not an object');
    if (object(record)) {
      if (!text(record.timestamp)) rowIssues.push('timestamp is missing');
      else if (!finiteDate(record.timestamp)) rowIssues.push('timestamp is invalid');
      if (!text(record.id)) rowIssues.push('id is missing');
      if (!text(record.severity) || !SEVERITIES.has(record.severity)) rowIssues.push('severity is missing or unknown');
      if (!text(record.message)) rowIssues.push('message is missing');
      if (!object(record.evidence) && !isHeartbeat(record)) rowIssues.push('evidence is missing or not an object');
      const timestamp = finiteDate(record.timestamp);
      if (timestamp && timestamp.getTime() > now.getTime() + 5 * 60_000) rowIssues.push('timestamp is in the future');
    }
    if (rowIssues.length) {
      const reason = `history line ${line}: ${rowIssues.join(', ')}`;
      issues.push(reason);
      invalidRecords.push({ line, record, reason });
      continue;
    }
    const normalized = { ...record, line };
    records.push(normalized);
    if (!isHeartbeat(normalized)) candidates.push(candidateFor(normalized));
  }

  const timestamps = records.map((record) => finiteDate(record.timestamp)).filter(Boolean);
  const latest = timestamps.length ? new Date(Math.max(...timestamps.map((date) => date.getTime()))) : null;
  const latestAgeHours = latest ? hoursBetween(now, latest) : null;
  if (!records.length) issues.push('quality alert history has no valid records');
  if (latest && latestAgeHours > maxAgeHours) issues.push(`quality alert history is ${latestAgeHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  if (latest && latestAgeHours < -0.0834) issues.push('latest quality alert history record is in the future');

  const defectRecords = records.filter((record) => !isHeartbeat(record));
  if (!defectRecords.length && records.length) warnings.push('history contains only heartbeat records; no content defect was observed');
  const severityCounts = {};
  for (const record of defectRecords) severityCounts[record.severity] = (severityCounts[record.severity] || 0) + 1;
  const quality = !records.length
    ? 'unmeasurable'
    : (latestAgeHours > maxAgeHours ? 'stale' : (issues.length ? 'partial' : 'observed'));
  return {
    quality,
    issues,
    warnings,
    records,
    defectRecords,
    invalidRecords,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    snapshot: {
      path: sourcePath,
      recordCount: records.length,
      defectCount: defectRecords.length,
      invalidRecordCount: invalidRecords.length,
      heartbeatCount: records.length - defectRecords.length,
      latestTimestamp: latest?.toISOString() || null,
      latestAgeHours: latestAgeHours === null ? null : Number(latestAgeHours.toFixed(3)),
      severityCounts,
    },
  };
}

function validateOutcomes(outcomes, {
  now,
  maxAgeHours,
  sourcePath,
  minimumSample,
} = {}) {
  if (!object(outcomes)) {
    return {
      quality: 'partial',
      issues: ['content factuality outcome export is missing'],
      snapshot: {
        path: sourcePath,
        missing: true,
        independent: false,
        evidence: null,
        generatedAt: null,
        reviewedArticles: null,
        confirmedDefects: null,
        externallyVerifiedDefects: null,
        reopenedDefects: null,
        quality: 'partial',
      },
    };
  }
  const issues = [];
  const evidence = outcomes.evidence || outcomes.provenance;
  if (outcomes.independent !== true) {
    issues.push('outcomes.independent must be explicitly true for an independent factuality verdict');
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    issues.push('outcomes.evidence is missing or not an object');
  } else {
    if (!text(evidence.source)) issues.push('outcomes.evidence.source is missing');
    if (!Array.isArray(evidence.sourceRefs) || evidence.sourceRefs.length === 0 || evidence.sourceRefs.some((sourceRef) => !text(sourceRef))) {
      issues.push('outcomes.evidence.sourceRefs must be a non-empty array of text');
    }
    if (evidence.externalSourceVerified !== true && evidence.sourceVerified !== true) {
      issues.push('outcomes.evidence.externalSourceVerified must be explicitly true');
    }
    if (evidence.localeVerified !== true && evidence.localeChecked !== true) {
      issues.push('outcomes.evidence.localeVerified must be explicitly true');
    }
  }
  const generatedAt = finiteDate(outcomes.generatedAt || outcomes._meta?.generatedAt);
  const reviewedArticles = outcomes.reviewedArticles ?? outcomes.metrics?.reviewedArticles;
  const confirmedDefects = outcomes.confirmedDefects ?? outcomes.metrics?.confirmedDefects;
  const externallyVerifiedDefects = outcomes.externallyVerifiedDefects ?? outcomes.metrics?.externallyVerifiedDefects;
  const reopenedDefects = outcomes.reopenedDefects ?? outcomes.metrics?.reopenedDefects;
  if (!generatedAt) issues.push('outcomes.generatedAt is missing or invalid');
  for (const [name, value] of Object.entries({ reviewedArticles, confirmedDefects, externallyVerifiedDefects, reopenedDefects })) {
    if (!integer(value)) issues.push(`outcomes.${name} is missing or not a non-negative integer`);
  }
  if (integer(confirmedDefects) && integer(reviewedArticles) && confirmedDefects > reviewedArticles) issues.push('confirmedDefects exceeds reviewedArticles');
  if (integer(externallyVerifiedDefects) && integer(confirmedDefects) && externallyVerifiedDefects > confirmedDefects) issues.push('externallyVerifiedDefects exceeds confirmedDefects');
  if (integer(reopenedDefects) && integer(confirmedDefects) && reopenedDefects > confirmedDefects) issues.push('reopenedDefects exceeds confirmedDefects');
  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('outcomes.generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`content factuality outcomes are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (integer(reviewedArticles) && reviewedArticles < minimumSample && reviewedArticles > 0) {
    issues.push(`reviewedArticles is below minimum sample (${reviewedArticles} < ${minimumSample})`);
  }
  const snapshot = {
    path: sourcePath,
    missing: false,
    independent: outcomes.independent === true,
    evidence: evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? {
        source: text(evidence.source) ? evidence.source.trim() : null,
        sourceRefs: Array.isArray(evidence.sourceRefs) ? evidence.sourceRefs.filter(text).map((sourceRef) => sourceRef.trim()) : [],
        externalSourceVerified: evidence.externalSourceVerified === true || evidence.sourceVerified === true,
        localeVerified: evidence.localeVerified === true || evidence.localeChecked === true,
      }
      : null,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    reviewedArticles: integer(reviewedArticles) ? reviewedArticles : null,
    confirmedDefects: integer(confirmedDefects) ? confirmedDefects : null,
    externallyVerifiedDefects: integer(externallyVerifiedDefects) ? externallyVerifiedDefects : null,
    reopenedDefects: integer(reopenedDefects) ? reopenedDefects : null,
  };
  let quality = 'observed';
  if (!generatedAt || !integer(reviewedArticles) || !integer(confirmedDefects)
      || !integer(externallyVerifiedDefects) || !integer(reopenedDefects)) quality = 'partial';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if (reviewedArticles === 0 && issues.length === 0) quality = 'zero';
  else if (reviewedArticles < minimumSample || issues.length) quality = 'partial';
  snapshot.quality = quality;
  return { quality, issues, snapshot };
}

export function validateContentFactuality({ historyText, outcomes = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_HISTORY_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  const historyVerdict = validateQualityHistory(historyText, { now, maxAgeHours, sourcePath });
  const outcomeVerdict = validateOutcomes(outcomes, {
    now,
    maxAgeHours,
    sourcePath: outcomePath,
    minimumSample,
  });
  const issues = [...historyVerdict.issues, ...outcomeVerdict.issues];
  const warnings = [...historyVerdict.warnings];
  if (!outcomes) warnings.push('no independent factuality verdict is available; content changes stay candidate-only');
  const snapshot = {
    source: 'quality-alerts-history',
    historyPath: sourcePath,
    outcomePath,
    history: historyVerdict.snapshot,
    outcomes: outcomeVerdict.snapshot,
  };
  let quality = 'observed';
  if (historyVerdict.quality === 'unmeasurable') quality = 'unmeasurable';
  else if (historyVerdict.quality === 'stale' || outcomeVerdict.quality === 'stale') quality = 'stale';
  else if (issues.length) quality = 'partial';
  else if (outcomeVerdict.quality === 'zero') quality = 'zero';
  else if (outcomeVerdict.quality !== 'observed') quality = 'partial';
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? 'content defect observations have fresh independent external verification'
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates: historyVerdict.candidates,
    invalidRecords: historyVerdict.invalidRecords,
  });
}

function readText(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  return fs.readFileSync(absolute, 'utf8');
}

function readOptionalJson(filePath) {
  const absolute = path.resolve(filePath);
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : null;
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L6 Content Learning & Factuality — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.slice(0, 80).map((issue) => `- ${issue}`));
  if (verdict.warnings.length) lines.push('', '### Warnings', ...verdict.warnings.map((warning) => `- ${warning}`));
  if (verdict.candidates.length) lines.push('', '### Candidate fixes', ...verdict.candidates.slice(0, 50).map((candidate) => `- line ${candidate.sourceLine}: ${candidate.action}`));
  return `${lines.join('\n')}\n`;
}

function buildContentFactualityOutcome({ source, verdict, policy, registry, now }) {
  const outcomeSnapshot = verdict.snapshot?.outcomes || {};
  const generatedAt = finiteDate(outcomeSnapshot.generatedAt);
  const reviewedArticles = integer(outcomeSnapshot.reviewedArticles) ? outcomeSnapshot.reviewedArticles : null;
  const confirmedDefects = integer(outcomeSnapshot.confirmedDefects) ? outcomeSnapshot.confirmedDefects : null;
  const explicitIndependent = source?.independent === true;
  const outcomeQuality = outcomeSnapshot.quality || 'partial';
  const measurable = outcomeQuality === 'observed'
    && explicitIndependent
    && reviewedArticles !== null
    && confirmedDefects !== null;
  const status = measurable
    ? 'observed'
    : (outcomeQuality === 'stale' ? 'stale' : (outcomeQuality === 'unmeasurable' ? 'unmeasurable' : 'partial'));
  const outcome = buildValidatedLoopOutcome({
    registry,
    loopId: LOOP_ID,
    quality: status,
    independent: measurable,
    numerator: confirmedDefects,
    denominator: reviewedArticles,
    observedAt: generatedAt?.toISOString() || null,
    reason: measurable
      ? 'explicit independent source verdict with reviewed article and confirmed-defect counts'
      : `content factuality outcome is ${status}; published content remains unchanged`,
    now,
  });
  return {
    ...outcome,
    loopId: LOOP_ID,
    generatedAt: generatedAt?.toISOString() || null,
    reviewedArticles,
    confirmedDefects,
    externallyVerifiedDefects: integer(outcomeSnapshot.externallyVerifiedDefects) ? outcomeSnapshot.externallyVerifiedDefects : null,
    reopenedDefects: integer(outcomeSnapshot.reopenedDefects) ? outcomeSnapshot.reopenedDefects : null,
    metrics: {
      reviewedArticles,
      confirmedDefects,
      externallyVerifiedDefects: integer(outcomeSnapshot.externallyVerifiedDefects) ? outcomeSnapshot.externallyVerifiedDefects : null,
      reopenedDefects: integer(outcomeSnapshot.reopenedDefects) ? outcomeSnapshot.reopenedDefects : null,
    },
    evidence: outcomeSnapshot.evidence || {
      status: 'missing',
      sourcePath: outcomeSnapshot.path,
      sourceRefs: policy.outcome.sourceRefs,
    },
    evidenceStatus: outcomeSnapshot.missing ? 'missing' : (outcome.independent ? 'verified' : 'unverified'),
    sourcePath: outcomeSnapshot.path,
    generatorIsNotOracle: true,
    publishedContentUntouched: true,
    safeToAct: false,
    requiresExternalSource: true,
    requiresLocaleVerification: true,
    requiresRegressionTest: true,
  };
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l6-observation.json', observation],
    ['l6-decision.json', decision],
    ['l6-outcome.json', observation.outcome],
    ['l6-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now, loopRegistry) {
  if (!reportDir || verdict.ok || !loopRegistry) return null;
  const candidatePolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'candidate');
  const file = path.join(path.resolve(reportDir), 'l6-actions.json');
  const actions = [
    {
      actionClass: 'candidate',
      autonomy: candidatePolicy.requiredAutonomy,
      action: 'record a candidate correction only after independent source and locale verification',
      reversible: true,
      generatorIsNotOracle: true,
      publishedContentUntouched: true,
    },
    ...verdict.candidates.map((candidate) => ({
      ...candidate,
      actionClass: 'candidate',
      autonomy: candidatePolicy.requiredAutonomy,
    })),
  ];
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    appliesToPublishedContent: false,
    actions,
    rollback: 'discard runner-local candidates; leave published content and source history unchanged',
  }, null, 2)}\n`);
  return file;
}

function writeQuarantine(reportDir, verdict, now) {
  if (!reportDir || verdict.ok || !verdict.invalidRecords.length) return null;
  const file = path.join(path.resolve(reportDir), 'l6-quarantine.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    records: verdict.invalidRecords,
    publishedContentUntouched: true,
    rollback: 'discard this runner-local quarantine artifact after the source history is repaired and reviewed',
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten, quarantineWritten, outcome }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l6-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    warningCount: verdict.warnings.length,
    candidateCount: verdict.candidates.length,
    issued,
    actionsWritten,
    quarantineWritten,
    outcome,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L6 non può dichiarare un contenuto corretto solo perché un generatore o un alert lo suggerisce: serve evidenza di fonte esterna e coerenza di locale.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere il contenuto pubblicato invariato; conservare le righe invalide in quarantena runner-local e proporre una correzione revisionabile con fonte esterna, test di regressione e verifica del locale. Le osservazioni non sono verdetti LLM.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l6-content-factuality.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL6({
  now = new Date(),
  historyPath = DEFAULT_HISTORY_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  registryPath = DEFAULT_REGISTRY_PATH,
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
  let sourceOutcomes = null;
  try {
    sourceOutcomes = readOptionalJson(outcomePath);
    verdict = validateContentFactuality({
      historyText: readText(historyPath, 'quality alert history'),
      outcomes: sourceOutcomes,
    }, {
      now,
      maxAgeHours,
      sourcePath: historyPath,
      outcomePath,
      minimumSample: policyMinimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({
      sourcePath: historyPath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
    });
  }
  const measurable = verdict.quality === 'observed';
  const actionClass = verdict.ok ? 'observe' : 'quarantine+candidate+issue';
  const actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
  const candidatePolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'candidate');
  verdict = {
    ...verdict,
    candidates: verdict.candidates.map((candidate) => ({
      ...candidate,
      actionClass: 'candidate',
      autonomy: candidatePolicy.requiredAutonomy,
    })),
    snapshot: {
      ...verdict.snapshot,
      registry: {
        loopId: LOOP_ID,
        maxAutonomy: loopPolicy.maxAutonomy,
        actionClass,
        requiredAutonomy: actionPolicy.requiredAutonomy,
        actionClasses: loopPolicy.actionClasses,
      },
    },
  };
  const outcome = buildContentFactualityOutcome({ source: sourceOutcomes, verdict, policy: loopPolicy, registry: loopRegistry, now });
  const generatedAt = finiteDate(verdict.snapshot?.outcomes?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    hypothesis: 'A content defect is actionable only when an external source confirms the claim and the correction preserves the intended locale.',
    sourceSnapshot: verdict.snapshot || { source: 'quality-alerts-history', historyPath, outcomePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'articles-reviewed-against-independent-external-source',
    numerator: measurable ? verdict.snapshot.outcomes?.confirmedDefects ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.reviewedArticles ?? 0 : null,
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
    rollbackPlan: 'discard runner-local candidates and quarantine; leave published content and source history unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + loopPolicy.lifecycle.candidateTtlHours * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let actionsWritten = false;
  let quarantineWritten = false;
  if (apply && reportDir) {
    const actionFile = writeActions(reportDir, verdict, now, loopRegistry);
    const quarantineFile = writeQuarantine(reportDir, verdict, now);
    actionsWritten = Boolean(actionFile);
    quarantineWritten = Boolean(quarantineFile);
    if (actionFile) files.push(actionFile);
    if (quarantineFile) files.push(quarantineFile);
  }
  let issued = false;
  if (issue && !verdict.ok) {
    const issueResult = await createIssueImpl({
      title: 'L6 Content Factuality: independent source verdict is missing or invalid',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'content-quality', 'loop-l6'],
      workflow: 'Loop L6 Content Learning and Factuality',
    });
    if (!issueResult || issueResult.persisted !== true) {
      throw new Error('L6 issue persistence failed: createGithubIssue did not confirm persisted=true');
    }
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten, quarantineWritten, outcome });
  if (resultFile) files.push(resultFile);
  logger.log(`[L6] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return { verdict, observation, decision, outcome, files, issued, actionsWritten, quarantineWritten };
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
    historyPath: valueAfter('--history', DEFAULT_HISTORY_PATH),
    outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l6')
      : path.join(os.tmpdir(), 'loop-fleet-l6')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL6({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    outcome: result.outcome,
    issued: result.issued,
    actionsWritten: result.actionsWritten,
    quarantineWritten: result.quarantineWritten,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L6] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
