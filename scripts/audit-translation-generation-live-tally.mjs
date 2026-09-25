#!/usr/bin/env node

/**
 * Verify the live translation-scheduler generation series.
 *
 * A scheduler report is not live evidence merely because it says `settled`:
 * the report must be carried by a real Actions run of the shadow workflow,
 * its closure digest must be self-consistent, and its plan/settlement objects
 * must still be present at the bound translation-state tip. Reports emitted
 * before the closure contract existed are intentionally ignored as legacy
 * observations; they can never increase the verified-generation count.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGitHubActionsReadClient,
} from './lib/github-actions-read-client.mjs';
import {
  TRANSLATION_GENERATION_ARTIFACT_NAME,
  TRANSLATION_GENERATION_REQUIRED_MAX,
  TRANSLATION_GENERATION_WORKFLOW_FILE,
  digestTranslationGenerationClosure,
  validateTranslationGenerationClosure,
} from './lib/translation-generation-closure-v2.mjs';
import {
  validateTranslationScheduleV2,
  validateTranslationSettlementV2,
} from './lib/translation-completion-scheduler-v2.mjs';
import {
  canonicalTranslationJsonV2,
  digestTranslationDocumentV2,
} from './lib/translation-unit-identity-v2.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPORT_MAX_BYTES = 512 * 1024;
const ARTIFACT_MAX_BYTES = 1024 * 1024;
const ARTIFACT_SET_MAX = 100;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const STATE_REF = 'refs/heads/translation-state-v2';

function normalizeWorkflowFile(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('translation generation workflow is required');
  }
  const normalized = value.startsWith('.github/workflows/')
    ? value
    : `.github/workflows/${value}`;
  if (normalized !== TRANSLATION_GENERATION_WORKFLOW_FILE) {
    throw new TypeError(`unsupported translation generation workflow: ${normalized}`);
  }
  return normalized;
}

function normalizeRequired(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > TRANSLATION_GENERATION_REQUIRED_MAX) {
    throw new TypeError(`required generations must be an integer between 1 and ${TRANSLATION_GENERATION_REQUIRED_MAX}`);
  }
  return parsed;
}

function normalizeRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new TypeError('GitHub repository must be owner/name');
  }
  return value;
}

function normalizeStateRef(value) {
  if (typeof value !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)
      || value === 'refs/heads/main') {
    throw new TypeError('translation state ref must be a dedicated branch ref');
  }
  return value;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function unique(values) {
  return [...new Set(values)];
}

function reportHasClosure(report) {
  return report !== null
    && typeof report === 'object'
    && !Array.isArray(report)
    && Object.hasOwn(report, 'closure');
}

function boundedJsonFile(filePath, maxBytes = REPORT_MAX_BYTES) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new TypeError(`JSON report is missing or exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function git(repository, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGTERM',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${error?.stderr || error?.message || error}`);
  }
}

function stateScopePrefix(scopeKey) {
  const digest = digestTranslationDocumentV2({ scopeKey });
  return `v2/scheduler/${digest.slice(0, 2)}/${digest}`;
}

function stateArtifactPaths(scopeKey, planHash) {
  const prefix = stateScopePrefix(scopeKey);
  const digest = planHash.split(':').at(-1);
  return {
    plan: `${prefix}/plans/${digest}.json`,
    settlement: `${prefix}/settlements/${digest}.json`,
  };
}

function readStateJson(repository, commit, filePath) {
  const raw = git(repository, ['show', `${commit}:${filePath}`]);
  if (Buffer.byteLength(raw) > REPORT_MAX_BYTES) {
    throw new TypeError(`state artifact ${filePath} exceeds the bounded size`);
  }
  return JSON.parse(raw);
}

/**
 * Fetch the dedicated state ref once and return a verifier for report tips.
 * The verifier is deliberately separate from the pure series evaluator so
 * tests can exercise the closure rules without fabricating GitHub API calls.
 */
export function createTranslationStateTipVerifier({
  repository,
  remote = 'origin',
  stateRef = STATE_REF,
} = {}) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new TypeError('state repository is required');
  }
  const checkedRepository = path.resolve(repository);
  if (!fs.existsSync(path.join(checkedRepository, '.git'))) {
    throw new TypeError('state repository must be a git checkout');
  }
  const checkedRef = normalizeStateRef(stateRef);
  const remoteLine = git(checkedRepository, ['ls-remote', '--refs', remote, checkedRef]).trim();
  const currentTip = remoteLine ? remoteLine.split(/\s+/u)[0] : null;
  if (!SHA_PATTERN.test(currentTip ?? '')) {
    throw new Error(`translation state ref ${checkedRef} is unavailable`);
  }
  git(checkedRepository, ['fetch', '--no-tags', remote, checkedRef]);
  git(checkedRepository, ['cat-file', '-e', `${currentTip}^{commit}`]);

  return ({ closure }) => {
    validateTranslationGenerationClosure(closure);
    if (closure.stateRef !== checkedRef) throw new Error('state_ref_binding_invalid');
    if (!SHA_PATTERN.test(closure.stateTip)) throw new Error('state_tip_invalid');
    git(checkedRepository, ['cat-file', '-e', `${closure.stateTip}^{commit}`]);
    const ancestor = git(
      checkedRepository,
      ['merge-base', '--is-ancestor', closure.stateTip, currentTip],
      { allowFailure: true },
    );
    if (ancestor === null) throw new Error('state_tip_not_reachable');
    const paths = stateArtifactPaths(closure.scopeKey, closure.plan.hash);
    const plan = validateTranslationScheduleV2(
      readStateJson(checkedRepository, closure.stateTip, paths.plan),
    );
    const settlement = validateTranslationSettlementV2(
      readStateJson(checkedRepository, closure.stateTip, paths.settlement),
      plan,
    );
    if (plan.planHash !== closure.plan.hash
        || plan.scanDigest !== closure.plan.scanDigest
        || plan.baselineMainSha !== closure.sourceCommit
        || plan.cursorBeforeHash !== closure.plan.cursorBeforeHash
        || plan.cursorAfter.cursorHash !== closure.plan.cursorAfterHash
        || plan.cursorAfter.generation !== closure.generation
        || settlement.settlementHash !== closure.settlement.hash
        || settlement.planHash !== closure.settlement.planHash
        || settlement.cursor.cursorHash !== closure.settlement.cursorHash
        || canonicalTranslationJsonV2(settlement.metrics)
          !== canonicalTranslationJsonV2(closure.settlement.metrics)) {
      throw new Error('state_closure_binding_invalid');
    }
    return { currentTip, plan, settlement };
  };
}

function valueFromRun(run, key, fallback = null) {
  return run && Object.hasOwn(run, key) ? run[key] : fallback;
}

function runIdOf(run) {
  const value = valueFromRun(run, 'id');
  return value === null || value === undefined ? null : String(value);
}

function runPathOf(run) {
  return run?.path || run?.workflow_file || run?.workflowFile || null;
}

function runRepositoryOf(run) {
  return run?.repository?.full_name || run?.repository?.fullName || null;
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function canonicalOrNull(value) {
  if (value === undefined) return 'undefined';
  try {
    return canonicalTranslationJsonV2(value);
  } catch {
    return 'invalid';
  }
}

function validateRunBinding({ closure, run, expectedWorkflow, expectedRepository, current }) {
  const reasons = [];
  const binding = closure.runBinding;
  if (binding.workflow !== expectedWorkflow) addReason(reasons, 'workflow_binding_invalid');
  if (!RUN_ID_PATTERN.test(binding.runId ?? '') || !RUN_ID_PATTERN.test(binding.runAttempt ?? '')) {
    addReason(reasons, 'actions_run_binding_missing');
  }
  if (binding.repository !== expectedRepository) addReason(reasons, 'repository_binding_invalid');
  if (!run) {
    addReason(reasons, 'actions_run_missing');
    return reasons;
  }
  if (runIdOf(run) !== binding.runId) addReason(reasons, 'run_id_binding_invalid');
  if (String(valueFromRun(run, 'run_attempt', '')) !== binding.runAttempt) {
    addReason(reasons, 'run_attempt_binding_invalid');
  }
  if (runPathOf(run) !== expectedWorkflow) addReason(reasons, 'workflow_path_invalid');
  if (valueFromRun(run, 'head_sha') !== closure.sourceCommit) addReason(reasons, 'source_commit_binding_invalid');
  if (runRepositoryOf(run) !== null && runRepositoryOf(run) !== expectedRepository) {
    addReason(reasons, 'run_repository_binding_invalid');
  }
  if (binding.event !== null && valueFromRun(run, 'event') !== binding.event) {
    addReason(reasons, 'event_binding_invalid');
  }
  const status = valueFromRun(run, 'status');
  const conclusion = valueFromRun(run, 'conclusion');
  if (current) {
    if (!['queued', 'in_progress', 'completed'].includes(status)) addReason(reasons, 'current_run_status_invalid');
    if (status === 'completed' && conclusion !== 'success') addReason(reasons, 'current_run_conclusion_invalid');
  } else if (status !== 'completed' || conclusion !== 'success') {
    addReason(reasons, 'actions_run_not_successfully_settled');
  }
  return reasons;
}

function validateReportShape({ report, expectedWorkflow }) {
  const reasons = [];
  if (report.status !== 'settled') addReason(reasons, 'report_not_settled');
  if (report.closure === null || typeof report.closure !== 'object') {
    addReason(reasons, 'closure_missing');
    return reasons;
  }
  let closure;
  try {
    closure = validateTranslationGenerationClosure(report.closure);
  } catch {
    addReason(reasons, 'closure_invalid');
    return reasons;
  }
  if (typeof report.closureDigest !== 'string'
      || report.closureDigest !== digestTranslationGenerationClosure(closure)) {
    addReason(reasons, 'closure_digest_invalid');
  }
  if (closure.runBinding.workflow !== expectedWorkflow) addReason(reasons, 'closure_workflow_invalid');
  if (report.sourceCommit !== closure.sourceCommit
      || report.scanDigest !== closure.plan.scanDigest
      || report.planHash !== closure.plan.hash
      || report.stateRef !== closure.stateRef
      || report.state?.after !== closure.stateTip
      || report.state?.settled !== true
      || report.scheduler?.selectedJobs !== closure.result.selectedJobs
      || report.scheduler?.selectedUnits !== closure.result.selectedUnits
      || canonicalOrNull(report.scheduler?.outcomeCounts)
        !== canonicalOrNull(closure.result.outcomeCounts)
      || canonicalOrNull(report.scheduler?.settlement)
        !== canonicalOrNull(closure.settlement.metrics)
      || canonicalOrNull(report.candidates)
        !== canonicalOrNull(closure.result.candidateCounts)) {
    addReason(reasons, 'report_closure_binding_invalid');
  }
  if (closure.canary.mainPublish !== false) addReason(reasons, 'main_publish_enabled');
  return reasons;
}

/**
 * Pure evaluator used by the live CLI and by the focused Vitest observer.
 * `records` must carry an Actions run and a state verification result; a bare
 * JSON fixture is intentionally not accepted as live evidence.
 */
export function evaluateTranslationGenerationSeries({
  records,
  required = 14,
  workflowFile = TRANSLATION_GENERATION_WORKFLOW_FILE,
  repository,
} = {}) {
  const expectedWorkflow = normalizeWorkflowFile(workflowFile);
  const expectedRepository = normalizeRepository(repository);
  const checkedRequired = normalizeRequired(required);
  if (!Array.isArray(records)) throw new TypeError('translation generation records must be an array');

  const violations = [];
  const valid = [];
  let ignoredReports = 0;
  for (const record of records) {
    const report = record?.report;
    if (!reportHasClosure(report) || report.closure === null) {
      ignoredReports += 1;
      continue;
    }
    const reasons = validateReportShape({ report, expectedWorkflow });
    let closure = null;
    if (reasons.length === 0) {
      closure = report.closure;
      reasons.push(...validateRunBinding({
        closure,
        run: record.run,
        expectedWorkflow,
        expectedRepository,
        current: record.current === true,
      }));
      if (record.current !== true && !record.artifact) addReason(reasons, 'artifact_binding_missing');
      if (record.current !== true && record.artifact?.name !== TRANSLATION_GENERATION_ARTIFACT_NAME) {
        addReason(reasons, 'artifact_name_invalid');
      }
      if (record.current !== true && record.artifact?.expired !== false) {
        addReason(reasons, 'artifact_expired_or_invalid');
      }
      if (record.current !== true
          && String(record.artifact?.workflow_run?.id ?? '') !== closure.runBinding.runId) {
        addReason(reasons, 'artifact_run_binding_invalid');
      }
      if (!record.stateVerification) addReason(reasons, 'state_closure_unverified');
      if (record.stateVerification?.error) addReason(reasons, record.stateVerification.error);
    }
    if (reasons.length > 0) {
      violations.push(...reasons);
      continue;
    }
    valid.push({
      generation: closure.generation,
      closure,
      closureDigest: report.closureDigest,
      report,
      runId: closure.runBinding.runId,
      stateTip: closure.stateTip,
      createdAt: record.run?.created_at || record.artifact?.created_at || null,
    });
  }

  valid.sort((left, right) => left.generation - right.generation
    || compareText(left.runId || '', right.runId || ''));
  const byGeneration = new Map();
  for (const entry of valid) {
    if (byGeneration.has(entry.generation)) {
      addReason(violations, 'generation_duplicate');
      continue;
    }
    byGeneration.set(entry.generation, entry);
  }
  const ordered = [...byGeneration.values()].sort((left, right) => left.generation - right.generation);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].generation !== ordered[index - 1].generation + 1) {
      addReason(violations, 'generation_gap');
    }
    if (ordered[index].stateTip === ordered[index - 1].stateTip) {
      addReason(violations, 'state_tip_duplicate');
    }
  }
  if (ordered.length > 1) {
    const first = ordered[0].closure;
    for (const entry of ordered.slice(1)) {
      if (entry.closure.scopeKey !== first.scopeKey
          || canonicalTranslationJsonV2(entry.closure.providerContract)
            !== canonicalTranslationJsonV2(first.providerContract)
          || canonicalTranslationJsonV2(entry.closure.canary)
            !== canonicalTranslationJsonV2(first.canary)
          || entry.closure.stateRef !== first.stateRef) {
        addReason(violations, 'series_binding_mismatch');
        break;
      }
    }
  }

  const selected = ordered.slice(-checkedRequired);
  const validGenerations = selected.length;
  const uniqueViolations = unique(violations);
  const complete = validGenerations === checkedRequired && uniqueViolations.length === 0;
  return {
    schemaVersion: 1,
    workflow: expectedWorkflow,
    artifactName: TRANSLATION_GENERATION_ARTIFACT_NAME,
    requiredGenerations: checkedRequired,
    validGenerations,
    complete,
    status: uniqueViolations.length > 0 ? 'invalid' : complete ? 'complete' : 'incomplete',
    violations: uniqueViolations,
    ignoredReports,
    generations: selected.map((entry) => ({
      generation: entry.generation,
      closureDigest: entry.closureDigest,
      sourceCommit: entry.closure.sourceCommit,
      stateTip: entry.stateTip,
      runId: entry.runId,
      runAttempt: entry.closure.runBinding.runAttempt,
      createdAt: entry.createdAt,
    })),
  };
}

function validateArtifactEnvelope(artifact) {
  if (!artifact || typeof artifact !== 'object'
      || artifact.name !== TRANSLATION_GENERATION_ARTIFACT_NAME
      || !Number.isSafeInteger(artifact.id) || artifact.id < 1
      || artifact.expired !== false
      || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
      || artifact.size_in_bytes > ARTIFACT_MAX_BYTES
      || !RUN_ID_PATTERN.test(String(artifact.workflow_run?.id ?? ''))) {
    throw new Error('translation_generation_artifact_invalid');
  }
}

function readArtifactJson(archiveBytes, runnerTemp, expectedName = 'translation-scheduler-v2-report.json') {
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.length < 1 || archiveBytes.length > ARTIFACT_MAX_BYTES) {
    throw new Error('translation_generation_artifact_archive_invalid');
  }
  const root = fs.mkdtempSync(path.join(runnerTemp, 'translation-generation-audit-'));
  const archivePath = path.join(root, 'artifact.zip');
  fs.writeFileSync(archivePath, archiveBytes);
  try {
    const names = execFileSync('unzip', ['-Z', '-1', archivePath], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
    }).split('\n').filter(Boolean);
    if (names.length !== 1 || names[0] !== expectedName) {
      throw new Error('translation_generation_artifact_member_invalid');
    }
    const raw = execFileSync('unzip', ['-p', archivePath, expectedName], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: REPORT_MAX_BYTES + 1,
    });
    if (Buffer.byteLength(raw) < 1 || Buffer.byteLength(raw) > REPORT_MAX_BYTES) {
      throw new Error('translation_generation_report_too_large');
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error?.message?.startsWith('translation_generation_')) throw error;
    throw new Error('translation_generation_artifact_archive_invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function currentRunFromEnvironment({ repository, workflowFile }) {
  const runId = String(process.env.GITHUB_RUN_ID || '');
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT || '');
  const headSha = process.env.GITHUB_SHA || '';
  if (process.env.GITHUB_ACTIONS !== 'true'
      || !RUN_ID_PATTERN.test(runId)
      || !RUN_ID_PATTERN.test(runAttempt)
      || !SHA_PATTERN.test(headSha)) return null;
  return {
    id: runId,
    run_attempt: Number(runAttempt),
    path: workflowFile,
    status: 'in_progress',
    conclusion: null,
    event: process.env.GITHUB_EVENT_NAME || null,
    head_sha: headSha,
    repository: { full_name: repository },
  };
}

function writeReport(report, reportPath) {
  if (!reportPath) return;
  const absolute = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function tallyWithError({ workflow, required, repository, reason }) {
  return {
    schemaVersion: 1,
    workflow,
    artifactName: TRANSLATION_GENERATION_ARTIFACT_NAME,
    requiredGenerations: required,
    validGenerations: 0,
    complete: false,
    status: 'error',
    violations: [reason],
    ignoredReports: 0,
    generations: [],
    repository,
  };
}

/**
 * Collect the current report plus bounded, exact-name Actions artifacts and
 * evaluate the cumulative live series. All network and state reads are
 * injectable so the evaluator remains deterministic in focused tests.
 */
export async function runTranslationGenerationLiveTally({
  workflowFile = TRANSLATION_GENERATION_WORKFLOW_FILE,
  required = 14,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  currentReport,
  currentReportPath,
  currentRun,
  client,
  readArtifact,
  stateVerifier,
  stateRepository = process.cwd(),
  stateRef = STATE_REF,
  runnerTemp = process.env.RUNNER_TEMP || os.tmpdir(),
  now = () => new Date().toISOString(),
} = {}) {
  const expectedWorkflow = normalizeWorkflowFile(workflowFile);
  const checkedRequired = normalizeRequired(required);
  const checkedRepository = normalizeRepository(repository);
  fs.mkdirSync(runnerTemp, { recursive: true });
  const reports = [];
  const localReport = currentReport
    || (currentReportPath ? boundedJsonFile(currentReportPath) : null);
  if (localReport) {
    reports.push({
      report: localReport,
      run: currentRun || currentRunFromEnvironment({
        repository: checkedRepository,
        workflowFile: expectedWorkflow,
      }),
      current: true,
    });
  }

  const actionsClient = client || createGitHubActionsReadClient({
    apiUrl,
    token,
  });
  const artifactsResponse = await actionsClient.json(
    `/repos/${checkedRepository}/actions/artifacts?name=${encodeURIComponent(TRANSLATION_GENERATION_ARTIFACT_NAME)}&per_page=${ARTIFACT_SET_MAX}`,
  );
  if (!Number.isSafeInteger(artifactsResponse?.total_count)
      || !Array.isArray(artifactsResponse.artifacts)
      || artifactsResponse.total_count !== artifactsResponse.artifacts.length
      || artifactsResponse.total_count > ARTIFACT_SET_MAX) {
    throw new Error('translation_generation_artifact_set_invalid');
  }
  for (const artifact of artifactsResponse.artifacts) {
    if (artifact?.expired === true) continue;
    validateArtifactEnvelope(artifact);
    const runId = String(artifact.workflow_run.id);
    const run = await actionsClient.json(`/repos/${checkedRepository}/actions/runs/${runId}`);
    const report = readArtifact
      ? await readArtifact(artifact, run)
      : readArtifactJson(
        await actionsClient.bytes(
          `/repos/${checkedRepository}/actions/artifacts/${artifact.id}/zip`,
          ARTIFACT_MAX_BYTES,
        ),
        runnerTemp,
      );
    reports.push({ artifact, run, report });
  }

  let verifier = stateVerifier;
  if (!verifier) {
    verifier = createTranslationStateTipVerifier({
      repository: stateRepository,
      stateRef,
    });
  }
  for (const record of reports) {
    if (!reportHasClosure(record.report) || record.report.closure === null) continue;
    try {
      record.stateVerification = await verifier({ closure: record.report.closure, report: record.report });
    } catch (error) {
      record.stateVerification = { error: error?.message || 'state_closure_unverified' };
    }
  }
  const tally = evaluateTranslationGenerationSeries({
    records: reports,
    required: checkedRequired,
    workflowFile: expectedWorkflow,
    repository: checkedRepository,
  });
  return {
    ...tally,
    checkedAt: now(),
    repository: checkedRepository,
    source: 'github-actions-artifacts-and-translation-state-ref',
  };
}

function parseArguments(argv) {
  const values = { required: '14' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      values.json = true;
      continue;
    }
    const key = {
      '--workflow': 'workflowFile',
      '--required': 'required',
      '--current-report': 'currentReportPath',
      '--report': 'reportPath',
      '--repository': 'repository',
      '--state-ref': 'stateRef',
      '--runner-temp': 'runnerTemp',
    }[flag];
    if (!key || typeof argv[index + 1] !== 'string' || argv[index + 1].length === 0) {
      throw new TypeError('usage: node scripts/audit-translation-generation-live-tally.mjs --workflow <file> --required <n> [--current-report <path>] [--report <path>] [--json]');
    }
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main(argv) {
  const values = parseArguments(argv);
  const workflowFile = normalizeWorkflowFile(values.workflowFile || TRANSLATION_GENERATION_WORKFLOW_FILE);
  const required = normalizeRequired(values.required);
  const repository = normalizeRepository(values.repository || process.env.GITHUB_REPOSITORY);
  let tally;
  try {
    tally = await runTranslationGenerationLiveTally({
      workflowFile,
      required,
      repository,
      currentReportPath: values.currentReportPath,
      stateRepository: process.cwd(),
      stateRef: values.stateRef || STATE_REF,
      runnerTemp: values.runnerTemp || process.env.RUNNER_TEMP || os.tmpdir(),
    });
  } catch (error) {
    tally = tallyWithError({
      workflow: workflowFile,
      required,
      repository,
      reason: error?.message || 'translation_generation_live_audit_failed',
    });
  }
  writeReport(tally, values.reportPath);
  const output = JSON.stringify(tally);
  if (values.json) process.stdout.write(`${output}\n`);
  else process.stdout.write(`${tally.status}: ${tally.validGenerations}/${tally.requiredGenerations} verified generation(s)\n`);
  if (tally.status === 'invalid' || tally.status === 'error') process.exitCode = 1;
}

if (SCRIPT_PATH === path.resolve(process.argv[1] || '')) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
