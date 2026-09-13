#!/usr/bin/env node

/** L5 — Decision Moments. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  AUTONOMY_ORDER,
  actionAutonomy,
  buildDecision,
  buildObservation,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L5';
export const DEFAULT_FUEL_PATH = path.join('data', 'fuel-prices.json');
export const DEFAULT_BORDER_PATH = path.join('data', 'border-wait-current.json');
export const DEFAULT_PHARMACY_PATH = path.join('data', 'pharmacies-ticino.json');
export const DEFAULT_DUTY_PATH = path.join('data', 'pharmacy-duties-ticino.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'decision-moment-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 36;
export const MINIMUM_SAMPLE = 100;


const SURFACES = [
  { key: 'calculator', path: '/calcola-stipendio/', label: 'calcolatore stipendio' },
  { key: 'fuel', path: '/prezzi-diesel/oggi/', label: 'confronto carburante' },
  { key: 'border', path: '/guida-frontaliere/tempi-attesa-dogana/', label: 'tempi alle dogane' },
  { key: 'pharmacy', path: '/farmacie-di-turno/', label: 'farmacie di turno' },
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

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function httpsUrl(value) {
  if (!text(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function registryPolicy(registry) {
  const validated = validateLoopRegistry(registry);
  const policy = validated.loops.find((loop) => loop.loopId === LOOP_ID);
  if (!policy) throw new TypeError(`loop-fleet contract: registry has no ${LOOP_ID} policy`);
  return { policy, actionAutonomy: validated.actionAutonomy };
}

function applyRegistryPolicy(candidates, registry, issues) {
  if (!registry) return { candidates, snapshot: null, valid: true };
  let policy;
  let actionAutonomyMap;
  try {
    ({ policy, actionAutonomy: actionAutonomyMap } = registryPolicy(registry));
  } catch (error) {
    issues.push(error.message);
    return { candidates: [], snapshot: null, valid: false };
  }
  const accepted = [];
  for (const candidate of candidates) {
    const actionClass = candidate.actionClass || 'candidate';
    if (!policy.actionClasses.includes(actionClass)) {
      issues.push(`registry disallows ${LOOP_ID} action class ${actionClass}`);
      continue;
    }
    let requiredAutonomy;
    try {
      requiredAutonomy = actionAutonomy(actionClass, actionAutonomyMap);
    } catch (error) {
      issues.push(error.message);
      continue;
    }
    if (AUTONOMY_ORDER[requiredAutonomy] > AUTONOMY_ORDER[policy.maxAutonomy]) {
      issues.push(`registry disallows ${LOOP_ID} autonomy ${requiredAutonomy} (max ${policy.maxAutonomy})`);
      continue;
    }
    accepted.push({ ...candidate, actionClass, autonomy: requiredAutonomy });
  }
  return {
    candidates: accepted,
    snapshot: {
      loopId: LOOP_ID,
      maxAutonomy: policy.maxAutonomy,
      actionClasses: policy.actionClasses,
      actionAutonomy: actionAutonomyMap,
    },
    valid: true,
  };
}

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], warnings = [], snapshot = null, candidates = [] }) {
  return { loopId: LOOP_ID, sourcePath, checkedAt: now.toISOString(), ok, quality, reason, issues, warnings, snapshot, candidates };
}

function checkFreshness(value, label, { now, maxAgeHours, issues }) {
  const date = finiteDate(value);
  if (!date) {
    issues.push(`${label} is missing or invalid`);
    return null;
  }
  const ageHours = hoursBetween(now, date);
  if (ageHours < -0.0834) issues.push(`${label} is in the future`);
  if (ageHours > maxAgeHours) issues.push(`${label} is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  return { iso: date.toISOString(), ageHours: Number(ageHours.toFixed(3)) };
}

function validateFuel(fuel, { now, maxAgeHours, issues }) {
  if (!fuel || typeof fuel !== 'object' || Array.isArray(fuel)) {
    issues.push('fuel source is not a JSON object');
    return { present: false, generatedAt: null, municipalityCount: null };
  }
  const freshness = checkFreshness(fuel.generatedAt, 'fuel.generatedAt', { now, maxAgeHours, issues });
  const summary = fuel.summary;
  if (!summary || typeof summary !== 'object') issues.push('fuel.summary is missing or not an object');
  for (const key of ['municipalityCount', 'municipalitiesWithItalyPrices', 'municipalitiesWithSwissComparison', 'cheaperItalyCount', 'cheaperSwissCount', 'tieCount']) {
    if (!integer(summary?.[key])) issues.push(`fuel.summary.${key} is missing or invalid`);
  }
  if (integer(summary?.municipalitiesWithItalyPrices) && integer(summary?.municipalityCount)
      && summary.municipalitiesWithItalyPrices > summary.municipalityCount) issues.push('fuel Italy municipality count exceeds total');
  if (integer(summary?.municipalitiesWithSwissComparison) && integer(summary?.municipalitiesWithItalyPrices)
      && summary.municipalitiesWithSwissComparison > summary.municipalitiesWithItalyPrices) issues.push('fuel Swiss comparison count exceeds Italy-covered count');
  const swissUpdate = checkFreshness(fuel.sources?.switzerland?.latestObservedUpdate, 'fuel Swiss latestObservedUpdate', { now, maxAgeHours, issues });
  if (!integer(fuel.sources?.switzerland?.stationCount)) issues.push('fuel Swiss stationCount is missing or invalid');
  if (!integer(fuel.sources?.switzerland?.dieselStationCount)) issues.push('fuel Swiss dieselStationCount is missing or invalid');
  if (!finiteNumber(fuel.sources?.exchangeRate?.chfPerEur)) issues.push('fuel exchange rate is missing or invalid');
  return {
    present: true,
    generatedAt: freshness?.iso || null,
    ageHours: freshness?.ageHours ?? null,
    swissUpdate: swissUpdate?.iso || null,
    municipalityCount: integer(summary?.municipalityCount) ? summary.municipalityCount : null,
  };
}

function validateBorder(border, { now, maxAgeHours, issues, candidates }) {
  if (!border || typeof border !== 'object' || Array.isArray(border)) {
    issues.push('border source is not a JSON object');
    return { present: false, updatedAt: null, crossings: null };
  }
  const freshness = checkFreshness(border.updatedAt, 'border.updatedAt', { now, maxAgeHours, issues });
  const crossings = border.perCrossing;
  if (!crossings || typeof crossings !== 'object' || Array.isArray(crossings)) {
    issues.push('border.perCrossing is missing or not an object');
    return { present: true, updatedAt: freshness?.iso || null, crossings: null };
  }
  const statuses = new Set(['green', 'yellow', 'orange', 'red', 'unknown']);
  let valid = 0;
  for (const [key, entry] of Object.entries(crossings)) {
    const prefix = `border.perCrossing.${key}`;
    if (!integer(entry?.waitTimeMinutes) || !integer(entry?.approachMinutes) || !integer(entry?.totalCrossingMinutes)) {
      issues.push(`${prefix}: crossing minutes are missing or invalid`);
      continue;
    }
    if (entry.totalCrossingMinutes !== entry.waitTimeMinutes + entry.approachMinutes) issues.push(`${prefix}: total minutes do not reconcile with wait plus approach`);
    if (!statuses.has(entry.status)) issues.push(`${prefix}: status is invalid`);
    if (!text(entry.source)) issues.push(`${prefix}: source is missing`);
    checkFreshness(entry.lastUpdate, `${prefix}.lastUpdate`, { now, maxAgeHours, issues });
    valid += 1;
  }
  if (valid === 0) issues.push('border has no valid crossing records');
  candidates.push(...SURFACES.filter((surface) => surface.key === 'border').map((surface) => ({
    surface: surface.key,
    landingPath: surface.path,
    actionClass: 'candidate',
    action: 'reorder a sourced same-corridor bridge or CTA through a reviewed PR',
    autonomy: 'A2',
    reversible: true,
  })));
  return { present: true, updatedAt: freshness?.iso || null, crossings: Object.keys(crossings).length, validCrossings: valid };
}

function validatePharmacies(pharmacies, { now, maxAgeHours, issues, candidates }) {
  if (!pharmacies || typeof pharmacies !== 'object' || Array.isArray(pharmacies)) {
    issues.push('pharmacy source is not a JSON object');
    return { present: false, fetchedAt: null, pharmacies: null };
  }
  const freshness = checkFreshness(pharmacies._fetchedAt, 'pharmacies._fetchedAt', { now, maxAgeHours: Math.max(maxAgeHours, 96), issues });
  if (!Array.isArray(pharmacies.pharmacies)) issues.push('pharmacies.pharmacies is missing or not an array');
  if (!integer(pharmacies._pharmacyCount)) issues.push('pharmacies._pharmacyCount is missing or invalid');
  if (integer(pharmacies._pharmacyCount) && Array.isArray(pharmacies.pharmacies) && pharmacies._pharmacyCount !== pharmacies.pharmacies.length) {
    issues.push('pharmacies._pharmacyCount does not match pharmacies.length');
  }
  let valid = 0;
  for (const [index, pharmacy] of (pharmacies.pharmacies || []).entries()) {
    const prefix = `pharmacies[${index}]`;
    const rowIssues = [];
    for (const key of ['id', 'name', 'city']) if (!text(pharmacy?.[key])) rowIssues.push(`${key} is missing`);
    if (pharmacy?.country !== 'CH') rowIssues.push('country is not CH');
    if (!httpsUrl(pharmacy?.sourceUrl)) rowIssues.push('sourceUrl is not HTTPS');
    if (!finiteDate(pharmacy?.lastVerifiedAt)) rowIssues.push('lastVerifiedAt is invalid');
    if (rowIssues.length) issues.push(`${prefix}: ${rowIssues.join(', ')}`);
    else valid += 1;
  }
  candidates.push(...SURFACES.filter((surface) => surface.key === 'pharmacy').map((surface) => ({
    surface: surface.key,
    landingPath: surface.path,
    actionClass: 'candidate',
    action: 'add a sourced freshness reminder or related tool bridge through a reviewed PR',
    autonomy: 'A2',
    reversible: true,
  })));
  return { present: true, fetchedAt: freshness?.iso || null, pharmacies: Array.isArray(pharmacies.pharmacies) ? pharmacies.pharmacies.length : null, validPharmacies: valid };
}

function validateDuties(duties, { now, maxAgeHours, issues }) {
  if (!duties || typeof duties !== 'object' || Array.isArray(duties)) {
    issues.push('pharmacy duty source is not a JSON object');
    return { present: false, fetchedAt: null, duties: null };
  }
  const freshness = checkFreshness(duties._fetchedAt, 'duties._fetchedAt', { now, maxAgeHours: Math.max(maxAgeHours, 96), issues });
  if (!Array.isArray(duties.duties)) issues.push('duties.duties is missing or not an array');
  let valid = 0;
  for (const [index, duty] of (duties.duties || []).entries()) {
    const prefix = `duties[${index}]`;
    const starts = finiteDate(duty?.startsAt);
    const ends = finiteDate(duty?.endsAt);
    if (!text(duty?.id) || !text(duty?.pharmacyId)) issues.push(`${prefix}: id or pharmacyId is missing`);
    if (!starts || !ends) issues.push(`${prefix}: startsAt or endsAt is invalid`);
    else if (ends.getTime() <= starts.getTime()) issues.push(`${prefix}: endsAt does not follow startsAt`);
    if (!httpsUrl(duty?.sourceUrl)) issues.push(`${prefix}: sourceUrl is not HTTPS`);
    if (duty?.status !== 'verified' && duty?.status !== 'expired') issues.push(`${prefix}: status is invalid`);
    if (starts && ends && ends.getTime() > starts.getTime() && httpsUrl(duty?.sourceUrl)) valid += 1;
  }
  return { present: true, fetchedAt: freshness?.iso || null, duties: Array.isArray(duties.duties) ? duties.duties.length : null, validDuties: valid };
}

function validateOutcomes(outcomes, { now, maxAgeHours, minimumSample, issues, outcomePath }) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) {
    issues.push('decision-moment outcome export is missing');
    return { quality: 'partial', snapshot: { path: outcomePath, generatedAt: null, eligibleDecisionSessions: null, nextUsefulActions: null } };
  }
  const generated = checkFreshness(outcomes.generatedAt || outcomes._meta?.generatedAt, 'outcomes.generatedAt', { now, maxAgeHours, issues });
  const eligibleDecisionSessions = outcomes.eligibleDecisionSessions ?? outcomes.metrics?.eligibleDecisionSessions;
  const nextUsefulActions = outcomes.nextUsefulActions ?? outcomes.metrics?.nextUsefulActions;
  if (!integer(eligibleDecisionSessions)) issues.push('outcomes.eligibleDecisionSessions is missing or invalid');
  if (!integer(nextUsefulActions)) issues.push('outcomes.nextUsefulActions is missing or invalid');
  if (integer(nextUsefulActions) && integer(eligibleDecisionSessions) && nextUsefulActions > eligibleDecisionSessions) issues.push('outcomes.nextUsefulActions exceeds eligibleDecisionSessions');
  if (integer(eligibleDecisionSessions) && eligibleDecisionSessions < minimumSample) issues.push(`eligibleDecisionSessions is below minimum sample (${eligibleDecisionSessions} < ${minimumSample})`);
  const snapshot = {
    path: outcomePath,
    generatedAt: generated?.iso || null,
    ageHours: generated?.ageHours ?? null,
    eligibleDecisionSessions: integer(eligibleDecisionSessions) ? eligibleDecisionSessions : null,
    nextUsefulActions: integer(nextUsefulActions) ? nextUsefulActions : null,
  };
  let quality = 'observed';
  if (!generated || !integer(eligibleDecisionSessions) || !integer(nextUsefulActions)) quality = 'partial';
  else if ((generated.ageHours ?? 0) < -0.0834 || (generated.ageHours ?? 0) > maxAgeHours) quality = 'stale';
  else if (eligibleDecisionSessions === 0) quality = 'zero';
  else if (eligibleDecisionSessions < minimumSample) quality = 'partial';
  return { quality, snapshot };
}

/** Validate all high-intent surfaces before proposing a next useful bridge. */
export function validateDecisionMoments({ fuel, border, pharmacies, duties, outcomes = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_FUEL_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
  registry = null,
} = {}) {
  const issues = [];
  const warnings = [];
  const candidates = [];
  const fuelSnapshot = validateFuel(fuel, { now, maxAgeHours, issues });
  const borderSnapshot = validateBorder(border, { now, maxAgeHours, issues, candidates });
  const pharmacySnapshot = validatePharmacies(pharmacies, { now, maxAgeHours, issues, candidates });
  const dutySnapshot = validateDuties(duties, { now, maxAgeHours, issues });
  const outcomeVerdict = validateOutcomes(outcomes, { now, maxAgeHours, minimumSample, issues, outcomePath });
  if (!outcomes) warnings.push('decision outcome join is missing; bridge candidates stay review-only');
  const registryResult = applyRegistryPolicy(candidates, registry, issues);
  const snapshot = {
    source: 'decision-surfaces',
    sources: {
      fuel: fuelSnapshot,
      border: borderSnapshot,
      pharmacies: pharmacySnapshot,
      duties: dutySnapshot,
    },
    outcomes: outcomeVerdict.snapshot,
    registry: registryResult.snapshot,
  };
  let quality = 'observed';
  if (!registryResult.valid || !fuelSnapshot.present || !borderSnapshot.present || !pharmacySnapshot.present || !dutySnapshot.present) quality = 'unmeasurable';
  else if (outcomeVerdict.quality === 'stale') quality = 'stale';
  else if (outcomeVerdict.quality === 'zero') quality = 'zero';
  else if (issues.length || outcomeVerdict.quality !== 'observed') quality = 'partial';
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok ? 'decision surfaces are fresh and next useful actions are measured' : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates: registryResult.candidates.slice(0, SURFACES.length),
  });
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `decision-moment quality is ${quality}`;
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
    `## L5 Decision Moments — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Candidates: ${verdict.candidates.length}`,
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
    ['l5-observation.json', observation],
    ['l5-decision.json', decision],
    ['l5-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now) {
  if (!reportDir || verdict.ok) return null;
  const registry = verdict.snapshot?.registry;
  if (!registry || !Object.hasOwn(AUTONOMY_ORDER, registry.maxAutonomy)
      || !Array.isArray(registry.actionClasses) || !registry.actionAutonomy) return null;
  const allowed = (action) => {
    const actionClass = action.actionClass || 'candidate';
    if (!registry.actionClasses.includes(actionClass)) return false;
    let requiredAutonomy;
    try {
      requiredAutonomy = actionAutonomy(actionClass, registry.actionAutonomy);
    } catch {
      return false;
    }
    return action.autonomy === requiredAutonomy
      && AUTONOMY_ORDER[requiredAutonomy] <= AUTONOMY_ORDER[registry.maxAutonomy];
  };
  const file = path.join(path.resolve(reportDir), 'l5-safe-actions.json');
  const actions = [
    {
      autonomy: registry.actionAutonomy['stale-label'],
      actionClass: 'stale-label',
      action: 'label a stale or incomplete surface and suppress any unsupported freshness promise',
      reversible: true,
      publishedDataUntouched: true,
    },
    ...verdict.candidates,
  ].filter(allowed);
  fs.writeFileSync(file, `${JSON.stringify({ loopId: LOOP_ID, generatedAt: now.toISOString(), noDarkPatterns: true, actions }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l5-result.json');
  fs.writeFileSync(file, `${JSON.stringify({ loopId: LOOP_ID, ok: verdict.ok, quality: verdict.quality, issueCount: verdict.issues.length, warningCount: verdict.warnings.length, issued, actionsWritten }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L5 non può riordinare bridge o CTA senza sapere che i dati delle superfici decisionali sono freschi e che il passo successivo è utile.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Candidates: ${verdict.candidates.length}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: etichettare dati stale e sopprimere promesse non supportate; i bridge restano candidati in PR revisionata, senza dark pattern, personalizzazione invasiva o modifica dei dati sorgente. Collegare l’export eligibleDecisionSessions/nextUsefulActions prima di dichiarare un miglioramento.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l5-decision-moments.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL5({
  now = new Date(),
  fuelPath = DEFAULT_FUEL_PATH,
  borderPath = DEFAULT_BORDER_PATH,
  pharmacyPath = DEFAULT_PHARMACY_PATH,
  dutyPath = DEFAULT_DUTY_PATH,
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
  let verdict;
  try {
    const registry = readJson(registryPath, 'loop registry');
    verdict = validateDecisionMoments({
      fuel: readJson(fuelPath, 'fuel source'),
      border: readJson(borderPath, 'border source'),
      pharmacies: readJson(pharmacyPath, 'pharmacy source'),
      duties: readJson(dutyPath, 'pharmacy duty source'),
      outcomes: readOptionalJson(outcomePath),
    }, { now, maxAgeHours, sourcePath: fuelPath, outcomePath, minimumSample, registry });
  } catch (error) {
    verdict = baseVerdict({ sourcePath: fuelPath, now, quality: 'unmeasurable', ok: false, reason: error.message });
  }
  const measurable = verdict.quality === 'observed';
  const generatedAt = finiteDate(verdict.snapshot?.outcomes?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime() ? generatedAt.toISOString() : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: 'Decision Moments',
    owner: 'CPO / Customer Value',
    oracle: 'fresh utility surface snapshots plus independent next-action outcome export',
    hypothesis: 'A contextual bridge is useful only after a verified calculation/comparison/check and an explicit next-action outcome.',
    sourceSnapshot: verdict.snapshot || { source: 'decision-surfaces', path: fuelPath, outcomePath },
    observationWindow: { start: observationStart, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'completed-decision-surface-sessions-with-next-useful-action',
    numerator: measurable ? verdict.snapshot.outcomes?.nextUsefulActions ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.eligibleDecisionSessions ?? 0 : null,
    primaryMetric: 'next_useful_action_per_1000_completed_decision_sessions',
    guardrails: ['no dark patterns', 'source freshness required', 'same-corridor bridge only', 'no invasive personalization'],
    minimumSample,
    actionClass: verdict.ok ? 'observe' : 'stale-label+candidate+issue',
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: 'Decision Moments',
    owner: 'CPO / Customer Value',
    oracle: 'fresh utility surface snapshots plus independent next-action outcome export',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass: verdict.ok ? 'observe' : 'stale-label+candidate+issue',
    rollbackPlan: 'remove runner-local stale labels/bridge recommendations; leave published surfaces unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let actionsWritten = false;
  if (apply && reportDir) {
    const actionFile = writeActions(reportDir, verdict, now);
    actionsWritten = Boolean(actionFile);
    if (actionFile) files.push(actionFile);
  }
  let issued = false;
  if (issue && !verdict.ok) {
    const issueResult = await createIssueImpl({
      title: 'L5 Decision Moments: surface freshness or next action is not measurable',
      description: issueBody(verdict, decision),
      priority: 3,
      labels: ['monitoring', 'ux', 'loop-l5'],
      workflow: 'Loop L5 Decision Moments',
    });
    if (!issueResult || issueResult.persisted !== true) {
      throw new Error('L5 issue persistence failed: createGithubIssue did not confirm persisted=true');
    }
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L5] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
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
    json: argv.includes('--json'), issue: argv.includes('--issue'), apply: argv.includes('--apply'), strict: argv.includes('--strict'), dryRun: argv.includes('--dry-run'),
    fuelPath: valueAfter('--fuel', DEFAULT_FUEL_PATH), borderPath: valueAfter('--border', DEFAULT_BORDER_PATH), pharmacyPath: valueAfter('--pharmacies', DEFAULT_PHARMACY_PATH), dutyPath: valueAfter('--duties', DEFAULT_DUTY_PATH), outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH), registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH), maxAgeHours, minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l5') : path.join(os.tmpdir(), 'loop-fleet-l5')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL5({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({ verdict: result.verdict, observation: result.observation, decision: result.decision, issued: result.issued, actionsWritten: result.actionsWritten }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L5] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
