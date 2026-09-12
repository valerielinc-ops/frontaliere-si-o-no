#!/usr/bin/env node

/** L2 — Demand → Utility. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  buildDecision,
  buildObservation,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L2';
export const DEFAULT_SOURCE_PATH = path.join('data', 'gsc-orphan-queries-clusters.json');
export const DEFAULT_MAX_AGE_HOURS = 168;
export const MINIMUM_SAMPLE = 1000;
export const MAX_CANDIDATES = 25;
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

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function baseVerdict({ sourcePath, now, quality, ok, reason, issues = [], snapshot = null, candidates = [] }) {
  return { loopId: LOOP_ID, sourcePath, checkedAt: now.toISOString(), ok, quality, reason, issues, snapshot, candidates };
}

function outcomeFields(payload) {
  const hasTopLevel = Object.prototype.hasOwnProperty.call(payload, 'outcomes')
    && payload.outcomes !== undefined;
  const hasNested = record(payload.metrics)
    && Object.prototype.hasOwnProperty.call(payload.metrics, 'outcomes')
    && payload.metrics.outcomes !== undefined;
  const topLevel = hasTopLevel ? payload.outcomes : undefined;
  const nested = hasNested ? payload.metrics.outcomes : undefined;
  const counts = (value) => record(value)
    ? { eligibleLandingSessions: value.eligibleLandingSessions, usefulActions: value.usefulActions }
    : null;
  const topCounts = counts(topLevel);
  const nestedCounts = counts(nested);
  const conflict = hasTopLevel && hasNested
    && JSON.stringify(topCounts) !== JSON.stringify(nestedCounts);
  const invalid = (hasTopLevel && !record(topLevel)) || (hasNested && !record(nested));
  const outcomes = hasTopLevel ? topLevel : nested;
  return {
    outcomes,
    eligibleLandingSessions: outcomes?.eligibleLandingSessions,
    usefulActions: outcomes?.usefulActions,
    conflict,
    invalid,
  };
}

/**
 * Demand evidence is useful for generating candidates, but it is not an
 * outcome. The source must carry an explicit session/action join before L2 can
 * publish its primary metric.
 */
export function validateDemandSnapshot(payload, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_SOURCE_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return baseVerdict({ sourcePath, now, quality: 'unmeasurable', ok: false, reason: 'GSC snapshot is not a JSON object' });
  }

  const generatedAt = finiteDate(payload.generatedAt || payload._generatedAt);
  const clusters = payload.clusters;
  const issues = [];
  if (!generatedAt) issues.push('generatedAt is missing or invalid');
  if (!Array.isArray(clusters)) issues.push('clusters is missing or not an array');
  if (Array.isArray(clusters) && clusters.length === 0) issues.push('clusters is explicitly empty');

  const validClusters = [];
  for (const [index, cluster] of (clusters || []).entries()) {
    const prefix = `clusters[${index}]`;
    const impressions = cluster?.totalImpressions;
    const clicks = cluster?.totalClicks;
    const clusterIssues = [];
    if (!text(cluster?.canonicalSlug)) clusterIssues.push('canonicalSlug is missing');
    if (!text(cluster?.canonicalQuery)) clusterIssues.push('canonicalQuery is missing');
    if (!LOCALES.has(cluster?.locale)) clusterIssues.push('locale is invalid');
    if (!integer(impressions)) clusterIssues.push('totalImpressions is not a non-negative integer');
    if (!integer(clicks)) clusterIssues.push('totalClicks is not a non-negative integer');
    if (integer(impressions) && integer(clicks) && clicks > impressions) {
      clusterIssues.push('totalClicks exceeds totalImpressions');
    }
    if (clusterIssues.length) {
      issues.push(`${prefix}: ${clusterIssues.join(', ')}`);
      continue;
    }
    const slug = cluster.canonicalSlug.trim().replace(/^\/+|\/+$/gu, '');
    if (!slug) {
      issues.push(`${prefix}: canonicalSlug resolves to an empty path`);
      continue;
    }
    validClusters.push({
      clusterId: text(cluster.clusterId) ? cluster.clusterId.trim() : `${cluster.locale}-${slug}`,
      locale: cluster.locale,
      canonicalQuery: cluster.canonicalQuery.trim(),
      canonicalSlug: slug,
      totalImpressions: impressions,
      totalClicks: clicks,
      landingPath: `/${slug}/`,
    });
  }

  const candidates = [...validClusters]
    .sort((a, b) => b.totalImpressions - a.totalImpressions || a.canonicalSlug.localeCompare(b.canonicalSlug))
    .slice(0, MAX_CANDIDATES)
    .map((cluster) => ({
      ...cluster,
      action: 'candidate-only: add a sourced internal link, FAQ or CTA through a reviewed PR',
      source: 'gsc-orphan-queries-clusters',
    }));

  const {
    outcomes,
    eligibleLandingSessions,
    usefulActions,
    conflict: outcomeConflict,
    invalid: outcomeInvalid,
  } = outcomeFields(payload);
  const outcomeShapeValid = integer(eligibleLandingSessions) && integer(usefulActions);
  const outcomeConsistent = outcomeShapeValid && usefulActions <= eligibleLandingSessions;
  const outcomeUsable = outcomeShapeValid
    && !outcomeConflict
    && !outcomeInvalid
    && outcomeConsistent;
  if (outcomeConflict) {
    issues.push('outcomes disagree between top-level and metrics.outcomes');
  } else if (outcomeInvalid) {
    issues.push('outcomes must be an object with joined session/action counts');
  } else if (!outcomeShapeValid) {
    issues.push('outcomes.eligibleLandingSessions and outcomes.usefulActions are missing');
  }
  if (outcomeShapeValid && !outcomeConsistent) {
    issues.push('outcomes.usefulActions exceeds outcomes.eligibleLandingSessions');
  }
  if (outcomeConsistent && eligibleLandingSessions < minimumSample) {
    issues.push(`eligibleLandingSessions is below minimum sample (${eligibleLandingSessions} < ${minimumSample})`);
  }

  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`GSC snapshot is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  const snapshot = {
    source: 'gsc-orphan-query-clusters',
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    clusters: Array.isArray(clusters) ? clusters.length : null,
    validClusters: validClusters.length,
    candidates: candidates.length,
    outcomeJoin: outcomeConflict
      ? 'conflicting'
      : outcomeInvalid
        ? 'invalid'
        : outcomeShapeValid
          ? 'joined'
          : 'missing',
    outcomes: outcomeUsable
      ? { eligibleLandingSessions, usefulActions }
      : null,
  };

  let quality = 'observed';
  if (!generatedAt || !Array.isArray(clusters)) quality = 'unmeasurable';
  else if (clusters.length === 0) quality = 'zero';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if (validClusters.length !== clusters.length || !outcomeUsable || eligibleLandingSessions < minimumSample) quality = 'partial';
  const ok = quality === 'observed' && issues.length === 0;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? `GSC demand snapshot is fresh with ${validClusters.length} valid clusters and measured outcomes`
      : issues.join('; ') || `GSC demand snapshot quality is ${quality}`,
    issues,
    snapshot,
    candidates,
  });
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L2 Demand → Utility — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Candidate count: ${verdict.candidates.length}`,
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
    ['l2-observation.json', observation],
    ['l2-decision.json', decision],
    ['l2-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeResult(reportDir, { verdict, issued, candidatesWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l2-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issued,
    candidatesWritten,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L2 ha trovato domanda GSC utilizzabile per candidati, ma il risultato “next useful action” non è ancora un numero misurabile.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Candidate count: ${verdict.candidates.length}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: conservare i candidati come artefatto e proporre soltanto una PR con fonte, internal link/FAQ/CTA e gate SEO. Collegare la coorte di sessioni e azioni prima di dichiarare un risultato; non creare pagine sottili e non convertire impression in utilità.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l2-demand-utility.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL2({
  now = new Date(),
  sourcePath = DEFAULT_SOURCE_PATH,
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
    if (!fs.existsSync(path.resolve(sourcePath))) throw new Error(`GSC snapshot is missing: ${sourcePath}`);
    const payload = JSON.parse(fs.readFileSync(path.resolve(sourcePath), 'utf8'));
    verdict = validateDemandSnapshot(payload, { now, maxAgeHours, sourcePath, minimumSample });
  } catch (error) {
    verdict = baseVerdict({ sourcePath, now, quality: 'unmeasurable', ok: false, reason: error.message });
  }
  // `zero` is a quality state, not proof of a zero outcome. Keep the metric
  // non-measurable until the explicit outcome join and sample gate are valid;
  // an empty cluster list must never manufacture a 0/0 observation.
  const measurable = verdict.quality === 'observed';
  const generatedAt = finiteDate(verdict.snapshot?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: 'Demand to Utility',
    owner: 'Chief Growth / SEO',
    oracle: 'GSC snapshot plus landing-path evidence',
    hypothesis: 'Existing demand becomes useful only when a reviewed, sourced next action is measured on the same eligible landing cohort.',
    sourceSnapshot: verdict.snapshot || { source: 'gsc-orphan-query-clusters', path: sourcePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'eligible-landing-sessions-with-next-useful-action',
    numerator: measurable ? verdict.snapshot.outcomes?.usefulActions ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.eligibleLandingSessions ?? 0 : null,
    primaryMetric: 'useful_action_per_1000_eligible_landing_sessions',
    guardrails: ['no thin pages', 'no keyword stuffing', 'source required'],
    minimumSample,
    actionClass: verdict.candidates.length ? 'candidate+issue' : 'issue',
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: 'Demand to Utility',
    owner: 'Chief Growth / SEO',
    oracle: 'GSC snapshot plus landing-path evidence',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass: verdict.candidates.length ? 'candidate+issue' : 'issue',
    rollbackPlan: 'discard runner-local candidate and leave the published landing graph unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let issued = false;
  let candidatesWritten = false;
  if (apply && reportDir && verdict.candidates.length) {
    fs.writeFileSync(path.join(path.resolve(reportDir), 'l2-candidates.json'), `${JSON.stringify({
      loopId: LOOP_ID,
      generatedAt: now.toISOString(),
      reversible: true,
      candidates: verdict.candidates,
    }, null, 2)}\n`);
    candidatesWritten = true;
  }
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L2 Demand to Utility: outcome join is not measurable',
      description: issueBody(verdict, decision),
      priority: 3,
      labels: ['monitoring', 'seo', 'loop-l2'],
      workflow: 'Loop L2 Demand to Utility',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, candidatesWritten });
  logger.log(`[L2] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return {
    verdict,
    observation,
    decision,
    files: resultFile ? [...files, resultFile] : files,
    issued,
    candidatesWritten,
  };
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
    sourcePath: valueAfter('--source', DEFAULT_SOURCE_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l2')
      : path.join(os.tmpdir(), 'loop-fleet-l2')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL2({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    issued: result.issued,
    candidatesWritten: result.candidatesWritten,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L2] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
