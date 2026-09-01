#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digestDocument } from './lib/canonical-json-digest.mjs';
import { isCrawlerGenerationToken } from './lib/crawler-generation-token.mjs';
import {
  classifyCrawlerGenerationObserverReport,
  createSentinelSetBinding,
  validateCrawlerGenerationObserverReport,
} from './lib/crawler-generation-observer-report.mjs';
import {
  createGitHubActionsReadClient,
  isMissingExactGitHubResource,
} from './lib/github-actions-read-client.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CALLER_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
const OBSERVER_WORKFLOW = 'crawler-generation-observer-shadow.yml';
const OBSERVER_PATH = `.github/workflows/${OBSERVER_WORKFLOW}`;
const OBSERVER_WORKFLOW_NAME = 'Crawler Generation Observer (shadow)';
const GENERATION_DISPATCH_REF_PREFIX = 'crawler-generation-shadow-';
const RUN_ID_RE = /^[1-9][0-9]*$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GROUP_IDS = Object.freeze(Array.from(
  { length: 23 },
  (_, index) => String(index + 1).padStart(2, '0'),
));
const TERMINAL_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'stale', 'startup_failure',
]);
const RUN_STATUSES = new Set(['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed']);
const DISCOVERY_WINDOW_MS = 13 * 24 * 60 * 60 * 1_000;
const TIMEOUT_AFTER_MS = 12 * 24 * 60 * 60 * 1_000;
const MAX_ARCHIVE_BYTES = 64 * 1024;
const MAX_SENTINEL_BYTES = 32 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;

export const MAX_DISCOVERY_RUNS = 100;
export const MAX_DISCOVERY_ARTIFACTS = 100;
export const MAX_DISCOVERY_TOKENS = 32;
export const MAX_DISCOVERY_BYTES = 1024 * 1024;
export const MAX_SCHEDULE_SELECTIONS = 2;

export function recordDiscoveredArtifactIds(seen, artifacts) {
  if (!(seen instanceof Set) || !Array.isArray(artifacts)) throw new TypeError('invalid_artifact_counter');
  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact?.id) || artifact.id < 1) {
      throw new TypeError('invalid_discovery_artifact_id');
    }
    seen.add(artifact.id);
  }
  if (seen.size > MAX_DISCOVERY_ARTIFACTS) throw new TypeError('discovery artifact cap exceeded');
  return seen.size;
}

export function crawlerGenerationSentinelDiscoveryPath(now) {
  if (!Number.isFinite(now)) throw new TypeError('invalid_discovery_timestamp');
  const created = encodeURIComponent(`>=${new Date(now - DISCOVERY_WINDOW_MS).toISOString()}`);
  return `/repos/${CALLER_REPOSITORY}/actions/workflows/${OBSERVER_WORKFLOW}/runs?event=workflow_dispatch&created=${created}&per_page=100`;
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validLifecycle(run) {
  if (!Number.isInteger(run?.run_attempt) || run.run_attempt < 1 || !RUN_STATUSES.has(run?.status)) {
    return false;
  }
  return run.status === 'completed'
    ? TERMINAL_CONCLUSIONS.has(run.conclusion)
    : run.conclusion === null;
}

function exactWorkflowPath(value, base, ref) {
  return value === base || value === `${base}@${ref}`;
}

function generationDispatchRef(generationToken) {
  return `${GENERATION_DISPATCH_REF_PREFIX}${generationToken}`;
}

function exactRunBase(run, runId, headBranch = 'main') {
  return String(run?.id ?? '') === String(runId)
    && run?.repository?.full_name === CALLER_REPOSITORY
    && exactWorkflowPath(run?.path, OBSERVER_PATH, headBranch)
    && run?.head_branch === headBranch
    && COMMIT_RE.test(run?.head_sha ?? '')
    && validLifecycle(run);
}

export function validateSentinelOwnerRun(run, { runId, generationToken, corpusCodeCommit }) {
  const runName = `crawler-generation-sentinel-${generationToken}`;
  return RUN_ID_RE.test(String(runId ?? ''))
    && isCrawlerGenerationToken(generationToken)
    && COMMIT_RE.test(corpusCodeCommit ?? '')
    && exactRunBase(run, runId, generationDispatchRef(generationToken))
    && (run.name === OBSERVER_WORKFLOW_NAME || run.name === runName)
    && run.display_title === runName
    && run.event === 'workflow_dispatch'
    && run.head_sha === corpusCodeCommit;
}

export function validateObserverReportOwnerRun(run, runId, generationToken = null) {
  const headBranch = run?.event === 'workflow_dispatch' && isCrawlerGenerationToken(generationToken)
    ? generationDispatchRef(generationToken)
    : 'main';
  if (!RUN_ID_RE.test(String(runId ?? '')) || !exactRunBase(run, runId, headBranch)) return false;
  let expectedName;
  if (run.event === 'schedule') expectedName = `crawler-generation-observer-schedule-${runId}`;
  else if (run.event === 'workflow_run') {
    expectedName = /^crawler-generation-observer-event-[1-9][0-9]*$/.test(run.display_title ?? '')
      ? run.display_title
      : null;
  } else if (run.event === 'workflow_dispatch' && isCrawlerGenerationToken(generationToken)) {
    expectedName = `crawler-generation-sentinel-${generationToken}`;
  } else return false;
  return expectedName !== null
    && (run.name === OBSERVER_WORKFLOW_NAME || run.name === expectedName)
    && run.display_title === expectedName;
}

/** Select the newest self-validating report after exact-ID owner validation. */
export function selectLatestCrawlerGenerationObserverReport({
  generationToken,
  expected = null,
  records,
}) {
  if (!isCrawlerGenerationToken(generationToken) || !Array.isArray(records)) {
    throw new TypeError('invalid_observer_report_records');
  }
  const valid = records.filter(({ ownerRun, report }) => (
    validateObserverReportOwnerRun(ownerRun, String(ownerRun?.id ?? ''), generationToken)
    && validateCrawlerGenerationObserverReport(report, expected).valid
  ));
  valid.sort((left, right) => {
    const leftCreated = Date.parse(left.ownerRun.created_at ?? '');
    const rightCreated = Date.parse(right.ownerRun.created_at ?? '');
    const byCreated = (Number.isFinite(rightCreated) ? rightCreated : 0)
      - (Number.isFinite(leftCreated) ? leftCreated : 0);
    if (byCreated !== 0) return byCreated;
    const leftId = BigInt(String(left.ownerRun.id));
    const rightId = BigInt(String(right.ownerRun.id));
    return rightId > leftId ? 1 : rightId < leftId ? -1 : 0;
  });
  return valid.length === 0
    ? { report: null, reportOwnerRun: null }
    : { report: valid[0].report, reportOwnerRun: valid[0].ownerRun };
}

function candidateExpectedBinding(candidate) {
  return {
    generationToken: candidate.generationToken,
    siteCodeCommit: candidate.siteCodeCommit,
    corpusCodeCommit: candidate.corpusCodeCommit,
    sentinelDigest: candidate.sentinelDigest,
    sentinelSetDigest: candidate.sentinelSetDigest,
    sentinelReplayCount: candidate.sentinelReplayCount,
  };
}

/** Pure fairness/terminal selector over already hard-bound discovery evidence. */
export function selectCrawlerGenerationReconciliations({ now, candidates }) {
  if (!Number.isFinite(now) || !Array.isArray(candidates)) throw new TypeError('invalid_selector_input');
  const byToken = new Map();
  for (const candidate of candidates) {
    if (!isCrawlerGenerationToken(candidate?.generationToken)) throw new TypeError('invalid_selector_candidate');
    const prior = byToken.get(candidate.generationToken);
    if (prior && canonicalJson(prior) !== canonicalJson(candidate)) {
      throw new TypeError('duplicate_generation_token_conflict');
    }
    byToken.set(candidate.generationToken, candidate);
  }
  if (byToken.size > MAX_DISCOVERY_TOKENS) throw new TypeError('discovery token cap exceeded');

  const eligible = [];
  for (const candidate of byToken.values()) {
    const createdAt = Date.parse(candidate.sentinelCreatedAt ?? '');
    if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > DISCOVERY_WINDOW_MS) continue;
    const timedOut = now - createdAt >= TIMEOUT_AFTER_MS;
    let terminal = false;
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    if (candidate.report !== null) {
      lastAttemptAt = Date.parse(candidate.report?.evaluatedAt ?? '');
      if (!Number.isFinite(lastAttemptAt)) lastAttemptAt = Number.NEGATIVE_INFINITY;
      const ownerRunId = candidate.reportOwnerRun?.id;
      if (validateObserverReportOwnerRun(
        candidate.reportOwnerRun,
        String(ownerRunId ?? ''),
        candidate.generationToken,
      )) {
        terminal = classifyCrawlerGenerationObserverReport(candidate.report, {
          expected: candidateExpectedBinding(candidate),
          now,
          sentinelCreatedAt: createdAt,
        }).terminal;
      }
    }
    if (terminal) continue;
    if (!candidate.dispatchMissing && !candidate.groupBindingInvalid
        && !candidate.allRunsTerminal && !timedOut) continue;
    eligible.push({ candidate, timedOut, lastAttemptAt });
  }
  eligible.sort((left, right) => (
    left.lastAttemptAt - right.lastAttemptAt
    || compareCodePoint(left.candidate.generationToken, right.candidate.generationToken)
  ));
  return eligible.slice(0, MAX_SCHEDULE_SELECTIONS).map(({ candidate, timedOut }) => ({
    generationToken: candidate.generationToken,
    sentinelRunId: candidate.sentinelRunId,
    siteCodeCommit: candidate.siteCodeCommit,
    timedOut,
  }));
}

function validateSentinelDocument(sentinel) {
  if (!sentinel || sentinel.schemaVersion !== 1
      || !isCrawlerGenerationToken(sentinel.generationToken)
      || !COMMIT_RE.test(sentinel.siteCodeCommit ?? '')
      || !COMMIT_RE.test(sentinel.corpusCodeCommit ?? '')
      || sentinel.callerRepository !== CALLER_REPOSITORY
      || !HASH_RE.test(sentinel.digest ?? '')
      || sentinel.digest !== digestDocument(Object.fromEntries(
        Object.entries(sentinel).filter(([key]) => key !== 'digest'),
      ))
      || canonicalJson(Object.keys(sentinel.groups ?? {}).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    return false;
  }
  return GROUP_IDS.every((group) => {
    const value = sentinel.groups[group];
    const runId = value?.runId === null ? null : String(value?.runId ?? '');
    return value?.workflowFile === `crawler-group-${group}.yml`
      && value?.workflowName === `Crawler Group ${group} (sparse cross-repo execution)`
      && (runId === null || RUN_ID_RE.test(runId))
      && value?.runName === `crawler-generation-${sentinel.generationToken}-group-${group}`
      && value?.artifactName === (runId === null ? null : `crawler-group-${group}-terminal-${runId}`)
      && value?.corpusCodeCommit === sentinel.corpusCodeCommit;
  });
}

function validateGroupRun(run, sentinel, group) {
  const binding = sentinel.groups[group];
  return String(run?.id ?? '') === String(binding.runId)
    && run?.repository?.full_name === CALLER_REPOSITORY
    && exactWorkflowPath(
      run?.path,
      `.github/workflows/${binding.workflowFile}`,
      generationDispatchRef(sentinel.generationToken),
    )
    && (run?.name === binding.workflowName || run?.name === binding.runName)
    && run?.display_title === binding.runName
    && run?.event === 'workflow_dispatch'
    && run?.head_branch === generationDispatchRef(sentinel.generationToken)
    && run?.head_sha === sentinel.corpusCodeCommit
    && validLifecycle(run);
}

function safeArtifact(artifact, expectedName) {
  return artifact?.name === expectedName
    && artifact?.expired === false
    && Number.isSafeInteger(artifact?.id) && artifact.id >= 1
    && Number.isSafeInteger(artifact?.workflow_run?.id) && artifact.workflow_run.id >= 1
    && Number.isSafeInteger(artifact?.size_in_bytes) && artifact.size_in_bytes >= 1
    && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES;
}

function readArchiveJson(archivePath, expectedName, maxBytes) {
  const names = execFileSync('unzip', ['-Z', '-1', archivePath], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_ARCHIVE_BYTES,
  }).split('\n').filter(Boolean);
  if (names.length !== 1 || names[0] !== expectedName || expectedName.includes('/')) {
    throw new TypeError('artifact archive member invalid');
  }
  const details = execFileSync('unzip', ['-Z', '-v', archivePath], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
  });
  const size = Number(/uncompressed size:\s+(\d+) bytes/.exec(details)?.[1]);
  const regular = /Unix file attributes \(100[0-7]{3} octal\):\s+-/.test(details);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !regular) {
    throw new TypeError('artifact archive payload invalid');
  }
  const bytes = execFileSync('unzip', ['-p', archivePath, expectedName], {
    encoding: null, timeout: 30_000, maxBuffer: maxBytes + 1,
  });
  if (bytes.length !== size || bytes.length > maxBytes) throw new TypeError('artifact archive size mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

async function downloadArtifactJson({ client, artifact, expectedName, maxBytes, root }) {
  const archivePath = path.join(root, `${artifact.id}.zip`);
  fs.writeFileSync(archivePath, await client.bytes(
    `/repos/${CALLER_REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    MAX_ARCHIVE_BYTES,
  ));
  try { return readArchiveJson(archivePath, expectedName, maxBytes); } finally {
    try { fs.unlinkSync(archivePath); } catch { /* runner temp cleanup is best effort */ }
  }
}

function parseSentinelToken(run) {
  const match = /^crawler-generation-sentinel-(.+)$/.exec(run?.display_title ?? '');
  return match && isCrawlerGenerationToken(match[1])
    && (run.name === OBSERVER_WORKFLOW_NAME || run.name === run.display_title)
    ? match[1]
    : null;
}

function assertList(response, key, cap) {
  const values = response?.[key];
  if (!Number.isInteger(response?.total_count) || !Array.isArray(values)
      || response.total_count !== values.length || values.length > cap) {
    throw new TypeError('discovery list is invalid or truncated');
  }
  return values;
}

/** GitHub adapter: lists only discovery surfaces, then binds every owner by exact-ID GET. */
export async function discoverCrawlerGenerationReconciliations({ client, now, runnerTemp }) {
  const runsResponse = await client.json(crawlerGenerationSentinelDiscoveryPath(now));
  const discoveredRuns = assertList(runsResponse, 'workflow_runs', MAX_DISCOVERY_RUNS);
  const downloads = path.join(runnerTemp, 'crawler-generation-selector-downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const byToken = new Map();
  const artifactIds = new Set();
  let artifactBytes = 0;

  for (const summary of discoveredRuns) {
    const createdAt = Date.parse(summary?.created_at ?? '');
    if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt > DISCOVERY_WINDOW_MS) continue;
    const runId = String(summary?.id ?? '');
    if (!RUN_ID_RE.test(runId)) continue;
    const run = await client.json(`/repos/${CALLER_REPOSITORY}/actions/runs/${runId}`);
    const token = parseSentinelToken(run);
    if (token === null) continue;
    const artifacts = assertList(await client.json(
      `/repos/${CALLER_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`,
    ), 'artifacts', MAX_DISCOVERY_ARTIFACTS);
    recordDiscoveredArtifactIds(artifactIds, artifacts);
    const exact = artifacts.filter((artifact) => safeArtifact(
      artifact,
      `crawler-generation-sentinel-${token}`,
    ) && String(artifact.workflow_run.id) === runId);
    if (exact.length !== 1) continue;
    artifactBytes += exact[0].size_in_bytes;
    if (artifactBytes > MAX_DISCOVERY_BYTES) throw new TypeError('discovery byte cap exceeded');
    const sentinel = await downloadArtifactJson({
      client,
      artifact: exact[0],
      expectedName: 'crawler-generation-sentinel.json',
      maxBytes: MAX_SENTINEL_BYTES,
      root: downloads,
    });
    if (!validateSentinelDocument(sentinel)
        || !validateSentinelOwnerRun(run, {
          runId,
          generationToken: token,
          corpusCodeCommit: sentinel.corpusCodeCommit,
        })) continue;
    const values = byToken.get(token) ?? [];
    values.push({ run, runId, createdAt, sentinel });
    byToken.set(token, values);
    if (byToken.size > MAX_DISCOVERY_TOKENS) throw new TypeError('discovery token cap exceeded');
  }

  const candidates = [];
  for (const [generationToken, values] of byToken) {
    values.sort((left, right) => right.createdAt - left.createdAt || Number(right.runId) - Number(left.runId));
    const current = values[0];
    const sentinelSet = createSentinelSetBinding(values.map(({ sentinel }) => sentinel));
    const dispatchMissing = GROUP_IDS.some((group) => current.sentinel.groups[group].runId === null);
    let allRunsTerminal = !dispatchMissing;
    let groupBindingInvalid = false;
    if (!dispatchMissing) {
      for (const group of GROUP_IDS) {
        let run;
        try {
          run = await client.json(
            `/repos/${CALLER_REPOSITORY}/actions/runs/${current.sentinel.groups[group].runId}`,
          );
        } catch (error) {
          if (isMissingExactGitHubResource(error)) {
            groupBindingInvalid = true;
            allRunsTerminal = false;
            continue;
          }
          throw error;
        }
        const valid = validateGroupRun(run, current.sentinel, group);
        groupBindingInvalid ||= !valid;
        allRunsTerminal &&= valid && run.status === 'completed';
      }
    }

    const reportArtifacts = assertList(await client.json(
      `/repos/${CALLER_REPOSITORY}/actions/artifacts?name=${encodeURIComponent(`crawler-generation-observer-${generationToken}`)}&per_page=100`,
    ), 'artifacts', MAX_DISCOVERY_ARTIFACTS);
    recordDiscoveredArtifactIds(artifactIds, reportArtifacts);
    const exactReports = reportArtifacts.filter((artifact) => safeArtifact(
      artifact,
      `crawler-generation-observer-${generationToken}`,
    ));
    const reportRecords = [];
    for (const artifact of exactReports) {
      artifactBytes += artifact.size_in_bytes;
      if (artifactBytes > MAX_DISCOVERY_BYTES) throw new TypeError('discovery byte cap exceeded');
      const ownerRun = await client.json(
        `/repos/${CALLER_REPOSITORY}/actions/runs/${artifact.workflow_run.id}`,
      );
      if (validateObserverReportOwnerRun(ownerRun, String(artifact.workflow_run.id), generationToken)) {
        const report = await downloadArtifactJson({
          client,
          artifact,
          expectedName: 'crawler-generation-observer-report.json',
          maxBytes: MAX_REPORT_BYTES,
          root: downloads,
        });
        reportRecords.push({ artifactId: artifact.id, ownerRun, report });
      }
    }
    const latestReport = selectLatestCrawlerGenerationObserverReport({
      generationToken,
      expected: {
        generationToken,
        siteCodeCommit: current.sentinel.siteCodeCommit,
        corpusCodeCommit: current.sentinel.corpusCodeCommit,
        sentinelDigest: current.sentinel.digest,
        ...sentinelSet,
      },
      records: reportRecords,
    });
    candidates.push({
      generationToken,
      sentinelRunId: current.runId,
      siteCodeCommit: current.sentinel.siteCodeCommit,
      corpusCodeCommit: current.sentinel.corpusCodeCommit,
      sentinelDigest: current.sentinel.digest,
      ...sentinelSet,
      sentinelCreatedAt: new Date(current.createdAt).toISOString(),
      dispatchMissing,
      groupBindingInvalid,
      allRunsTerminal,
      ...latestReport,
    });
  }
  return selectCrawlerGenerationReconciliations({ now, candidates });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--runner-temp', '--output'].includes(flag) || typeof value !== 'string' || flag in values) {
      throw new TypeError('invalid selector arguments');
    }
    values[flag] = value;
  }
  if (!values['--runner-temp'] || !values['--output']) throw new TypeError('missing selector arguments');
  return values;
}

export async function runCrawlerGenerationObserverSelectorCli(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const values = parseArguments(argv);
  const runnerTemp = fs.realpathSync(values['--runner-temp']);
  const output = path.resolve(values['--output']);
  if (output !== runnerTemp && !output.startsWith(`${runnerTemp}${path.sep}`)) {
    throw new TypeError('selector output must stay under runner temp');
  }
  if (env.GITHUB_REPOSITORY !== CALLER_REPOSITORY) throw new TypeError('selector repository mismatch');
  const client = createGitHubActionsReadClient({
    apiUrl: String(env.GITHUB_API_URL ?? '').replace(/\/$/, ''),
    token: env.GH_TOKEN,
  });
  const now = Date.parse(env.CRAWLER_GENERATION_EVALUATED_AT ?? new Date().toISOString());
  const selected = await discoverCrawlerGenerationReconciliations({ client, now, runnerTemp });
  const matrix = selected.map((item) => ({
    generation_token: item.generationToken,
    sentinel_run_id: item.sentinelRunId,
    site_code_commit: item.siteCodeCommit,
    timed_out: String(item.timedOut),
  }));
  const payload = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), matrix };
  const serialized = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(serialized) > 32 * 1024) throw new TypeError('selector output exceeds matrix cap');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized, { encoding: 'utf8', mode: 0o600 });
  return payload;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runCrawlerGenerationObserverSelectorCli().then((payload) => {
    process.stdout.write(`${JSON.stringify({ selected: payload.matrix.length })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
