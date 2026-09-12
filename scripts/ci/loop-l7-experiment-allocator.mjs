#!/usr/bin/env node

/** L7 — Experiment Allocator. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  actionAutonomy,
  buildDecision,
  buildObservation,
  findLoopPolicy,
  validateActionClassAgainstPolicy,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L7';
export const DEFAULT_CANDIDATES_PATH = path.join('data', 'experimental-candidates.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'experiment-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 192;
export const MINIMUM_SAMPLE = 200;
export const MAX_CANDIDATES = 50;
const LOCALES = new Set(['it', 'en', 'de', 'fr']);

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

function finiteScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], warnings = [], snapshot = null, candidates = [] }) {
  return { loopId: LOOP_ID, sourcePath, checkedAt: now.toISOString(), ok, quality, reason, issues, warnings, snapshot, candidates };
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `experiment allocator quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function candidateAction(candidate, rowIssues = []) {
  return {
    candidateId: candidate.id ?? null,
    keyword: text(candidate.keyword) ? candidate.keyword.trim() : null,
    locale: LOCALES.has(candidate.locale) ? candidate.locale : null,
    sources: Array.isArray(candidate.sources) ? candidate.sources.slice(0, 10) : [],
    issueCodes: rowIssues,
    actionClass: 'candidate',
    action: 'candidate-only: register persistent assignment, bounded exposure, guardrails and expiry before any canary',
    reversible: true,
    appliesToTraffic: false,
    noAutomaticPriceChange: true,
  };
}

/** Validate candidate provenance independently from any experiment outcome. */
export function validateCandidateRegistry(registry, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_CANDIDATES_PATH,
} = {}) {
  const issues = [];
  const warnings = [];
  const candidates = [];
  if (!object(registry)) {
    return {
      quality: 'unmeasurable',
      issues: ['experimental candidates is not a JSON object'],
      warnings,
      candidates,
      snapshot: { path: sourcePath, generatedAt: null, candidateCount: null, validCandidateCount: 0, invalidCandidateCount: 0 },
    };
  }
  const generatedAt = finiteDate(registry.generatedAt || registry._meta?.generatedAt);
  if (!generatedAt) issues.push('experimental candidates generatedAt is missing or invalid');
  const entries = registry.candidates;
  if (!Array.isArray(entries)) {
    issues.push('experimental candidates.candidates is missing or not an array');
  }
  const seen = new Set();
  let validCandidateCount = 0;
  const sourceCounts = {};
  for (const [index, candidate] of (entries || []).entries()) {
    const prefix = `candidates[${index}]`;
    const rowIssues = [];
    if (!object(candidate)) rowIssues.push('candidate is not an object');
    if (object(candidate)) {
      if (!text(candidate.id)) rowIssues.push('id is missing');
      else if (seen.has(candidate.id)) rowIssues.push(`duplicate id ${candidate.id}`);
      else seen.add(candidate.id);
      if (!text(candidate.keyword)) rowIssues.push('keyword is missing');
      if (!LOCALES.has(candidate.locale)) rowIssues.push('locale is missing or unsupported');
      if (!Array.isArray(candidate.sources) || candidate.sources.length === 0 || candidate.sources.some((source) => !text(source))) {
        rowIssues.push('sources must be a non-empty array of text');
      }
      for (const [name, value] of Object.entries({ demandScore: candidate.demandScore, noveltyScore: candidate.noveltyScore, totalScore: candidate.totalScore })) {
        if (!finiteScore(value)) rowIssues.push(`${name} is missing or not a score in [0,1]`);
      }
      if (!text(candidate.rationale)) warnings.push(`${prefix}.rationale is missing; provenance is weaker but candidate remains unpromoted`);
      for (const source of candidate.sources || []) if (text(source)) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    if (rowIssues.length) {
      issues.push(`${prefix}: ${rowIssues.join(', ')}`);
      continue;
    }
    validCandidateCount += 1;
    candidates.push(candidateAction(candidate));
  }
  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('experimental candidates generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`experimental candidates are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (!entries?.length) issues.push('experimental candidates array is explicitly empty');
  const quality = !entries || !entries.length
    ? 'unmeasurable'
    : (ageHours > maxAgeHours ? 'stale' : (issues.length ? 'partial' : 'observed'));
  return {
    quality,
    issues,
    warnings,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    snapshot: {
      path: sourcePath,
      generatedAt: generatedAt?.toISOString() || null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
      candidateCount: Array.isArray(entries) ? entries.length : null,
      validCandidateCount,
      invalidCandidateCount: Array.isArray(entries) ? entries.length - validCandidateCount : null,
      sourceCounts,
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
      issues: ['experiment outcome ledger is missing'],
      snapshot: {
        path: sourcePath,
        generatedAt: null,
        eligibleCohort: null,
        assignments: null,
        exposures: null,
        primaryOutcomes: null,
        guardrailBreaches: null,
        persistentAssignments: null,
        contaminatedAssignments: null,
        durationDays: null,
      },
    };
  }
  const issues = [];
  const generatedAt = finiteDate(outcomes.generatedAt || outcomes._meta?.generatedAt);
  const values = {
    eligibleCohort: outcomes.eligibleCohort ?? outcomes.metrics?.eligibleCohort,
    assignments: outcomes.assignments ?? outcomes.metrics?.assignments,
    exposures: outcomes.exposures ?? outcomes.metrics?.exposures,
    primaryOutcomes: outcomes.primaryOutcomes ?? outcomes.metrics?.primaryOutcomes,
    guardrailBreaches: outcomes.guardrailBreaches ?? outcomes.metrics?.guardrailBreaches,
    persistentAssignments: outcomes.persistentAssignments ?? outcomes.metrics?.persistentAssignments,
    contaminatedAssignments: outcomes.contaminatedAssignments ?? outcomes.metrics?.contaminatedAssignments,
  };
  if (!generatedAt) issues.push('outcomes.generatedAt is missing or invalid');
  for (const [name, value] of Object.entries(values)) if (!integer(value)) issues.push(`outcomes.${name} is missing or not a non-negative integer`);
  const durationDays = outcomes.durationDays ?? outcomes.metrics?.durationDays;
  if (!finitePositive(durationDays)) issues.push('outcomes.durationDays is missing or not positive');
  if (integer(values.exposures) && integer(values.assignments) && values.exposures > values.assignments) issues.push('outcomes.exposures exceeds outcomes.assignments');
  if (integer(values.primaryOutcomes) && integer(values.exposures) && values.primaryOutcomes > values.exposures) issues.push('outcomes.primaryOutcomes exceeds outcomes.exposures');
  if (integer(values.guardrailBreaches) && integer(values.exposures) && values.guardrailBreaches > values.exposures) issues.push('outcomes.guardrailBreaches exceeds outcomes.exposures');
  if (integer(values.persistentAssignments) && integer(values.assignments) && values.persistentAssignments > values.assignments) issues.push('outcomes.persistentAssignments exceeds outcomes.assignments');
  if (integer(values.contaminatedAssignments) && integer(values.assignments) && values.contaminatedAssignments > values.assignments) issues.push('outcomes.contaminatedAssignments exceeds outcomes.assignments');
  if (integer(values.guardrailBreaches) && values.guardrailBreaches > 0) issues.push('outcomes.guardrailBreaches is non-zero; the canary is not safe to continue');
  if (integer(values.contaminatedAssignments) && values.contaminatedAssignments > 0) issues.push('outcomes.contaminatedAssignments is non-zero; the assignment ledger is not clean');
  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('outcomes.generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`experiment outcomes are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (integer(values.eligibleCohort) && values.eligibleCohort > 0 && values.eligibleCohort < minimumSample) {
    issues.push(`eligibleCohort is below minimum sample (${values.eligibleCohort} < ${minimumSample})`);
  }
  if (integer(values.assignments) && values.assignments > 0 && values.assignments < minimumSample) {
    issues.push(`assignments is below minimum sample (${values.assignments} < ${minimumSample})`);
  }
  if (integer(values.exposures) && values.exposures > 0 && values.exposures < minimumSample) {
    issues.push(`exposures is below minimum sample (${values.exposures} < ${minimumSample})`);
  }
  if (integer(values.eligibleCohort) && values.eligibleCohort > 0
      && integer(values.assignments) && integer(values.exposures)
      && ((values.assignments === 0) !== (values.exposures === 0))) {
    issues.push('outcome participation is incomplete: assignments and exposures cannot be measured together');
  }
  const snapshot = {
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, integer(value) ? value : null])),
    durationDays: finitePositive(durationDays) ? durationDays : null,
  };
  let quality = 'observed';
  if (!generatedAt || Object.values(values).some((value) => !integer(value)) || !finitePositive(durationDays)) quality = 'partial';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if ((values.eligibleCohort === 0 || values.assignments === 0 || values.exposures === 0) && issues.length === 0) quality = 'zero';
  else if (issues.length) quality = 'partial';
  return { quality, issues, snapshot };
}

export function validateExperimentAllocator({ registry, outcomes = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_CANDIDATES_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
  loopRegistry = null,
} = {}) {
  const candidateVerdict = validateCandidateRegistry(registry, { now, maxAgeHours, sourcePath });
  const outcomeVerdict = validateOutcomes(outcomes, { now, maxAgeHours, sourcePath: outcomePath, minimumSample });
  const issues = [...candidateVerdict.issues, ...outcomeVerdict.issues];
  const warnings = [...candidateVerdict.warnings];
  let candidates = candidateVerdict.candidates;
  if (loopRegistry) {
    try {
      const candidatePolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'candidate');
      validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'candidate+stop+issue');
      candidates = candidates.map((candidate) => ({
        ...candidate,
        autonomy: candidatePolicy.requiredAutonomy,
      }));
    } catch (error) {
      candidates = [];
      issues.push(`registry policy is not compatible with L7 actions: ${error.message}`);
    }
  }
  if (!outcomes) warnings.push('no independent assignment/exposure/outcome ledger is available; no canary is authorized');
  const snapshot = {
    source: 'experimental-candidates',
    candidatesPath: sourcePath,
    outcomePath,
    candidates: candidateVerdict.snapshot,
    outcomes: outcomeVerdict.snapshot,
  };
  let quality = 'observed';
  if (candidateVerdict.quality === 'unmeasurable') quality = 'unmeasurable';
  else if (candidateVerdict.quality === 'stale' || outcomeVerdict.quality === 'stale') quality = 'stale';
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
      ? 'candidate provenance and independent experiment outcomes are fresh and coherent'
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

function readOptionalJson(filePath) {
  const absolute = path.resolve(filePath);
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : null;
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L7 Experiment Allocator — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Candidates: ${verdict.snapshot?.candidates?.candidateCount ?? 'n/a'}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.slice(0, 80).map((issue) => `- ${issue}`));
  if (verdict.warnings.length) lines.push('', '### Warnings', ...verdict.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l7-observation.json', observation],
    ['l7-decision.json', decision],
    ['l7-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now, loopRegistry) {
  if (!reportDir || verdict.ok || !loopRegistry) return null;
  const file = path.join(path.resolve(reportDir), 'l7-actions.json');
  const outcomes = verdict.snapshot?.outcomes;
  const guardrailBreaches = outcomes?.guardrailBreaches;
  const contaminatedAssignments = outcomes?.contaminatedAssignments;
  const actions = [];
  if ((integer(guardrailBreaches) && guardrailBreaches > 0)
      || (integer(contaminatedAssignments) && contaminatedAssignments > 0)) {
    actions.push({
      actionClass: 'stop',
      autonomy: actionAutonomy('stop', loopRegistry.actionAutonomy),
      action: 'recommend stopping the affected bounded canary pending guardrail and contamination review',
      reversible: true,
      appliesToTraffic: false,
      noAutomaticPriceChange: true,
    });
  }
  actions.push(...verdict.candidates);
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    appliesToTraffic: false,
    noAutomaticPriceChange: true,
    actions,
    rollback: 'discard runner-local recommendations; restore any canary only through the registered owner and expiry policy',
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l7-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    warningCount: verdict.warnings.length,
    candidateCount: verdict.candidates.length,
    issued,
    actionsWritten,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L7 non può allocare traffico a un esperimento senza registro di assegnazione persistente, outcome pre-registrato, guardrail e durata.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere invariati traffico, prezzi e configurazione commerciale; proporre soltanto un canary bounded con assegnazione persistente, campione minimo, guardrail espliciti, contaminazione controllata e scadenza.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l7-experiment-allocator.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL7({
  now = new Date(),
  candidatesPath = DEFAULT_CANDIDATES_PATH,
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
  let loopRegistry = null;
  let verdict;
  try {
    loopRegistry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
    findLoopPolicy(loopRegistry, LOOP_ID);
    verdict = validateExperimentAllocator({
      registry: readJson(candidatesPath, 'experimental candidates'),
      outcomes: readOptionalJson(outcomePath),
    }, { now, maxAgeHours, sourcePath: candidatesPath, outcomePath, minimumSample, loopRegistry });
  } catch (error) {
    verdict = baseVerdict({ sourcePath: candidatesPath, now, quality: 'unmeasurable', ok: false, reason: error.message });
  }
  const measurable = verdict.quality === 'observed' && verdict.ok;
  const generatedAt = finiteDate(verdict.snapshot?.outcomes?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime() ? generatedAt.toISOString() : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: 'Experiment Allocator',
    owner: 'CEO / Chief Mission',
    oracle: 'independent assignment, exposure, outcome and guardrail ledger',
    hypothesis: 'Only an experiment with persistent assignment, sufficient exposure, explicit outcome and clean guardrails merits more traffic.',
    sourceSnapshot: verdict.snapshot || { source: 'experimental-candidates', candidatesPath, outcomePath },
    observationWindow: { start: observationStart, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'pre-registered-experiment-eligible-cohort',
    numerator: measurable ? verdict.snapshot.outcomes?.primaryOutcomes ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.eligibleCohort ?? 0 : null,
    primaryMetric: 'registered_outcome_per_eligible_cohort',
    guardrails: ['persistent assignment', 'minimum sample', 'explicit expiry', 'no contamination', 'no automatic price change'],
    minimumSample,
    actionClass: verdict.ok ? 'observe' : 'candidate+stop+issue',
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: 'Experiment Allocator',
    owner: 'CEO / Chief Mission',
    oracle: 'independent assignment, exposure, outcome and guardrail ledger',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass: verdict.ok ? 'observe' : 'candidate+stop+issue',
    rollbackPlan: 'discard runner-local allocation recommendations; stop/restore only through the registered canary owner and expiry policy',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
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
      title: 'L7 Experiment Allocator: outcome or guardrail ledger is not trustworthy',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'experiments', 'loop-l7'],
      workflow: 'Loop L7 Experiment Allocator',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L7] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return { verdict, observation, decision, files, issued, actionsWritten };
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
    candidatesPath: valueAfter('--candidates', DEFAULT_CANDIDATES_PATH),
    outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l7') : path.join(os.tmpdir(), 'loop-fleet-l7')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL7({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    issued: result.issued,
    actionsWritten: result.actionsWritten,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L7] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
