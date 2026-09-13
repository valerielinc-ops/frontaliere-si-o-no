#!/usr/bin/env node

/** L1 — Reliability & UX. */
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

export const LOOP_ID = 'L1';
export const DEFAULT_TELEMETRY_PATH = path.join('data', 'error-triage-baseline.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 72;
export const MINIMUM_SAMPLE = 100;

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

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], snapshot = null }) {
  return {
    loopId: LOOP_ID,
    sourcePath,
    checkedAt: now.toISOString(),
    ok,
    quality,
    reason,
    issues,
    snapshot,
  };
}

/**
 * Validate an error/UX telemetry export without treating absent session data as
 * a clean session. The old baseline in this repository deliberately lacks the
 * session-level fields; that is a partial observation, not a derived metric.
 */
export function validateTelemetry(telemetry, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_TELEMETRY_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) {
    return baseVerdict({
      sourcePath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: 'telemetry is not a JSON object',
    });
  }

  const generatedAt = finiteDate(telemetry.generatedAt || telemetry._meta?.generatedAt);
  const usefulSessions = telemetry.usefulSessions ?? telemetry.metrics?.usefulSessions;
  const errorFreeUsefulSessions = telemetry.errorFreeUsefulSessions
    ?? telemetry.metrics?.errorFreeUsefulSessions;
  const issues = [];
  if (!generatedAt) issues.push('generatedAt is missing or invalid');
  if (!integer(usefulSessions)) issues.push('usefulSessions is missing or not a non-negative integer');
  if (!integer(errorFreeUsefulSessions)) {
    issues.push('errorFreeUsefulSessions is missing or not a non-negative integer');
  }
  if (integer(usefulSessions) && integer(errorFreeUsefulSessions)
      && errorFreeUsefulSessions > usefulSessions) {
    issues.push('errorFreeUsefulSessions exceeds usefulSessions');
  }

  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`telemetry is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (integer(usefulSessions) && usefulSessions < minimumSample) {
    issues.push(`usefulSessions is below minimum sample (${usefulSessions} < ${minimumSample})`);
  }

  const snapshot = {
    source: 'error-ux-telemetry',
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    usefulSessions: integer(usefulSessions) ? usefulSessions : null,
    errorFreeUsefulSessions: integer(errorFreeUsefulSessions) ? errorFreeUsefulSessions : null,
    fieldsPresent: integer(usefulSessions) && integer(errorFreeUsefulSessions),
  };

  let quality = 'observed';
  if (!generatedAt || !snapshot.fieldsPresent) quality = generatedAt ? 'partial' : 'unmeasurable';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if (usefulSessions === 0) quality = 'zero';
  else if (usefulSessions < minimumSample) quality = 'partial';

  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? `telemetry is complete, fresh and covers ${usefulSessions} useful sessions`
      : issues.join('; ') || `telemetry quality is ${quality}`,
    issues,
    snapshot,
  });
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L1 Reliability & UX — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.map((issue) => `- ${issue}`));
  return `${lines.join('\n')}\n`;
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l1-observation.json', observation],
    ['l1-decision.json', decision],
    ['l1-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeResult(reportDir, { verdict, issued, held }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l1-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issued,
    held,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L1 non può prendere una decisione affidabile sul percorso utile: il telemetria export non contiene una coorte completa e fresca.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere invariati il percorso utente e Auto Ads, ricollegare l’export a usefulSessions/errorFreeUsefulSessions e rieseguire il loop. Nessun rollback viene dedotto da una fonte parziale.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l1-reliability.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL1({
  now = new Date(),
  sourcePath = DEFAULT_TELEMETRY_PATH,
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
  try {
    if (!fs.existsSync(path.resolve(sourcePath))) throw new Error(`telemetry source is missing: ${sourcePath}`);
    const telemetry = JSON.parse(fs.readFileSync(path.resolve(sourcePath), 'utf8'));
    verdict = validateTelemetry(telemetry, { now, maxAgeHours, sourcePath, minimumSample: policyMinimumSample });
  } catch (error) {
    verdict = baseVerdict({
      sourcePath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
    });
  }
  const actionClass = verdict.ok ? 'observe' : 'issue+suspend-canary';
  const actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);

  const measurable = verdict.quality === 'observed' || verdict.quality === 'zero';
  const numerator = measurable ? verdict.snapshot.errorFreeUsefulSessions : null;
  const denominator = measurable ? verdict.snapshot.usefulSessions : null;
  const generatedAt = finiteDate(verdict.snapshot?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    hypothesis: 'A complete, fresh useful-session export is required before reliability changes are proposed.',
    sourceSnapshot: verdict.snapshot || { source: 'error-ux-telemetry', path: sourcePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'useful-sessions-without-observed-error',
    numerator,
    denominator,
    primaryMetric: loopPolicy.primaryMetric,
    guardrails: loopPolicy.guardrails,
    minimumSample: policyMinimumSample,
    actionClass,
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
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
    rollbackPlan: 'remove the runner-local hold marker; leave the user path and Auto Ads unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + loopPolicy.lifecycle.candidateTtlHours * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });

  const files = writeReports(reportDir, verdict, observation, decision);
  let issued = false;
  let held = false;
  if (apply && !verdict.ok && reportDir && actionPolicy) {
    fs.writeFileSync(path.join(path.resolve(reportDir), 'l1-canary-hold.json'), `${JSON.stringify({
      loopId: LOOP_ID,
      heldAt: now.toISOString(),
      reason: verdict.reason,
      actionClass,
      requiredAutonomy: actionPolicy.requiredAutonomy,
      maxAutonomy: loopPolicy.maxAutonomy,
      previousSurfaceUntouched: true,
      autoAdsUntouched: true,
    }, null, 2)}\n`);
    held = true;
  }
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L1 Reliability: telemetry cannot support a safe decision',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'reliability', 'loop-l1'],
      workflow: 'Loop L1 Reliability',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, held });
  logger.log(`[L1] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return {
    verdict,
    observation,
    decision,
    files: resultFile ? [...files, resultFile] : files,
    issued,
    held,
  };
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  return {
    json: argv.includes('--json'),
    issue: argv.includes('--issue'),
    apply: argv.includes('--apply'),
    strict: argv.includes('--strict'),
    dryRun: argv.includes('--dry-run'),
    sourcePath: valueAfter('--telemetry', DEFAULT_TELEMETRY_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours: Number(valueAfter('--max-age-hours', DEFAULT_MAX_AGE_HOURS)),
    minimumSample: Number(valueAfter('--minimum-sample', MINIMUM_SAMPLE)),
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l1')
      : path.join(os.tmpdir(), 'loop-fleet-l1')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL1({
    ...options,
    issue: options.issue && !options.dryRun,
    logger: runLogger,
  });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    issued: result.issued,
    held: result.held,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L1] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
