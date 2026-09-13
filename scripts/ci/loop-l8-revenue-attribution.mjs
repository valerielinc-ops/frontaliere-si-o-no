#!/usr/bin/env node

/**
 * L8 — Revenue & Attribution Reconciliation.
 *
 * This loop joins the published revenue-monitor snapshot with an explicitly
 * authorised commercial export. Clicks, pending commissions, approved money
 * and reversed money remain separate facts. Missing exports are never treated
 * as zero revenue, and the loop never changes Auto Ads, partners, prices or
 * recipient state.
 */
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
import {
  parseAffiliateExport,
  reconcileAffiliateTransactions,
} from '../lib/affiliateRevenue.mjs';

export const LOOP_ID = 'L8';
export const DEFAULT_HISTORY_PATH = path.join('data', 'revenue-monitor-history.jsonl');
export const DEFAULT_AFFILIATE_EXPORT_PATH = path.join('data', 'revenue-authorized-export.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 240;
export const MINIMUM_SAMPLE = 100;

const CLOCK_SKEW_HOURS = 5 / 60;
const REQUIRED_HISTORY_METRICS = [
  ['adsense', 'revenuePerDayCHF'],
  ['adsense', 'rpmCHF'],
  ['adsense', 'desktopRpmCHF'],
  ['adsense', 'authGateImpressions7d'],
  ['gsc', 'clicksPerDay'],
  ['gsc', 'avgPosition'],
  ['posthog', 'clsP75Mobile'],
  ['posthog', 'clsP75Desktop'],
];

function finiteDate(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time) : null;
}

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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

function checkMetric(value, label, issues, { integer = false, max = null, nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (!nullable) issues.push(`${label} is missing`);
    return;
  }
  const valid = integer ? nonNegativeInteger(value) : nonNegativeNumber(value);
  if (!valid) {
    issues.push(`${label} is missing or not a non-negative ${integer ? 'integer' : 'number'}`);
    return;
  }
  if (max !== null && value > max) issues.push(`${label} exceeds ${max}`);
}

function readJsonl(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  const records = [];
  const parseIssues = [];
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      parseIssues.push(`line ${index + 1}: invalid JSON (${error.message})`);
    }
  }
  return { path: filePath, records, parseIssues };
}

function readOptionalJson(filePath) {
  const absolute = path.resolve(filePath);
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : null;
}

function validateHistory(history, { now, maxAgeHours, sourcePath }) {
  const records = Array.isArray(history?.records) ? history.records : [];
  const issues = Array.isArray(history?.parseIssues) ? [...history.parseIssues] : [];
  const warnings = [];
  const seenDates = new Set();
  let previousTimestamp = null;
  let latest = null;
  let validRows = 0;

  for (const [index, row] of records.entries()) {
    const prefix = `history[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      issues.push(`${prefix} is not an object`);
      continue;
    }
    const rowIssuesBefore = issues.length;
    const stamp = finiteDate(row.date || row.generatedAt || row._meta?.generatedAt);
    if (!stamp) issues.push(`${prefix}.date is missing or invalid`);
    if (stamp && hoursBetween(stamp, now) > CLOCK_SKEW_HOURS) issues.push(`${prefix}.date is in the future`);
    const day = stamp?.toISOString().slice(0, 10) || null;
    if (day && seenDates.has(day)) issues.push(`${prefix}.date duplicates ${day}`);
    if (day) seenDates.add(day);
    if (stamp && previousTimestamp && stamp.getTime() < previousTimestamp.getTime()) {
      issues.push(`${prefix}.date is out of append order`);
    }
    if (stamp) previousTimestamp = stamp;

    const adsense = row.adsense;
    const gsc = row.gsc;
    const posthog = row.posthog;
    if (!adsense || typeof adsense !== 'object' || Array.isArray(adsense)) {
      issues.push(`${prefix}.adsense is missing or not an object`);
    }
    if (!gsc || typeof gsc !== 'object' || Array.isArray(gsc)) {
      issues.push(`${prefix}.gsc is missing or not an object`);
    }
    if (!posthog || typeof posthog !== 'object' || Array.isArray(posthog)) {
      issues.push(`${prefix}.posthog is missing or not an object`);
    }
    for (const [section, key] of REQUIRED_HISTORY_METRICS) {
      const value = row[section]?.[key];
    checkMetric(value, `${prefix}.${section}.${key}`, issues, {
      integer: key.endsWith('Impressions7d'),
      max: key.startsWith('clsP75') ? 1 : null,
      nullable: false,
    });
    }
    const ctr = gsc?.ctrByBucket;
    if (!ctr || typeof ctr !== 'object' || Array.isArray(ctr)) {
      issues.push(`${prefix}.gsc.ctrByBucket is missing or not an object`);
    } else {
      for (const [bucket, value] of Object.entries(ctr)) {
        checkMetric(value, `${prefix}.gsc.ctrByBucket.${bucket}`, issues, { max: 100 });
      }
    }
    const publisher = row.publisher;
    if (publisher === null || publisher === undefined) {
      warnings.push(`${prefix}.publisher is unavailable; publisher revenue is not inferred`);
    } else if (typeof publisher !== 'object' || Array.isArray(publisher)) {
      issues.push(`${prefix}.publisher is not an object or null`);
    } else {
      checkMetric(publisher.activeAds, `${prefix}.publisher.activeAds`, issues, { integer: true });
      checkMetric(publisher.sponsoredActive, `${prefix}.publisher.sponsoredActive`, issues, { integer: true });
      checkMetric(publisher.freeActive, `${prefix}.publisher.freeActive`, issues, { integer: true });
      checkMetric(publisher.estMrrCHF, `${prefix}.publisher.estMrrCHF`, issues);
    }
    if (!Array.isArray(row.regressions)) issues.push(`${prefix}.regressions is missing or not an array`);
    else if (row.regressions.some((value) => !text(value))) issues.push(`${prefix}.regressions contains a non-text entry`);
    if (issues.length === rowIssuesBefore && stamp) validRows += 1;
    if (stamp && (!latest || stamp.getTime() > latest.stamp.getTime())) latest = { stamp, row };
  }

  const latestAgeHours = latest ? hoursBetween(now, latest.stamp) : null;
  if (!latest) issues.push('revenue history has no valid timestamped row');
  else if (latestAgeHours < -CLOCK_SKEW_HOURS) issues.push('latest revenue history row is in the future');
  else if (latestAgeHours > maxAgeHours) issues.push(`latest revenue history is ${latestAgeHours.toFixed(1)}h old (max ${maxAgeHours}h)`);

  const latestRow = latest?.row || null;
  const snapshot = {
    source: 'revenue-monitor-history',
    path: sourcePath,
    rowCount: records.length,
    validRows,
    invalidRows: Math.max(0, records.length - validRows),
    distinctDates: seenDates.size,
    generatedAt: latest?.stamp.toISOString() || null,
    ageHours: latestAgeHours === null ? null : Number(latestAgeHours.toFixed(3)),
    date: latestRow?.date || null,
    adsense: latestRow?.adsense || null,
    gsc: latestRow?.gsc || null,
    posthog: latestRow?.posthog || null,
    publisher: latestRow?.publisher || null,
  };
  let quality = 'observed';
  if (!records.length || !validRows) quality = 'unmeasurable';
  else if (latestAgeHours < -CLOCK_SKEW_HOURS || latestAgeHours > maxAgeHours) quality = 'stale';
  else if (issues.length) quality = 'partial';
  return { quality, issues, warnings, snapshot };
}

function emptyAffiliateSnapshot(sourcePath) {
  return {
    source: 'authorised-commercial-export',
    path: sourcePath,
    generatedAt: null,
    ageHours: null,
    rowCount: null,
    invalidRows: null,
    deduplicatedTransactions: null,
    conversions: null,
    exposures: { web: null, email: null, relevant: null },
    byCurrency: {},
    approvedNetChf: null,
    pendingChf: null,
    reversedChf: null,
  };
}

function validateAffiliateExport(raw, { now, maxAgeHours, sourcePath, minimumSample }) {
  if (raw === null || raw === undefined) {
    return {
      quality: 'unmeasurable',
      issues: ['no authorised affiliate or commercial export is available'],
      warnings: ['clicks and publisher snapshots cannot substitute for approved commission evidence'],
      snapshot: emptyAffiliateSnapshot(sourcePath),
    };
  }
  const issues = [];
  const warnings = [];
  const generatedAt = finiteDate(raw?.generatedAt || raw?._meta?.generatedAt);
  if (!generatedAt) issues.push('commercial export generatedAt is missing or invalid');
  const rawRows = Array.isArray(raw)
    ? raw
    : raw?.transactions ?? raw?.rows;
  if (!Array.isArray(rawRows)) issues.push('commercial export transactions/rows is missing or not an array');
  const parsed = parseAffiliateExport(raw, {
    webExposures: raw?.exposures?.web ?? null,
    emailExposures: raw?.exposures?.email ?? null,
    amountFormat: raw?.amountFormat ?? null,
  });
  const web = parsed.exposures?.web;
  const email = parsed.exposures?.email;
  const validExposure = (value) => value !== null && value !== undefined
    && Number.isFinite(Number(value)) && Number(value) >= 0;
  if (!validExposure(web) && !validExposure(email)) issues.push('commercial export has no relevant exposure denominator');
  const exposures = {
    web: validExposure(web) ? Number(web) : null,
    email: validExposure(email) ? Number(email) : null,
  };
  const ambiguousDenominator = exposures.web !== null && exposures.email !== null
    && (exposures.web > 0 || exposures.email > 0);
  if (ambiguousDenominator) {
    issues.push('commercial export has both web and email exposures but no channel attribution for the approved-money numerator');
  }
  const relevant = ambiguousDenominator
    ? null
    : exposures.web !== null ? exposures.web : exposures.email;
  const report = reconcileAffiliateTransactions({
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    exposures,
    amountFormat: parsed.amountFormat,
    from: raw?.period?.from || null,
    to: raw?.period?.to || null,
  });
  if (report.invalidRows > 0) issues.push(`commercial export has ${report.invalidRows} invalid row(s)`);
  const ageHours = generatedAt ? hoursBetween(now, generatedAt) : null;
  if (ageHours !== null && ageHours < -CLOCK_SKEW_HOURS) issues.push('commercial export generatedAt is in the future');
  if (ageHours !== null && ageHours > maxAgeHours) issues.push(`commercial export is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  if (relevant !== null && relevant > 0 && relevant < minimumSample) {
    issues.push(`relevant exposure denominator is below minimum sample (${relevant} < ${minimumSample})`);
  }
  const byCurrency = report.byCurrency || {};
  const currenciesWithRows = Object.keys(byCurrency);
  const hasNonChfApproved = currenciesWithRows.some((currency) => currency !== 'CHF' && (byCurrency[currency]?.approvedConversions || 0) > 0);
  if (hasNonChfApproved) issues.push('approved non-CHF commissions require an explicit currency conversion oracle');
  if (report.conversions > 0 && !byCurrency.CHF) issues.push('commercial export has no CHF ledger for the approved-net metric');
  if (report.status === 'unmeasurable' && rawRows.length > 0) issues.push(report.reason || 'commercial export cannot be reconciled');

  const chf = byCurrency.CHF || null;
  const snapshot = {
    source: 'authorised-commercial-export',
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    rowCount: Array.isArray(rawRows) ? rawRows.length : null,
    invalidRows: report.invalidRows,
    invalidReasons: report.invalidReasons || [],
    deduplicatedTransactions: report.deduplicatedTransactions,
    conversions: report.conversions,
    exposures: { ...exposures, relevant },
    byCurrency,
    approvedNetChf: chf ? chf.approved : report.conversions === 0 && report.invalidRows === 0 ? 0 : null,
    pendingChf: chf ? chf.pending : null,
    reversedChf: chf ? chf.reversed : null,
    approvedConversionsChf: chf ? chf.approvedConversions : null,
    pendingConversionsChf: chf ? chf.pendingConversions : null,
    reversedConversionsChf: chf ? chf.reversedConversions : null,
  };
  let quality = 'observed';
  if (!generatedAt || relevant === null || report.status === 'unmeasurable') quality = 'unmeasurable';
  else if (relevant === 0) quality = 'zero';
  else if (ageHours < -CLOCK_SKEW_HOURS || ageHours > maxAgeHours) quality = 'stale';
  else if (issues.length) quality = 'partial';
  return { quality, issues, warnings, snapshot };
}

/** Validate the monitor snapshot and the independent approved-money export. */
export function validateRevenueAttribution({ history, affiliate = null }, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  historyPath = DEFAULT_HISTORY_PATH,
  affiliatePath = DEFAULT_AFFILIATE_EXPORT_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  const historyVerdict = validateHistory(history, { now, maxAgeHours, sourcePath: historyPath });
  const affiliateVerdict = validateAffiliateExport(affiliate, {
    now,
    maxAgeHours,
    sourcePath: affiliatePath,
    minimumSample,
  });
  const issues = [...historyVerdict.issues, ...affiliateVerdict.issues];
  const warnings = [...historyVerdict.warnings, ...affiliateVerdict.warnings];
  const candidates = [];
  if (affiliateVerdict.quality === 'unmeasurable') {
    candidates.push({
      actionClass: 'recommend',
      action: 'request or attach a fresh authorised affiliate/commercial export with exposure denominators',
      reversible: true,
      externalMutation: false,
      autoAdsUntouched: true,
    });
  }
  if (affiliateVerdict.snapshot?.invalidRows > 0 || historyVerdict.quality === 'partial') {
    candidates.push({
      actionClass: 'recommend',
      action: 'open a reviewed PR to repair the producer/schema or its cardinality checks; do not rewrite the export in place',
      reversible: true,
      externalMutation: false,
      autoAdsUntouched: true,
    });
  }
  if (affiliateVerdict.snapshot?.approvedNetChf !== null) {
    candidates.push({
      actionClass: 'reconcile',
      action: 'reconcile approved, pending and reversed states before proposing a placement or partner change',
      reversible: true,
      externalMutation: false,
      autoAdsUntouched: true,
    });
  }
  const snapshot = {
    source: 'revenue-monitor-plus-authorised-export',
    history: historyVerdict.snapshot,
    commercial: affiliateVerdict.snapshot,
  };
  let quality = 'observed';
  if (historyVerdict.quality === 'unmeasurable' || affiliateVerdict.quality === 'unmeasurable') quality = 'unmeasurable';
  else if (historyVerdict.quality === 'stale' || affiliateVerdict.quality === 'stale') quality = 'stale';
  else if (historyVerdict.quality === 'zero' || affiliateVerdict.quality === 'zero') quality = 'zero';
  else if (issues.length || historyVerdict.quality !== 'observed' || affiliateVerdict.quality !== 'observed') quality = 'partial';
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath: historyPath,
    now,
    quality,
    ok,
    reason: ok
      ? 'revenue snapshot, approved-money export and exposure attribution are fresh and coherent'
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates,
  });
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `revenue attribution quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function reportMarkdown(verdict, observation, decision) {
  const commercial = verdict.snapshot?.commercial || {};
  const history = verdict.snapshot?.history || {};
  const lines = [
    `## L8 Revenue & Attribution — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- History: ${history.path || '—'} (${history.rowCount ?? 'unmeasurable'} rows, latest ${history.generatedAt || 'unmeasurable'})`,
    `- Commercial export: ${commercial.path || '—'} (${commercial.generatedAt || 'unmeasurable'})`,
    `- Approved CHF: ${commercial.approvedNetChf ?? 'unmeasurable'}`,
    `- Pending CHF: ${commercial.pendingChf ?? 'unmeasurable'}`,
    `- Reversed CHF: ${commercial.reversedChf ?? 'unmeasurable'}`,
    `- Relevant exposures: ${commercial.exposures?.relevant ?? 'unmeasurable'}`,
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
    ['l8-observation.json', observation],
    ['l8-decision.json', decision],
    ['l8-report.md', reportMarkdown(verdict, observation, decision)],
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
  const file = path.join(path.resolve(reportDir), 'l8-safe-actions.json');
  const reconcilePolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'reconcile');
  const actions = verdict.candidates.map((candidate) => {
    const actionClass = candidate.actionClass || 'recommend';
    const policy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
    return { ...candidate, actionClass, autonomy: policy.requiredAutonomy };
  });
  actions.unshift(
    {
      actionClass: reconcilePolicy.actionClass,
      autonomy: reconcilePolicy.requiredAutonomy,
      action: 'prepare a runner-local quarantine report for invalid commercial rows and preserve the published monitor snapshot',
      reversible: true,
      externalMutation: false,
      autoAdsUntouched: true,
      publishedDataUntouched: true,
    },
  );
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    externalCommercialStateUntouched: true,
    autoAdsUntouched: true,
    actions,
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l8-result.json');
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
  const commercial = verdict.snapshot?.commercial || {};
  return [
    'L8 non può dichiarare contributo economico netto senza una snapshot fresca e un export commerciale autorizzato riconciliato.',
    '',
    `- Source history: ${verdict.sourcePath}`,
    `- Commercial export: ${commercial.path || 'missing'}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Stati distinti: click, pending, approved e reversed non vengono sommati. Nessuna modifica a Auto Ads, partner, prezzi, pubblicazione o destinatari; le correzioni restano candidate a issue/PR revisionabile.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l8-revenue-attribution.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL8({
  now = new Date(),
  historyPath = DEFAULT_HISTORY_PATH,
  affiliatePath = DEFAULT_AFFILIATE_EXPORT_PATH,
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
    const history = readJsonl(historyPath, 'revenue history');
    const affiliate = readOptionalJson(affiliatePath);
    verdict = validateRevenueAttribution({ history, affiliate }, {
      now,
      maxAgeHours,
      historyPath,
      affiliatePath,
      minimumSample: policyMinimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({
      sourcePath: historyPath,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
      snapshot: {
        history: { source: 'revenue-monitor-history', path: historyPath },
        commercial: emptyAffiliateSnapshot(affiliatePath),
      },
      candidates: [{
        actionClass: 'recommend',
        action: 'restore the missing or unreadable revenue input in a reviewed change',
        reversible: true,
        externalMutation: false,
        autoAdsUntouched: true,
      }],
    });
  }
  const actionClass = 'reconcile+issue';
  const effectiveActionClass = verdict.ok ? 'observe' : actionClass;
  const actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, effectiveActionClass);
  for (const candidate of verdict.candidates) {
    validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, candidate.actionClass || 'recommend');
  }
  verdict = {
    ...verdict,
    candidates: verdict.candidates.map((candidate) => {
      const candidateActionClass = candidate.actionClass || 'recommend';
      return {
        ...candidate,
        actionClass: candidateActionClass,
        autonomy: validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, candidateActionClass).requiredAutonomy,
      };
    }),
    snapshot: {
      ...verdict.snapshot,
      registry: {
        loopId: LOOP_ID,
        maxAutonomy: loopPolicy.maxAutonomy,
        actionClass: effectiveActionClass,
        requiredAutonomy: actionPolicy.requiredAutonomy,
        actionClasses: loopPolicy.actionClasses,
      },
    },
  };
  const commercial = verdict.snapshot?.commercial;
  const measurable = verdict.quality === 'observed' && verdict.ok;
  const candidateStarts = [
    finiteDate(verdict.snapshot?.history?.generatedAt),
    finiteDate(commercial?.generatedAt),
  ].filter((value) => value && value.getTime() <= now.getTime());
  const observationStart = candidateStarts.length
    ? new Date(Math.min(...candidateStarts.map((value) => value.getTime()))).toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy.goal,
    owner: loopPolicy.owner,
    oracle: loopPolicy.oracle,
    hypothesis: 'A surface creates economic value only when approved money and its relevant exposure denominator reconcile independently.',
    sourceSnapshot: verdict.snapshot || { historyPath, affiliatePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'relevant-web-or-email-exposures-with-authorised-approved-money-ledger',
    numerator: measurable ? commercial.approvedNetChf ?? 0 : null,
    denominator: measurable ? commercial.exposures?.relevant ?? 0 : null,
    primaryMetric: loopPolicy.primaryMetric,
    guardrails: loopPolicy.guardrails,
    minimumSample: policyMinimumSample,
    actionClass: effectiveActionClass,
    quality: verdict.quality,
    allowNumeratorExceedDenominator: true,
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
    actionClass: effectiveActionClass,
    rollbackPlan: 'delete only runner-local reconciliation artifacts; leave Auto Ads, partners, prices, published snapshots and commercial systems unchanged',
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
      title: 'L8 Revenue Attribution: approved money is not reconciled',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'revenue', 'loop-l8'],
      workflow: 'Loop L8 Revenue and Attribution Reconciliation',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L8] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
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
    historyPath: valueAfter('--history', DEFAULT_HISTORY_PATH),
    affiliatePath: valueAfter('--affiliate', DEFAULT_AFFILIATE_EXPORT_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l8')
      : path.join(os.tmpdir(), 'loop-fleet-l8')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL8({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
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
    console.error(`[L8] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
