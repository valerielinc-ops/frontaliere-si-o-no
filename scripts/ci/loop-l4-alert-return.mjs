#!/usr/bin/env node

/** L4 — Alert → Return. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { buildValidatedLoopOutcome } from '../lib/loop-fleet-outcome.mjs';
import {
  buildDecision,
  buildObservation,
  loadLoopPolicyForRun,
  validateActionClassAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L4';
export const DEFAULT_CONFIG_PATH = path.join('data', 'alert-config.json');
export const DEFAULT_SNOOZES_PATH = path.join('data', 'alert-snoozes.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'alert-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 30;
export const MINIMUM_SAMPLE = 100;

const REQUIRED_CONFIG_NUMBERS = [
  'monoculture_threshold',
  'quota_oscillation_threshold',
  'winrate_collapse_threshold',
  'engagement_dive_threshold',
  'snooze_after_consecutive_days',
  'snooze_duration_days',
];

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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function validateConfig(config, issues) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    issues.push('alert config is not a JSON object');
    return false;
  }
  if (config.version !== 1) issues.push('alert config version must be 1');
  for (const key of REQUIRED_CONFIG_NUMBERS) {
    if (!finiteNumber(config[key])) issues.push(`alert config ${key} is missing or invalid`);
  }
  if (finiteNumber(config.snooze_duration_days) && config.snooze_duration_days < 1) {
    issues.push('alert config snooze_duration_days must be positive');
  }
  return true;
}

function validateSnoozes(snoozes, { now, candidates, issues }) {
  if (!snoozes || typeof snoozes !== 'object' || Array.isArray(snoozes)) {
    issues.push('alert snoozes is not a JSON object');
    return false;
  }
  if (snoozes.version !== 1) issues.push('alert snoozes version must be 1');
  if (!snoozes.snoozes || typeof snoozes.snoozes !== 'object' || Array.isArray(snoozes.snoozes)) {
    issues.push('alert snoozes.snoozes is missing or not an object');
    return false;
  }
  for (const [key, entry] of Object.entries(snoozes.snoozes)) {
    const prefix = `snoozes.${key}`;
    const rowIssues = [];
    if (!text(key)) rowIssues.push('snooze key is empty');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) rowIssues.push('entry is not an object');
    const consecutiveDays = entry?.consecutiveDays;
    if (!integer(consecutiveDays)) rowIssues.push('consecutiveDays is missing or invalid');
    const lastSeen = finiteDate(entry?.lastSeen);
    const snoozedUntil = finiteDate(entry?.snoozedUntil);
    if (!lastSeen) rowIssues.push('lastSeen is missing or invalid');
    if (!snoozedUntil) rowIssues.push('snoozedUntil is missing or invalid');
    if (lastSeen && snoozedUntil && snoozedUntil.getTime() < lastSeen.getTime()) {
      rowIssues.push('snoozedUntil precedes lastSeen');
    }
    if (snoozedUntil && snoozedUntil.getTime() > now.getTime() + 366 * 86_400_000) {
      rowIssues.push('snoozedUntil is implausibly far in the future');
    }
    if (rowIssues.length) {
      issues.push(`${prefix}: ${rowIssues.join(', ')}`);
      candidates.push({
        key,
        issueCodes: rowIssues,
        actionClass: 'suppress+defer',
        action: 'suppress/defer this alert until its consent and snooze window are repaired',
        reversible: true,
      });
    }
  }
  return true;
}

function validateOutcomes(outcomes, { now, maxAgeHours, sourcePath, minimumSample }) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) {
    return {
      quality: 'partial',
      issues: ['alert outcome export is missing'],
      snapshot: {
        path: sourcePath,
        generatedAt: null,
        eligibleConsentedUsers: null,
        deliveredAlerts: null,
        openedAlerts: null,
        clickedAlerts: null,
        returningUsers7d: null,
      },
    };
  }
  const issues = [];
  const generatedAt = finiteDate(outcomes.generatedAt || outcomes._meta?.generatedAt);
  const eligibleConsentedUsers = outcomes.eligibleConsentedUsers ?? outcomes.metrics?.eligibleConsentedUsers;
  const deliveredAlerts = outcomes.deliveredAlerts ?? outcomes.metrics?.deliveredAlerts;
  const openedAlerts = outcomes.openedAlerts ?? outcomes.metrics?.openedAlerts;
  const clickedAlerts = outcomes.clickedAlerts ?? outcomes.metrics?.clickedAlerts;
  const returningUsers7d = outcomes.returningUsers7d ?? outcomes.metrics?.returningUsers7d;
  const optional = {
    duplicateSends: outcomes.duplicateSends ?? outcomes.metrics?.duplicateSends,
    consentViolations: outcomes.consentViolations ?? outcomes.metrics?.consentViolations,
    suppressedWithoutConsent: outcomes.suppressedWithoutConsent ?? outcomes.metrics?.suppressedWithoutConsent,
    deferredAlerts: outcomes.deferredAlerts ?? outcomes.metrics?.deferredAlerts,
  };
  if (!generatedAt) issues.push('outcomes.generatedAt is missing or invalid');
  for (const [name, value] of Object.entries({ eligibleConsentedUsers, deliveredAlerts, openedAlerts, clickedAlerts, returningUsers7d })) {
    if (!integer(value)) issues.push(`outcomes.${name} is missing or not a non-negative integer`);
  }
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined && !integer(value)) issues.push(`outcomes.${name} is not a non-negative integer`);
  }
  if (integer(openedAlerts) && integer(deliveredAlerts) && openedAlerts > deliveredAlerts) issues.push('openedAlerts exceeds deliveredAlerts');
  if (integer(clickedAlerts) && integer(openedAlerts) && clickedAlerts > openedAlerts) issues.push('clickedAlerts exceeds openedAlerts');
  if (integer(returningUsers7d) && integer(eligibleConsentedUsers) && returningUsers7d > eligibleConsentedUsers) issues.push('returningUsers7d exceeds eligibleConsentedUsers');
  if (integer(optional.duplicateSends) && optional.duplicateSends > 0) issues.push(`duplicateSends is ${optional.duplicateSends}`);
  if (integer(optional.consentViolations) && optional.consentViolations > 0) issues.push(`consentViolations is ${optional.consentViolations}`);
  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('outcomes.generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`alert outcomes are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (integer(eligibleConsentedUsers) && eligibleConsentedUsers < minimumSample) {
    issues.push(`eligibleConsentedUsers is below minimum sample (${eligibleConsentedUsers} < ${minimumSample})`);
  }
  const snapshot = {
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    eligibleConsentedUsers: integer(eligibleConsentedUsers) ? eligibleConsentedUsers : null,
    deliveredAlerts: integer(deliveredAlerts) ? deliveredAlerts : null,
    openedAlerts: integer(openedAlerts) ? openedAlerts : null,
    clickedAlerts: integer(clickedAlerts) ? clickedAlerts : null,
    returningUsers7d: integer(returningUsers7d) ? returningUsers7d : null,
    duplicateSends: integer(optional.duplicateSends) ? optional.duplicateSends : null,
    consentViolations: integer(optional.consentViolations) ? optional.consentViolations : null,
    suppressedWithoutConsent: integer(optional.suppressedWithoutConsent) ? optional.suppressedWithoutConsent : null,
    deferredAlerts: integer(optional.deferredAlerts) ? optional.deferredAlerts : null,
  };
  let quality = 'observed';
  if (!generatedAt || !integer(eligibleConsentedUsers) || !integer(deliveredAlerts)
      || !integer(openedAlerts) || !integer(clickedAlerts) || !integer(returningUsers7d)) quality = 'partial';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if (eligibleConsentedUsers === 0) quality = 'zero';
  else if (eligibleConsentedUsers < minimumSample) quality = 'partial';
  return { quality, issues, snapshot };
}

/** Validate consent, delivery, deduplication and return evidence separately. */
export function validateAlertReturn({ config, snoozes, outcomes = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_CONFIG_PATH,
  snoozesPath = DEFAULT_SNOOZES_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  const issues = [];
  const warnings = [];
  const candidates = [];
  validateConfig(config, issues);
  validateSnoozes(snoozes, { now, candidates, issues });
  const outcomeVerdict = validateOutcomes(outcomes, {
    now,
    maxAgeHours,
    sourcePath: outcomePath,
    minimumSample,
  });
  issues.push(...outcomeVerdict.issues);
  if (!outcomes) warnings.push('no delivery export is available; safe automation stays suppress/defer only');
  const snapshot = {
    source: 'alert-config-and-snoozes',
    configPath: sourcePath,
    snoozesPath,
    outcomePath,
    snoozeCount: snoozes?.snoozes && typeof snoozes.snoozes === 'object' ? Object.keys(snoozes.snoozes).length : null,
    outcomes: outcomeVerdict.snapshot,
  };
  let quality = 'observed';
  if (!config || !snoozes || (snoozes && !snoozes.snoozes)) quality = 'unmeasurable';
  else if (outcomeVerdict.quality === 'stale') quality = 'stale';
  else if (outcomeVerdict.quality === 'zero') quality = 'zero';
  else if (issues.length || outcomeVerdict.quality !== 'observed') quality = 'partial';
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? 'alert consent, delivery, deduplication and return outcomes are fresh and coherent'
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates: candidates.sort((a, b) => String(a.key).localeCompare(String(b.key))),
  });
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `alert return quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
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
    `## L4 Alert → Return — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
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
  return `${lines.join('\n')}\n`;
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l4-observation.json', observation],
    ['l4-decision.json', decision],
    ['l4-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now, candidatePolicy) {
  if (!reportDir || verdict.ok || !candidatePolicy) return null;
  const file = path.join(path.resolve(reportDir), 'l4-safe-actions.json');
  const actions = [
    {
      actionClass: candidatePolicy.actionClass,
      autonomy: candidatePolicy.requiredAutonomy,
      action: 'suppress or defer any unsent alert lacking consent, deduplication proof or fresh outcome evidence',
      reversible: true,
      externalDeliveryUntouched: true,
    },
    ...verdict.candidates.map((candidate) => ({
      ...candidate,
      actionClass: 'suppress+defer',
      autonomy: candidatePolicy.requiredAutonomy,
    })),
  ];
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    appliesToExternalDelivery: false,
    actions,
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l4-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    warningCount: verdict.warnings.length,
    issued,
    actionsWritten,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L4 non può dichiarare che gli alert producano ritorno senza prova separata di consenso, consegna, deduplica e coorte di ritorno.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere invariati i destinatari e non inviare nuovi messaggi; sopprimere/deferire soltanto gli alert già eleggibili secondo i flag autorizzati, mantenendo consenso, quiet hours e deduplica fail-closed. Collegare l’export outcome prima di ottimizzare frequenza o CTA.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l4-alert-return.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL4({
  now = new Date(),
  configPath = DEFAULT_CONFIG_PATH,
  snoozesPath = DEFAULT_SNOOZES_PATH,
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
  try {
    verdict = validateAlertReturn({
      config: readJson(configPath, 'alert config'),
      snoozes: readJson(snoozesPath, 'alert snoozes'),
      outcomes: readOptionalJson(outcomePath),
    }, {
      now,
      maxAgeHours,
      sourcePath: configPath,
      snoozesPath,
      outcomePath,
      minimumSample: policyMinimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({ sourcePath: configPath, now, quality: 'unmeasurable', ok: false, reason: error.message });
  }
  const actionClass = verdict.ok ? 'observe' : 'suppress+defer+issue';
  const actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
  const candidatePolicy = !verdict.ok
    ? validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'suppress+defer')
    : null;
  verdict = {
    ...verdict,
    candidates: verdict.candidates.map((candidate) => ({
      ...candidate,
      actionClass: 'suppress+defer',
      autonomy: candidatePolicy?.requiredAutonomy || null,
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
  const measurable = verdict.quality === 'observed';
  const generatedAt = finiteDate(verdict.snapshot?.outcomes?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    hypothesis: 'An alert is useful only when a consented recipient receives a deduplicated message and voluntarily returns within the declared window.',
    sourceSnapshot: verdict.snapshot || { source: 'alert-config-and-snoozes', configPath, snoozesPath, outcomePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'consented-alert-eligible-users-with-seven-day-return',
    numerator: measurable ? verdict.snapshot.outcomes?.returningUsers7d ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.eligibleConsentedUsers ?? 0 : null,
    primaryMetric: loopPolicy.primaryMetric,
    guardrails: loopPolicy.guardrails,
    minimumSample: policyMinimumSample,
    actionClass,
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  observation.outcome = buildValidatedLoopOutcome({
    registry: loopRegistry,
    loopId: LOOP_ID,
    quality: verdict.quality,
    independent: verdict.ok,
    numerator: verdict.ok ? verdict.snapshot.outcomes?.returningUsers7d ?? 0 : null,
    denominator: verdict.ok ? verdict.snapshot.outcomes?.eligibleConsentedUsers ?? 0 : null,
    observedAt: generatedAt?.toISOString() || null,
    reason: verdict.ok
      ? 'consent, delivery and return sources agree on the seven-day cohort'
      : `alert-return outcome is ${verdict.quality}; no unsourced message is sent`,
    now,
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
    rollbackPlan: 'remove runner-local suppression/defer recommendations; leave external delivery and recipient state unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + loopPolicy.lifecycle.candidateTtlHours * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let actionsWritten = false;
  if (apply && reportDir) {
    const actionFile = writeActions(reportDir, verdict, now, candidatePolicy);
    actionsWritten = Boolean(actionFile);
    if (actionFile) files.push(actionFile);
  }
  let issued = false;
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L4 Alert to Return: consent or return outcome is not measurable',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'retention', 'loop-l4'],
      workflow: 'Loop L4 Alert to Return',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L4] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
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
    configPath: valueAfter('--config', DEFAULT_CONFIG_PATH),
    snoozesPath: valueAfter('--snoozes', DEFAULT_SNOOZES_PATH),
    outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l4')
      : path.join(os.tmpdir(), 'loop-fleet-l4')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL4({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
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
    console.error(`[L4] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
