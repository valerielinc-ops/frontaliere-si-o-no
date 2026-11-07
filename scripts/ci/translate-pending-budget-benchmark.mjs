#!/usr/bin/env node

/**
 * End-to-end evidence runner for the translate-pending Phase 2d/2e budget.
 *
 * The workflow uses this wrapper around the real lane, commit, statistics and
 * handoff commands. It records the queue before and after the selected lane,
 * so a fast no-op run cannot be presented as capacity evidence. Commits are
 * pushed only to the workflow's local bare remote; the production main ref is
 * never a target of this benchmark.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { titleRepairQueueLocales } from '../lib/untranslated-title-repair.mjs';

const MINUTE_MS = 60_000;
const JOB_CAP_MS = 350 * MINUTE_MS;
const PHASES = new Set(['titles', 'descriptions']);
const ROOT = path.resolve(import.meta.dirname, '../..');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function reportPath() {
  return path.resolve(argument('--report', path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'translate-pending-budget-benchmark.json',
  )));
}

function readReport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function sha256(parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function sourceIdentity(job, file, index) {
  return String(job?.id || job?.url || `${file}:${index}`);
}

async function descriptionTasks() {
  const module = await import('../fix-untranslated-descriptions.mjs');
  if (typeof module.collectDescriptionFixTasks !== 'function') {
    throw new Error('description queue collector is not exported');
  }
  return module.collectDescriptionFixTasks;
}

/**
 * Capture the exact slice population and the selected repair queue. The slice
 * digest is the same-population anchor; the candidate digest proves which
 * repair cohort the lane actually saw.
 */
export async function capturePopulation(phase) {
  if (!PHASES.has(phase)) throw new Error(`unsupported benchmark phase ${JSON.stringify(phase)}`);
  const files = listSliceFileNames(path.join(ROOT, 'data/jobs/by-crawler')).sort();
  const sliceDigestParts = [];
  const candidates = [];
  let jobCount = 0;
  const collectDescriptions = phase === 'descriptions' ? await descriptionTasks() : null;

  for (const file of files) {
    const relative = path.join('data/jobs/by-crawler', file);
    const raw = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    sliceDigestParts.push(relative, '\0', raw, '\0');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    jobCount += jobs.length;
    const indexByJob = new Map(jobs.map((job, index) => [job, index]));

    if (phase === 'titles') {
      jobs.forEach((job, index) => {
        for (const { locale } of titleRepairQueueLocales(job, ['it', 'en', 'de', 'fr'])) {
          candidates.push(`${relative}:${index}:${sourceIdentity(job, file, index)}:${locale}`);
        }
      });
      continue;
    }

    for (const task of collectDescriptions(jobs)) {
      const index = indexByJob.get(task.job);
      if (!Number.isInteger(index)) throw new Error(`description task escaped its source slice: ${file}`);
      candidates.push(`${relative}:${index}:${sourceIdentity(task.job, file, index)}:${task.locale}`);
    }
  }

  candidates.sort();
  return {
    phase,
    fileCount: files.length,
    jobCount,
    candidateCount: candidates.length,
    sliceFingerprint: sha256(sliceDigestParts),
    candidateFingerprint: sha256(candidates.map((candidate) => `${candidate}\n`)),
    candidateSample: candidates.slice(0, 5),
    candidateTailSample: candidates.slice(-5),
  };
}

function baselineFromEnv() {
  const laneMinutes = Number(process.env.BENCHMARK_BASELINE_LANE_MINUTES);
  return {
    runId: String(process.env.BENCHMARK_BASELINE_RUN || '').trim(),
    laneMinutes: Number.isFinite(laneMinutes) && laneMinutes >= 0 ? laneMinutes : null,
    note: String(process.env.BENCHMARK_BASELINE_NOTE || '').trim(),
  };
}

export function createReport({ phase, sourceRef = '', runUrl = '' } = {}) {
  if (!PHASES.has(phase)) throw new Error(`unsupported benchmark phase ${JSON.stringify(phase)}`);
  const startedAt = Date.now();
  return {
    schemaVersion: 1,
    phase,
    sourceRef: String(sourceRef),
    sourceCommit: gitHead(),
    runUrl: String(runUrl),
    startedAt,
    jobCapMs: JOB_CAP_MS,
    baseline: baselineFromEnv(),
    stages: [],
  };
}

function processStatus(result) {
  if (result.error) return { status: 1, error: result.error.message };
  if (result.signal) return { status: 128, error: `terminated by ${result.signal}` };
  return { status: Number.isInteger(result.status) ? result.status : 1 };
}

async function recordStage({ filePath, stageName, command }) {
  if (command.length === 0) throw new Error(`stage ${stageName} has no command`);
  const report = readReport(filePath);
  const phase = report.phase;
  const populationBefore = stageName === 'lane' ? await capturePopulation(phase) : null;
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  const finishedAt = Date.now();
  const outcome = processStatus(result);
  const populationAfter = stageName === 'lane' ? await capturePopulation(phase) : null;
  const handoffPath = path.join(ROOT, 'data/translation-deploy-handoff.json');
  let handoffState = null;
  if (stageName === 'handoff' && fs.existsSync(handoffPath)) {
    try {
      handoffState = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))?.state || null;
    } catch {
      handoffState = 'invalid';
    }
  }
  report.stages.push({
    name: stageName,
    command,
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    ...outcome,
    ...(populationBefore ? { populationBefore } : {}),
    ...(populationAfter ? { populationAfter } : {}),
    ...(handoffState ? { handoffState } : {}),
  });
  writeReport(filePath, report);
  if (outcome.status !== 0) process.exitCode = outcome.status;
}

function stage(report, name) {
  return report.stages.find((item) => item.name === name) || null;
}

function minutes(ms) {
  return (Number(ms) / MINUTE_MS).toFixed(2);
}

function summary(report) {
  const lane = stage(report, 'lane');
  const handoff = stage(report, 'handoff');
  const finalAt = handoff?.finishedAt || report.finishedAt;
  const totalMs = finalAt - report.startedAt;
  const downstreamMs = handoff && lane ? handoff.finishedAt - lane.startedAt : null;
  const population = lane?.populationBefore;
  const after = lane?.populationAfter;
  const baselineDelta = report.baseline.laneMinutes == null || !lane
    ? null
    : Number(minutes(lane.elapsedMs)) - report.baseline.laneMinutes;

  return {
    ...report,
    finishedAt: finalAt,
    elapsedMs: totalMs,
    downstreamElapsedMs: downstreamMs,
    laneElapsedMs: lane?.elapsedMs ?? null,
    baselineLaneDeltaMinutes: baselineDelta,
    populationBefore: population,
    populationAfter: after,
    underJobCap: totalMs < report.jobCapMs,
    samePopulation: Boolean(
      population
      && population.phase === report.phase
      && population.fileCount > 0
      && population.jobCount > 0
      && population.candidateCount > 0,
    ),
    candidateCountBefore: population?.candidateCount ?? 0,
    candidateCountAfter: after?.candidateCount ?? null,
    handoffState: handoff?.handoffState || null,
  };
}

function requiredStages(report) {
  return ['budget-gate', 'assemble', 'stats-before', 'lane', 'lane-commit', 'assemble-final', 'stats-after', 'slugs', 'slug-commit', 'handoff'];
}

function finalize(filePath) {
  const report = readReport(filePath);
  const result = summary(report);
  const missing = requiredStages(report).filter((name) => !stage(report, name));
  const failed = report.stages.filter((item) => item.status !== 0).map((item) => item.name);
  result.missingStages = missing;
  result.failedStages = failed;
  result.accepted = missing.length === 0
    && failed.length === 0
    && result.samePopulation
    && result.underJobCap
    && result.candidateCountBefore > 0
    && result.handoffState === 'complete'
    && Boolean(
      result.populationBefore
      && result.populationAfter
      && result.populationAfter.candidateFingerprint !== result.populationBefore.candidateFingerprint,
    );
  writeReport(filePath, result);

  const baselineText = result.baseline.runId
    ? `baseline run ${result.baseline.runId}: ${result.baseline.laneMinutes ?? 'unknown'}min lane`
    : 'baseline: not supplied';
  const lines = [
    '## Translate-pending budget benchmark',
    '',
    `- HEAD: \`${result.sourceCommit}\` (ref \`${result.sourceRef}\`)`,
    `- Phase: **${result.phase}**; population before lane: **${result.candidateCountBefore}** candidates, ${result.populationBefore?.jobCount ?? 0} jobs, ${result.populationBefore?.fileCount ?? 0} slices`,
    `- Population fingerprint: \`${result.populationBefore?.sliceFingerprint || 'missing'}\`; candidate fingerprint: \`${result.populationBefore?.candidateFingerprint || 'missing'}\``,
    `- Lane: **${minutes(result.laneElapsedMs ?? 0)}min**; after lane: ${result.candidateCountAfter ?? 'unknown'} candidates`,
    `- Lane → handoff: **${minutes(result.downstreamElapsedMs ?? 0)}min**; handoff state: **${result.handoffState || 'unknown'}**`,
    `- Measured benchmark elapsed: **${minutes(result.elapsedMs)}min** / 350min cap; under cap: **${result.underJobCap ? 'yes' : 'no'}**`,
    `- ${baselineText}; lane delta: ${result.baselineLaneDeltaMinutes == null ? 'unknown' : `${result.baselineLaneDeltaMinutes.toFixed(2)}min`}`,
    `- Acceptance: **${result.accepted ? 'PASS' : 'FAIL'}**`,
  ];
  if (result.baseline.note) lines.push(`- Baseline note: ${result.baseline.note}`);
  if (result.missingStages.length) lines.push(`- Missing stages: ${result.missingStages.join(', ')}`);
  if (result.failedStages.length) lines.push(`- Failed stages: ${result.failedStages.join(', ')}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
  }
  if (!result.accepted) process.exitCode = 1;
}

async function main() {
  const filePath = reportPath();
  const phase = argument('--phase', process.env.BENCHMARK_PHASE || '');
  const stageName = argument('--stage');

  if (hasFlag('--init')) {
    const report = createReport({
      phase,
      sourceRef: argument('--source-ref', process.env.BENCHMARK_SOURCE_REF || ''),
      runUrl: argument('--run-url', process.env.BENCHMARK_RUN_URL || ''),
    });
    writeReport(filePath, report);
    console.log(`Initialized translate-pending budget benchmark for ${phase} at ${report.sourceCommit}`);
    return;
  }
  if (hasFlag('--record')) {
    if (!stageName) throw new Error('--record requires --stage');
    const separator = process.argv.indexOf('--');
    const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
    await recordStage({ filePath, stageName, command });
    return;
  }
  if (hasFlag('--finalize')) {
    finalize(filePath);
    return;
  }
  throw new Error('usage: --init | --record --stage <name> -- <command...> | --finalize');
}

if ((() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  main().catch((error) => {
    console.error(`❌ translate-pending budget benchmark: ${error.message}`);
    process.exitCode = 1;
  });
}
