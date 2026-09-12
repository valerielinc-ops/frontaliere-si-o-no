#!/usr/bin/env node

/**
 * L9 — Employer Supply to Paid Activation.
 *
 * Employer profiles are an inventory signal, not a commercial outcome. This
 * loop joins the factual profile inventory to an independent funnel ledger;
 * without that ledger it keeps paid activation unmeasurable and only prepares
 * reviewable, draft-only outreach or schema-repair actions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  appendJsonl,
  buildDecision,
  buildObservation,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L9';
export const DEFAULT_PROFILES_PATH = path.join('data', 'employer-profiles.json');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'employer-funnel-outcomes.json');
export const DEFAULT_MAX_AGE_HOURS = 240;
export const MINIMUM_SAMPLE = 20;
export const MAX_CANDIDATES = 25;
const CLOCK_SKEW_HOURS = 5 / 60;

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

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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
  if (!issues.length) return `employer activation quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function emptyProfileSnapshot(sourcePath) {
  return {
    path: sourcePath,
    generatedAt: null,
    ageHours: null,
    profileCount: null,
    validProfileCount: 0,
    invalidProfileCount: null,
    sourceJobs: null,
    aboveFloorCount: null,
    belowFloorCount: null,
    floor: null,
    bridgeFloor: null,
    trendWindowDays: null,
  };
}

function emptyOutcomeSnapshot(sourcePath) {
  return {
    path: sourcePath,
    generatedAt: null,
    ageHours: null,
    eligibleEmployerAccounts: null,
    profileViewAccounts: null,
    leadAccounts: null,
    checkoutStartAccounts: null,
    paidActivations: null,
    activeSubscriptions: null,
    attachedJobs: null,
    renewals: null,
    freeProfiles: null,
    sponsoredProfiles: null,
    mrrRecognizedChf: null,
  };
}

function validateDistribution(entries, prefix, activeJobs, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${prefix} must be an array`);
    return;
  }
  const seen = new Set();
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const itemPrefix = `${prefix}[${index}]`;
    if (!object(entry)) {
      issues.push(`${itemPrefix} is not an object`);
      continue;
    }
    if (!text(entry.name)) issues.push(`${itemPrefix}.name is missing`);
    else if (seen.has(entry.name)) issues.push(`${itemPrefix}.name duplicates ${entry.name}`);
    else seen.add(entry.name);
    if (!integer(entry.count)) issues.push(`${itemPrefix}.count is missing or not a non-negative integer`);
    else total += entry.count;
  }
  // The generator deliberately publishes only the leading locations. Their
  // sum may be lower than activeJobs, but it must never exceed it.
  if (integer(activeJobs) && total > activeJobs) {
    issues.push(`${prefix} total ${total} exceeds activeJobs ${activeJobs}`);
  }
}

function profileCandidate(profile) {
  return {
    profileSlug: profile.slug,
    companyKey: profile.companyKey,
    employerName: profile.name,
    activeJobs: profile.activeJobs,
    topCantons: profile.cantons.slice(0, 3),
    topCities: profile.cities.slice(0, 3),
    autonomy: 'A1',
    action: 'draft-outreach only: prepare a human-reviewed employer activation brief; do not send it',
    reversible: true,
    externalMutation: false,
    noAutomaticPriceChange: true,
  };
}

/** Validate the corpus-derived factual employer inventory. */
export function validateEmployerProfiles(source, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_PROFILES_PATH,
} = {}) {
  const issues = [];
  const warnings = [];
  const candidates = [];
  if (!object(source)) {
    return {
      quality: 'unmeasurable',
      issues: ['employer profiles is not a JSON object'],
      warnings,
      candidates,
      snapshot: emptyProfileSnapshot(sourcePath),
    };
  }

  const meta = object(source._meta) ? source._meta : {};
  const generatedAt = finiteDate(meta.generatedAt);
  if (meta.schemaVersion !== 1) issues.push('employer profiles _meta.schemaVersion must be 1');
  if (!generatedAt) issues.push('employer profiles _meta.generatedAt is missing or invalid');
  if (!positiveInteger(meta.floor)) issues.push('employer profiles _meta.floor is missing or not positive');
  if (!positiveInteger(meta.bridgeFloor)) issues.push('employer profiles _meta.bridgeFloor is missing or not positive');
  if (positiveInteger(meta.floor) && positiveInteger(meta.bridgeFloor) && meta.bridgeFloor > meta.floor) {
    issues.push('employer profiles _meta.bridgeFloor exceeds floor');
  }
  if (!positiveInteger(meta.trendWindowDays)) issues.push('employer profiles _meta.trendWindowDays is missing or not positive');
  for (const [name, value] of Object.entries({
    sourceJobs: meta.sourceJobs,
    aboveFloorCount: meta.aboveFloorCount,
    belowFloorCount: meta.belowFloorCount,
  })) {
    if (!integer(value)) issues.push(`employer profiles _meta.${name} is missing or not a non-negative integer`);
  }

  const profiles = source.profiles;
  if (!Array.isArray(profiles)) {
    issues.push('employer profiles.profiles is missing or not an array');
  }
  if (Array.isArray(profiles) && integer(meta.aboveFloorCount) && profiles.length !== meta.aboveFloorCount) {
    issues.push(`employer profiles count ${profiles.length} differs from _meta.aboveFloorCount ${meta.aboveFloorCount}`);
  }

  const seenSlugs = new Set();
  let validProfileCount = 0;
  for (const [index, profile] of (profiles || []).entries()) {
    const prefix = `profiles[${index}]`;
    const rowIssues = [];
    if (!object(profile)) {
      rowIssues.push('profile is not an object');
    } else {
      if (!text(profile.slug)) rowIssues.push('slug is missing');
      else if (seenSlugs.has(profile.slug)) rowIssues.push(`duplicate slug ${profile.slug}`);
      else seenSlugs.add(profile.slug);
      if (!text(profile.name)) rowIssues.push('name is missing');
      if (!text(profile.companyKey)) rowIssues.push('companyKey is missing');
      if (!positiveInteger(profile.activeJobs)) rowIssues.push('activeJobs is missing or not positive');
      if (profile.sector !== null && profile.sector !== undefined && !text(profile.sector)) rowIssues.push('sector must be text or null');
      validateDistribution(profile.cantons, `${prefix}.cantons`, profile.activeJobs, rowIssues);
      validateDistribution(profile.cities, `${prefix}.cities`, profile.activeJobs, rowIssues);
      if (profile.salaryMedianChf !== null && profile.salaryMedianChf !== undefined && !finiteNumber(profile.salaryMedianChf)) {
        rowIssues.push('salaryMedianChf must be a non-negative number or null');
      }
      if (!integer(profile.salarySamples)) rowIssues.push('salarySamples is missing or not a non-negative integer');
      if (profile.salaryMedianChf !== null && profile.salaryMedianChf !== undefined && integer(profile.salarySamples) && profile.salarySamples === 0) {
        rowIssues.push('salaryMedianChf is present with zero salarySamples');
      }
      if (profile.salaryMedianChf === null && integer(profile.salarySamples) && profile.salarySamples > 0) {
        warnings.push(`${prefix}.salaryMedianChf is unavailable despite ${profile.salarySamples} salary sample(s)`);
      }
      if (profile.trend === null || profile.trend === undefined) {
        warnings.push(`${prefix}.trend is unavailable; trend-based activation remains unmeasured`);
      } else if (!object(profile.trend)) {
        rowIssues.push('trend must be an object or null');
      } else {
        for (const [name, value] of Object.entries({ added: profile.trend.added, removed: profile.trend.removed })) {
          if (!integer(value)) rowIssues.push(`trend.${name} is missing or not a non-negative integer`);
        }
        if (!Number.isInteger(profile.trend.net)) rowIssues.push('trend.net is missing or not an integer');
        if (!positiveInteger(profile.trend.windowDays)) rowIssues.push('trend.windowDays is missing or not positive');
        if (integer(profile.trend.added) && integer(profile.trend.removed)
            && Number.isInteger(profile.trend.net)
            && profile.trend.net !== profile.trend.added - profile.trend.removed) {
          rowIssues.push('trend.net does not equal trend.added - trend.removed');
        }
        if (positiveInteger(meta.trendWindowDays) && positiveInteger(profile.trend.windowDays)
            && profile.trend.windowDays !== meta.trendWindowDays) {
          rowIssues.push(`trend.windowDays differs from _meta.trendWindowDays ${meta.trendWindowDays}`);
        }
      }
    }
    if (rowIssues.length) {
      issues.push(`${prefix}: ${rowIssues.join(', ')}`);
      continue;
    }
    validProfileCount += 1;
    candidates.push(profileCandidate(profile));
  }

  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -CLOCK_SKEW_HOURS) issues.push('employer profiles generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`employer profiles are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (!profiles?.length) issues.push('employer profiles array is explicitly empty');
  const quality = !profiles || !profiles.length
    ? 'unmeasurable'
    : (ageHours !== null && ageHours > maxAgeHours ? 'stale' : (issues.length ? 'partial' : 'observed'));
  return {
    quality,
    issues,
    warnings,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    snapshot: {
      path: sourcePath,
      generatedAt: generatedAt?.toISOString() || null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
      profileCount: Array.isArray(profiles) ? profiles.length : null,
      validProfileCount,
      invalidProfileCount: Array.isArray(profiles) ? profiles.length - validProfileCount : null,
      sourceJobs: integer(meta.sourceJobs) ? meta.sourceJobs : null,
      aboveFloorCount: integer(meta.aboveFloorCount) ? meta.aboveFloorCount : null,
      belowFloorCount: integer(meta.belowFloorCount) ? meta.belowFloorCount : null,
      floor: positiveInteger(meta.floor) ? meta.floor : null,
      bridgeFloor: positiveInteger(meta.bridgeFloor) ? meta.bridgeFloor : null,
      trendWindowDays: positiveInteger(meta.trendWindowDays) ? meta.trendWindowDays : null,
    },
  };
}

function outcomeValue(outcomes, name, aliases = []) {
  const metrics = object(outcomes.metrics) ? outcomes.metrics : {};
  for (const key of [name, ...aliases]) {
    if (outcomes[key] !== undefined && outcomes[key] !== null) return outcomes[key];
    if (metrics[key] !== undefined && metrics[key] !== null) return metrics[key];
  }
  return null;
}

/** Validate the independent employer funnel/subscription ledger. */
export function validateEmployerFunnelOutcomes(outcomes, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
  profileCount = null,
} = {}) {
  if (!object(outcomes)) {
    return {
      quality: 'unmeasurable',
      issues: ['employer funnel outcome ledger is missing'],
      warnings: ['profile inventory cannot substitute for checkout, subscription or paid activation evidence'],
      snapshot: emptyOutcomeSnapshot(sourcePath),
    };
  }
  const issues = [];
  const warnings = [];
  const generatedAt = finiteDate(outcomes.generatedAt || outcomes._meta?.generatedAt);
  if (!generatedAt) issues.push('employer funnel outcomes generatedAt is missing or invalid');
  const values = {
    eligibleEmployerAccounts: outcomeValue(outcomes, 'eligibleEmployerAccounts'),
    profileViewAccounts: outcomeValue(outcomes, 'profileViewAccounts', ['employerProfileViewAccounts']),
    leadAccounts: outcomeValue(outcomes, 'leadAccounts', ['employerLeadAccounts']),
    checkoutStartAccounts: outcomeValue(outcomes, 'checkoutStartAccounts', ['employerCheckoutStartAccounts']),
    paidActivations: outcomeValue(outcomes, 'paidActivations', ['paidActivationAccounts']),
    activeSubscriptions: outcomeValue(outcomes, 'activeSubscriptions'),
    attachedJobs: outcomeValue(outcomes, 'attachedJobs'),
    renewals: outcomeValue(outcomes, 'renewals'),
    freeProfiles: outcomeValue(outcomes, 'freeProfiles'),
    sponsoredProfiles: outcomeValue(outcomes, 'sponsoredProfiles'),
  };
  for (const [name, value] of Object.entries(values)) {
    if (!integer(value)) issues.push(`outcomes.${name} is missing or not a non-negative integer`);
  }
  const mrrRecognizedChf = outcomeValue(outcomes, 'mrrRecognizedChf', ['recognizedMrrChf']);
  if (!finiteNumber(mrrRecognizedChf)) issues.push('outcomes.mrrRecognizedChf is missing or not a non-negative number');

  const orderedRelations = [
    ['profileViewAccounts', 'eligibleEmployerAccounts'],
    ['leadAccounts', 'profileViewAccounts'],
    ['checkoutStartAccounts', 'leadAccounts'],
    ['paidActivations', 'checkoutStartAccounts'],
  ];
  for (const [numerator, denominator] of orderedRelations) {
    if (integer(values[numerator]) && integer(values[denominator]) && values[numerator] > values[denominator]) {
      issues.push(`outcomes.${numerator} exceeds outcomes.${denominator}`);
    }
  }
  if (integer(values.freeProfiles) && integer(values.sponsoredProfiles) && integer(profileCount)
      && values.freeProfiles + values.sponsoredProfiles > profileCount) {
    issues.push(`outcomes.freeProfiles + sponsoredProfiles exceeds profile inventory ${profileCount}`);
  }
  if (integer(values.attachedJobs) && integer(values.freeProfiles) && integer(values.sponsoredProfiles)
      && values.attachedJobs < values.sponsoredProfiles) {
    issues.push('outcomes.attachedJobs is lower than sponsoredProfiles');
  }
  if (integer(values.eligibleEmployerAccounts) && values.eligibleEmployerAccounts > 0
      && values.eligibleEmployerAccounts < minimumSample) {
    issues.push(`eligibleEmployerAccounts is below minimum sample (${values.eligibleEmployerAccounts} < ${minimumSample})`);
  }

  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -CLOCK_SKEW_HOURS) issues.push('employer funnel outcomes generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`employer funnel outcomes are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  const snapshot = {
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, integer(value) ? value : null])),
    mrrRecognizedChf: finiteNumber(mrrRecognizedChf) ? mrrRecognizedChf : null,
  };
  let quality = 'observed';
  if (!generatedAt || Object.values(values).some((value) => !integer(value)) || !finiteNumber(mrrRecognizedChf)) quality = 'partial';
  else if (ageHours < -CLOCK_SKEW_HOURS || ageHours > maxAgeHours) quality = 'stale';
  else if (values.eligibleEmployerAccounts === 0) quality = 'zero';
  else if (issues.length) quality = 'partial';
  return { quality, issues, warnings, snapshot };
}

export function validateEmployerActivation({ profiles, outcomes = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_PROFILES_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  const profileVerdict = validateEmployerProfiles(profiles, { now, maxAgeHours, sourcePath });
  const outcomeVerdict = validateEmployerFunnelOutcomes(outcomes, {
    now,
    maxAgeHours,
    sourcePath: outcomePath,
    minimumSample,
    profileCount: profileVerdict.snapshot?.profileCount,
  });
  const issues = [...profileVerdict.issues, ...outcomeVerdict.issues];
  const warnings = [...profileVerdict.warnings, ...outcomeVerdict.warnings];
  const snapshot = {
    source: 'employer-profile-inventory-plus-funnel-ledger',
    profiles: profileVerdict.snapshot,
    outcomes: outcomeVerdict.snapshot,
  };
  let quality = 'observed';
  if (profileVerdict.quality === 'unmeasurable' || outcomeVerdict.quality === 'unmeasurable') quality = 'unmeasurable';
  else if (profileVerdict.quality === 'stale' || outcomeVerdict.quality === 'stale') quality = 'stale';
  else if (outcomeVerdict.quality === 'zero') quality = 'zero';
  else if (issues.length || profileVerdict.quality !== 'observed' || outcomeVerdict.quality !== 'observed') quality = 'partial';
  const candidates = [...profileVerdict.candidates];
  if (profileVerdict.quality !== 'observed' || outcomeVerdict.quality !== 'observed' || issues.length) {
    candidates.unshift({
      autonomy: 'A2',
      action: 'prepare a reviewed PR to repair the producer/schema or its funnel cardinality checks; never rewrite inventory in place',
      reversible: true,
      externalMutation: false,
      noAutomaticPriceChange: true,
    });
  }
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? 'employer inventory and independent paid-activation funnel are fresh and coherent'
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates: candidates.slice(0, MAX_CANDIDATES + 1),
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
  const profiles = verdict.snapshot?.profiles || {};
  const outcomes = verdict.snapshot?.outcomes || {};
  const lines = [
    `## L9 Employer Supply → Paid Activation — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Profiles: ${profiles.profileCount ?? 'unmeasurable'} (${profiles.generatedAt || 'unmeasurable'})`,
    `- Eligible employer accounts: ${outcomes.eligibleEmployerAccounts ?? 'unmeasurable'}`,
    `- Paid activations: ${outcomes.paidActivations ?? 'unmeasurable'}`,
    `- Recognized MRR CHF: ${outcomes.mrrRecognizedChf ?? 'unmeasurable'}`,
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
    ['l9-observation.json', observation],
    ['l9-decision.json', decision],
    ['l9-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  const observations = process.env.LOOP_FLEET_OBSERVATIONS_FILE;
  const decisions = process.env.LOOP_FLEET_DECISIONS_FILE;
  if (observations) appendJsonl(observations, observation);
  if (decisions) appendJsonl(decisions, decision);
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now) {
  if (!reportDir || verdict.ok) return null;
  const file = path.join(path.resolve(reportDir), 'l9-actions.json');
  const actions = [
    {
      autonomy: 'A2',
      action: 'prepare a reviewed PR for malformed profile or funnel data; preserve the published inventory and ledger',
      reversible: true,
      externalMutation: false,
      noAutomaticPriceChange: true,
    },
    ...verdict.candidates.filter((candidate) => candidate.action.includes('draft-outreach')),
  ];
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    realOutreachSent: false,
    inventoryUntouched: true,
    subscriptionStateUntouched: true,
    pricesUntouched: true,
    actions,
    rollback: 'discard runner-local briefs; send outreach or change prices only after explicit human approval',
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l9-result.json');
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
    'L9 non può dichiarare paid activation dagli annunci disponibili: l’inventario employer è separato dal funnel checkout/subscription.',
    '',
    `- Source profiles: ${verdict.sourcePath}`,
    `- Outcome ledger: ${verdict.snapshot?.outcomes?.path || 'missing'}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: produrre solo brief di outreach draft-only e PR revisionabili per la riparazione dello schema. Nessun messaggio viene inviato, nessun prezzo cambia e nessun profilo pubblicato viene riscritto.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l9-employer-activation.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL9({
  now = new Date(),
  profilesPath = DEFAULT_PROFILES_PATH,
  outcomePath = DEFAULT_OUTCOME_PATH,
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
    verdict = validateEmployerActivation({
      profiles: readJson(profilesPath, 'employer profiles'),
      outcomes: readOptionalJson(outcomePath),
    }, {
      now,
      maxAgeHours,
      sourcePath: profilesPath,
      outcomePath,
      minimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({
      sourcePath: profilesPath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
      snapshot: {
        source: 'employer-profile-inventory-plus-funnel-ledger',
        profiles: emptyProfileSnapshot(profilesPath),
        outcomes: emptyOutcomeSnapshot(outcomePath),
      },
      candidates: [{
        autonomy: 'A2',
        action: 'prepare a reviewed PR to restore or repair the employer input; preserve the current published surface',
        reversible: true,
        externalMutation: false,
        noAutomaticPriceChange: true,
      }],
    });
  }
  const measurable = verdict.quality === 'observed' && verdict.ok;
  const outcomes = verdict.snapshot?.outcomes || {};
  const candidateStarts = [
    finiteDate(verdict.snapshot?.profiles?.generatedAt),
    finiteDate(outcomes.generatedAt),
  ].filter((value) => value && value.getTime() <= now.getTime());
  const observationStart = candidateStarts.length
    ? new Date(Math.min(...candidateStarts.map((value) => value.getTime()))).toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: 'Employer Supply to Paid Activation',
    owner: 'CRO / Monetization',
    oracle: 'independent checkout and subscription state ledger',
    hypothesis: 'Employer supply creates commercial value only when eligible accounts, funnel transitions and paid activations reconcile independently.',
    sourceSnapshot: verdict.snapshot || { profilesPath, outcomePath },
    observationWindow: { start: observationStart, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'eligible-employer-accounts-with-factual-profile-inventory',
    numerator: measurable ? outcomes.paidActivations : null,
    denominator: measurable ? outcomes.eligibleEmployerAccounts : null,
    primaryMetric: 'paid_activation_rate',
    guardrails: ['inventory is not revenue', 'no real outreach without approval', 'no automatic price change', 'independent checkout/subscription ledger required'],
    minimumSample,
    actionClass: verdict.ok ? 'observe' : 'candidate+pr+draft-outreach',
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: 'Employer Supply to Paid Activation',
    owner: 'CRO / Monetization',
    oracle: 'independent checkout and subscription state ledger',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass: verdict.ok ? 'observe' : 'candidate+pr+draft-outreach',
    rollbackPlan: 'discard runner-local employer briefs and PR proposals; send no outreach and leave prices, inventory and subscription state unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
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
    await createIssueImpl({
      title: 'L9 Employer Activation: paid outcome ledger is not trustworthy',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'monetization', 'loop-l9'],
      workflow: 'Loop L9 Employer Supply to Paid Activation',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L9] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
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
    profilesPath: valueAfter('--profiles', DEFAULT_PROFILES_PATH),
    outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l9')
      : path.join(os.tmpdir(), 'loop-fleet-l9')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL9({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
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
    console.error(`[L9] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
