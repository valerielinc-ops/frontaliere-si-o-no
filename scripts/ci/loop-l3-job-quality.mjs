#!/usr/bin/env node

/** L3 — Job Quality → Apply. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  buildDecision,
  buildObservation,
  loadLoopPolicy,
  validateActionClassAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L3';
export const DEFAULT_SUMMARY_DIR = path.join('data', 'jobs-crawler-summaries', 'by-crawler');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'job-apply-outcome-baseline.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 36;
export const MINIMUM_SAMPLE = 100;
export const MAX_CANDIDATES = 50;

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

function httpsUrl(value) {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && text(url.hostname);
  } catch {
    return false;
  }
}

function identityFor(job) {
  if (text(job?.id)) return `id:${job.id.trim()}`;
  if (httpsUrl(job?.url)) return `url:${job.url.trim()}`;
  if (text(job?.slug)) return `slug:${job.slug.trim()}`;
  return null;
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

function countIssue(summary, field, list, issues, warnings, prefix) {
  const expected = summary[field];
  if (!integer(expected)) {
    issues.push(`${prefix}.${field} is missing or not a non-negative integer`);
    return;
  }
  if (Array.isArray(list) && expected !== list.length) {
    // Crawler summaries intentionally cap the detailed evidence arrays at 30
    // rows. Keep that extraction limitation visible as a warning instead of
    // calling a declared total an inconsistency. Any other mismatch is a
    // proven contract violation and remains an actionable error.
    if (expected > list.length && list.length === 30) {
      warnings.push(`${prefix}.${field} details are capped at 30 rows (declared count ${expected})`);
    } else {
      issues.push(`${prefix}.${field} (${expected}) does not match ${field.replace('Count', 'Jobs')}.length (${list.length})`);
    }
  }
}

function validateActivePartition(summary, prefix, issues) {
  const counts = [summary.newCount, summary.updatedCount, summary.unchangedCount];
  if (!integer(summary.total) || !counts.every(integer)) return;
  // `total`/`written` describe the active slice. Removed jobs belong to the
  // previous slice, so the active partition is new+updated+unchanged;
  // subtracting removedCount here would count the same deletion twice.
  const activeTotal = counts.reduce((sum, count) => sum + count, 0);
  if (activeTotal !== summary.total) {
    issues.push(`${prefix}.total (${summary.total}) does not match newCount + updatedCount + unchangedCount (${activeTotal}); removedCount is a previous-slice delta`);
  }
  if (summary.written !== undefined && integer(summary.written) && summary.written !== summary.total) {
    issues.push(`${prefix}.written (${summary.written}) does not match total (${summary.total})`);
  }
}

function jobIssues(job, prefix, now) {
  const issues = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return ['job is not an object'];
  }
  if (!text(job.id) && !text(job.slug)) issues.push('id or slug is missing');
  if (!httpsUrl(job.url)) issues.push('url is missing or is not an HTTPS URL');
  if (!httpsUrl(job.applyUrl)) issues.push('applyUrl is missing or is not an HTTPS URL');
  if (!text(job.title)) issues.push('title is missing');
  if (!text(job.company) && !text(job.companyKey)) issues.push('company identity is missing');
  if (!text(job.source)) issues.push('source is missing');
  if (job.country !== undefined && job.country !== 'CH') issues.push('country is not CH');
  const crawledAt = finiteDate(job.crawledAt);
  if (job.crawledAt !== undefined && !crawledAt) issues.push('crawledAt is invalid');
  const firstSeenAt = finiteDate(job.firstSeenAt);
  if (job.firstSeenAt !== undefined && !firstSeenAt) issues.push('firstSeenAt is invalid');
  if (crawledAt && crawledAt.getTime() > now.getTime() + 5 * 60_000) issues.push('crawledAt is in the future');
  if (firstSeenAt && crawledAt && firstSeenAt.getTime() > crawledAt.getTime()) {
    issues.push('firstSeenAt is later than crawledAt');
  }
  return issues.map((issue) => `${prefix}: ${issue}`);
}

function normalizeCandidate(file, section, index, job, issues) {
  return {
    sourceFile: file,
    section,
    index,
    jobId: text(job?.id) ? job.id.trim() : null,
    slug: text(job?.slug) ? job.slug.trim() : null,
    companyKey: text(job?.companyKey) ? job.companyKey.trim() : null,
    title: text(job?.title) ? job.title.trim() : null,
    url: text(job?.url) ? job.url.trim() : null,
    issueCodes: issues.map((issue) => issue.replace(/^.*?:\s*/, '')),
    action: issues.some((issue) => /applyUrl/i.test(issue))
      ? 'quarantine record and fix the crawler applyUrl mapping through a reviewed PR'
      : 'quarantine record and add a parser/assembler regression test through a reviewed PR',
    actionClass: 'quarantine+pr',
    reversible: true,
  };
}

function validateOutcome(outcomes, { now, maxAgeHours, sourcePath, minimumSample }) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) {
    return {
      quality: 'partial',
      issues: ['job-apply outcome export is missing'],
      snapshot: { path: sourcePath, generatedAt: null, eligibleJobSessions: null, validHandoffs: null, applications: null },
    };
  }
  const issues = [];
  const generatedAt = finiteDate(outcomes.generatedAt || outcomes._meta?.generatedAt);
  const eligibleJobSessions = outcomes.eligibleJobSessions ?? outcomes.metrics?.eligibleJobSessions;
  const validHandoffs = outcomes.validHandoffs ?? outcomes.metrics?.validHandoffs;
  const applications = outcomes.applications ?? outcomes.metrics?.applications;
  if (!generatedAt) issues.push('outcomes.generatedAt is missing or invalid');
  if (!integer(eligibleJobSessions)) issues.push('outcomes.eligibleJobSessions is missing or not a non-negative integer');
  if (!integer(validHandoffs)) issues.push('outcomes.validHandoffs is missing or not a non-negative integer');
  if (applications !== undefined && !integer(applications)) {
    issues.push('outcomes.applications is not a non-negative integer');
  }
  if (integer(eligibleJobSessions) && integer(validHandoffs) && validHandoffs > eligibleJobSessions) {
    issues.push('outcomes.validHandoffs exceeds outcomes.eligibleJobSessions');
  }
  if (integer(validHandoffs) && integer(applications) && applications > validHandoffs) {
    issues.push('outcomes.applications exceeds outcomes.validHandoffs');
  }
  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('outcomes.generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`job-apply outcomes are ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  if (integer(eligibleJobSessions) && eligibleJobSessions > 0 && eligibleJobSessions < minimumSample) {
    issues.push(`eligibleJobSessions is below minimum sample (${eligibleJobSessions} < ${minimumSample})`);
  }
  const snapshot = {
    path: sourcePath,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    eligibleJobSessions: integer(eligibleJobSessions) ? eligibleJobSessions : null,
    validHandoffs: integer(validHandoffs) ? validHandoffs : null,
    applications: integer(applications) ? applications : null,
  };
  let quality = 'observed';
  if (!generatedAt || !integer(eligibleJobSessions) || !integer(validHandoffs)) quality = 'partial';
  else if (ageHours < -0.0834 || ageHours > maxAgeHours) quality = 'stale';
  else if (eligibleJobSessions === 0) quality = 'zero';
  else if (eligibleJobSessions < minimumSample) quality = 'partial';
  return { quality, issues, snapshot };
}

/**
 * Validate crawler summaries and the separately joined apply outcome export.
 * Counts in crawler summaries are diagnostic evidence; they are never used as
 * an application or handoff numerator.
 */
export function validateJobSummaries(summaries, {
  outcomes = null,
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_SUMMARY_DIR,
  outcomePath = DEFAULT_OUTCOME_PATH,
  minimumSample = MINIMUM_SAMPLE,
} = {}) {
  if (!Array.isArray(summaries)) {
    return baseVerdict({ sourcePath, now, quality: 'unmeasurable', ok: false, reason: 'crawler summaries are not an array' });
  }
  const issues = [];
  const warnings = [];
  const candidates = [];
  const identities = new Map();
  let freshSummaries = 0;
  let staleSummaries = 0;
  let malformedSummaries = 0;
  let jobsInspected = 0;
  let validJobs = 0;
  let invalidJobs = 0;
  let duplicateIdentities = 0;

  for (const [summaryIndex, entry] of summaries.entries()) {
    const file = entry?.file || `summary[${summaryIndex}]`;
    const summary = entry?.data ?? entry;
    const parseError = entry?.error;
    if (parseError) {
      malformedSummaries += 1;
      issues.push(`${file}: JSON parse failed: ${parseError}`);
      continue;
    }
    const prefix = file;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      malformedSummaries += 1;
      issues.push(`${prefix}: summary is not an object`);
      continue;
    }
    const generatedAt = finiteDate(summary.generatedAt);
    if (!text(summary.key)) issues.push(`${prefix}: key is missing`);
    if (!generatedAt) issues.push(`${prefix}: generatedAt is missing or invalid`);
    else {
      const ageHours = hoursBetween(now, generatedAt);
      if (ageHours < -0.0834) issues.push(`${prefix}: generatedAt is in the future`);
      if (ageHours > maxAgeHours) staleSummaries += 1;
      else if (ageHours >= -0.0834) freshSummaries += 1;
    }
    if (!integer(summary.total)) issues.push(`${prefix}: total is missing or not a non-negative integer`);
    const sections = ['newJobs', 'updatedJobs', 'removedJobs', 'unchangedJobs'];
    for (const section of sections) {
      if (!Array.isArray(summary[section])) {
        issues.push(`${prefix}.${section} is missing or not an array`);
      }
    }
    countIssue(summary, 'newCount', summary.newJobs, issues, warnings, prefix);
    countIssue(summary, 'updatedCount', summary.updatedJobs, issues, warnings, prefix);
    countIssue(summary, 'removedCount', summary.removedJobs, issues, warnings, prefix);
    countIssue(summary, 'unchangedCount', summary.unchangedJobs, issues, warnings, prefix);
    if (summary.written !== undefined && !integer(summary.written)) {
      issues.push(`${prefix}.written is not a non-negative integer`);
    }
    validateActivePartition(summary, prefix, issues);
    for (const section of ['newJobs', 'updatedJobs', 'unchangedJobs']) {
      for (const [index, job] of (summary[section] || []).entries()) {
        jobsInspected += 1;
        const jobPrefix = `${prefix}.${section}[${index}]`;
        const rowIssues = jobIssues(job, jobPrefix, now);
        const identity = identityFor(job);
        if (identity) {
          const previous = identities.get(identity);
          if (previous) {
            duplicateIdentities += 1;
            rowIssues.push(`${jobPrefix}: duplicate identity ${identity} also appears in ${previous}`);
          } else {
            identities.set(identity, jobPrefix);
          }
        }
        if (rowIssues.length) {
          invalidJobs += 1;
          issues.push(...rowIssues);
          if (candidates.length < MAX_CANDIDATES) candidates.push(normalizeCandidate(file, section, index, job, rowIssues));
        } else {
          validJobs += 1;
        }
      }
    }
  }

  const outcomeVerdict = validateOutcome(outcomes, {
    now,
    maxAgeHours: Math.max(maxAgeHours, 72),
    sourcePath: outcomePath,
    minimumSample,
  });
  issues.push(...outcomeVerdict.issues);
  const summaryCount = summaries.length;
  if (summaryCount === 0) issues.push('crawler summary directory is explicitly empty');
  const snapshot = {
    source: 'job-crawler-summaries',
    path: sourcePath,
    outcomePath,
    summaryCount,
    freshSummaries,
    staleSummaries,
    malformedSummaries,
    jobsInspected,
    validJobs,
    invalidJobs,
    duplicateIdentities,
    outcomes: outcomeVerdict.snapshot,
    warningCount: warnings.length,
  };

  const hasActionableIssues = issues.length > 0;
  let quality = 'observed';
  if (summaryCount === 0 || malformedSummaries === summaryCount) quality = 'unmeasurable';
  else if (staleSummaries === summaryCount) quality = 'stale';
  else if (hasActionableIssues) quality = outcomeVerdict.quality === 'stale' && freshSummaries === 0 ? 'stale' : 'partial';
  else if (outcomeVerdict.quality === 'zero') quality = 'zero';
  else if (staleSummaries > 0 || invalidJobs > 0 || outcomeVerdict.quality !== 'observed') quality = outcomeVerdict.quality === 'stale' && freshSummaries === 0 ? 'stale' : 'partial';
  // A measured observation requires both an observed quality and a clean
  // verdict. Never let a later outcome export mask a malformed summary.
  const ok = quality === 'observed' && !hasActionableIssues;
  return baseVerdict({
    sourcePath,
    now,
    quality,
    ok,
    reason: ok
      ? `job summaries are fresh and ${validJobs} inspected records have a valid apply handoff`
      : summarizeIssues(issues, quality),
    issues,
    warnings,
    snapshot,
    candidates: candidates.sort((a, b) => `${a.sourceFile}:${a.index}`.localeCompare(`${b.sourceFile}:${b.index}`)),
  });
}

function summarizeIssues(issues, quality) {
  if (!issues.length) return `job quality is ${quality}`;
  const visible = issues.slice(0, 12).join('; ');
  return issues.length > 12 ? `${visible}; (+${issues.length - 12} further findings in the report)` : visible;
}

function readSummaries(sourceDir) {
  const absolute = path.resolve(sourceDir);
  if (!fs.existsSync(absolute)) throw new Error(`crawler summary directory is missing: ${sourceDir}`);
  const files = fs.readdirSync(absolute).filter((name) => name.endsWith('.json')).sort();
  return files.map((name) => {
    const file = path.join(absolute, name);
    try {
      return { file: path.relative(process.cwd(), file), data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      return { file: path.relative(process.cwd(), file), error: error.message };
    }
  });
}

function readOptionalJson(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L3 Job Quality → Apply — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.sourcePath}`,
    `- Reason: ${verdict.reason}`,
    `- Inspected jobs: ${verdict.snapshot?.jobsInspected ?? 'n/a'}`,
    `- Invalid jobs: ${verdict.snapshot?.invalidJobs ?? 'n/a'}`,
    `- Warnings: ${verdict.warnings.length}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.slice(0, 80).map((issue) => `- ${issue}`));
  if (verdict.issues.length > 80) lines.push(`- ... ${verdict.issues.length - 80} further findings are in l3-observation.json`);
  if (verdict.warnings.length) lines.push('', '### Warnings', ...verdict.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l3-observation.json', observation],
    ['l3-decision.json', decision],
    ['l3-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function writeActions(reportDir, verdict, now, candidatePolicy) {
  if (!reportDir || !verdict.candidates.length || !candidatePolicy) return null;
  const file = path.join(path.resolve(reportDir), 'l3-actions.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    generatedAt: now.toISOString(),
    actionClass: candidatePolicy.actionClass,
    autonomy: candidatePolicy.requiredAutonomy,
    reversible: true,
    appliesToPublishedData: false,
    actions: verdict.candidates.map((candidate) => ({
      ...candidate,
      actionClass: 'quarantine+pr',
      autonomy: candidatePolicy.requiredAutonomy,
    })),
  }, null, 2)}\n`);
  return file;
}

function writeQuarantine(reportDir, verdict, now) {
  if (!reportDir || !verdict.candidates.length) return null;
  const file = path.join(path.resolve(reportDir), 'l3-quarantine.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    quarantinedAt: now.toISOString(),
    reversible: true,
    publishedSourceUntouched: true,
    records: verdict.candidates,
  }, null, 2)}\n`);
  return file;
}

function writeResult(reportDir, { verdict, issued, actionsWritten, quarantineWritten }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l3-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    warningCount: verdict.warnings.length,
    issued,
    actionsWritten,
    quarantineWritten,
  }, null, 2)}\n`);
  return file;
}

function issueBody(verdict, decision) {
  return [
    'L3 ha trovato offerte che non possono essere dichiarate applicabili con un handoff verificato.',
    '',
    `- Source: ${verdict.sourcePath}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Inspected jobs: ${verdict.snapshot?.jobsInspected ?? 'n/a'}`,
    `- Invalid jobs: ${verdict.snapshot?.invalidJobs ?? 'n/a'}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere le offerte invalide in quarantena runner-local, correggere il parser/assembler in una PR con regressione e collegare l’export eligibleJobSessions/validHandoffs prima di contare application. Un redirect, un click o il conteggio dei job non è una candidatura inviata.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l3-job-quality.mjs --json --dry-run`',
  ].join('\n');
}

export async function runL3({
  now = new Date(),
  summaryDir = DEFAULT_SUMMARY_DIR,
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
  let loopPolicy = null;
  let actionPolicy = null;
  let candidatePolicy = null;
  let verdict;
  try {
    ({ registry: loopRegistry, policy: loopPolicy } = loadLoopPolicy(registryPath, LOOP_ID));
    const summaries = readSummaries(summaryDir);
    const outcomes = readOptionalJson(outcomePath);
    verdict = validateJobSummaries(summaries, {
      outcomes,
      now,
      maxAgeHours,
      sourcePath: summaryDir,
      outcomePath,
      minimumSample,
    });
  } catch (error) {
    verdict = baseVerdict({ sourcePath: summaryDir, now, quality: 'unmeasurable', ok: false, reason: error.message });
  }
  const actionClass = verdict.candidates.length ? 'quarantine+candidate+issue' : 'issue';
  if (loopRegistry && loopPolicy) {
    try {
      actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
      if (verdict.candidates.length) candidatePolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, 'quarantine+pr');
      verdict = {
        ...verdict,
        candidates: verdict.candidates.map((candidate) => ({
          ...candidate,
          actionClass: 'quarantine+pr',
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
    } catch (error) {
      loopRegistry = null;
      loopPolicy = null;
      actionPolicy = null;
      candidatePolicy = null;
      verdict = baseVerdict({ sourcePath: summaryDir, now, quality: 'unmeasurable', ok: false, reason: error.message });
    }
  }
  // A zero-sized outcome cohort is not evidence of a zero handoff rate. Keep
  // metrics null until the observed outcome sample is complete and usable.
  const measurable = verdict.quality === 'observed' && verdict.ok;
  const generatedAt = finiteDate(verdict.snapshot?.outcomes?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy?.goal || 'Job Quality to Apply',
    owner: loopPolicy?.owner || 'CPO / Customer Value + CTO / Reliability',
    oracle: loopPolicy?.oracle || 'crawler summary integrity plus independent apply outcome export',
    hypothesis: 'A job is useful only when its identity, source, apply URL and handoff outcome are independently verifiable.',
    sourceSnapshot: verdict.snapshot || { source: 'job-crawler-summaries', path: summaryDir, outcomePath },
    observationWindow: {
      start: observationStart,
      end: now.toISOString(),
      timezone: 'UTC',
    },
    cohort: 'eligible-job-detail-sessions-with-valid-apply-handoff',
    numerator: measurable ? verdict.snapshot.outcomes?.validHandoffs ?? 0 : null,
    denominator: measurable ? verdict.snapshot.outcomes?.eligibleJobSessions ?? 0 : null,
    primaryMetric: loopPolicy?.primaryMetric || 'valid_apply_handoff_per_1000_eligible_job_sessions',
    guardrails: loopPolicy?.guardrails || ['applyUrl required', 'redirect is not an application', 'invalid records stay quarantined'],
    minimumSample: loopPolicy?.minimumSample || minimumSample,
    actionClass,
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: loopPolicy?.goal || 'Job Quality to Apply',
    owner: loopPolicy?.owner || 'CPO / Customer Value + CTO / Reliability',
    oracle: loopPolicy?.oracle || 'crawler summary integrity plus independent apply outcome export',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass,
    rollbackPlan: 'discard runner-local actions/quarantine artifacts; leave published job records unchanged',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + (loopPolicy?.lifecycle.candidateTtlHours || 24) * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let actionsWritten = false;
  let quarantineWritten = false;
  if (apply && reportDir) {
    const actionsFile = writeActions(reportDir, verdict, now, candidatePolicy);
    const quarantineFile = candidatePolicy ? writeQuarantine(reportDir, verdict, now) : null;
    actionsWritten = Boolean(actionsFile);
    quarantineWritten = Boolean(quarantineFile);
    if (actionsFile) files.push(actionsFile);
    if (quarantineFile) files.push(quarantineFile);
  }
  let issued = false;
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L3 Job Quality: apply handoff cannot be trusted',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'jobs', 'loop-l3'],
      workflow: 'Loop L3 Job Quality to Apply',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, actionsWritten, quarantineWritten });
  if (resultFile) files.push(resultFile);
  logger.log(`[L3] ${verdict.ok ? 'OK' : 'ACTION REQUIRED'} — ${verdict.reason}`);
  return { verdict, observation, decision, files, issued, actionsWritten, quarantineWritten };
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
    summaryDir: valueAfter('--summary-dir', DEFAULT_SUMMARY_DIR),
    outcomePath: valueAfter('--outcomes', DEFAULT_OUTCOME_PATH),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    minimumSample,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l3')
      : path.join(os.tmpdir(), 'loop-fleet-l3')),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json ? { ...logger, log: () => {} } : logger;
  const result = await runL3({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    issued: result.issued,
    actionsWritten: result.actionsWritten,
    quarantineWritten: result.quarantineWritten,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L3] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
