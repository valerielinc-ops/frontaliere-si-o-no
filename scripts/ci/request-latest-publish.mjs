#!/usr/bin/env node

/**
 * Reconcile the build -> Pages publish handoff.
 *
 * GitHub Actions concurrency groups are not FIFO queues: a group keeps one
 * running and one pending run, and a newer arrival replaces the pending one.
 * That behaviour is useful for the build request (the newest main tip is the
 * only candidate worth building), but it is unsafe as the sole handoff for a
 * completed build. This coordinator admits one publish workflow at a time and
 * re-checks the latest successful build on every scheduled/request tick.
 *
 * A failed publish is not retried blindly. The failure of the last attempt is
 * classified with the same classifier the build re-arm uses:
 *   - `infra`  -> one immediate retry per signature;
 *   - `deterministic` / `unknown` -> retry only when the publisher toolchain
 *     changed since that attempt, and only after a 15 -> 30 -> 60 min backoff;
 *   - the cap, two equal deterministic failures, a publisher that declared the
 *     source unpublishable (rebuild required) or an unchanged toolchain after
 *     the backoff -> escalate: request one build of the current main tip (a
 *     durable per-SHA status, never a dispatch of deploy.yml) and keep one
 *     `Deploy publish blocked:` issue per failure key. Never a silent stall.
 */

import fs from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';
import { createdSinceQuery } from './lib/run-listing-window.mjs';
import { classifyDeployFailure } from './deploy-failure-classifier.mjs';
import { enqueueDeployRearmRequest } from './deploy-rearm-request.mjs';
import { readFailedJobAnnotations, readRunJobs } from './lib/deploy-run-evidence.mjs';
import {
  PUBLISH_BLOCKED_ISSUE_PREFIX,
  resolveBlockedIssues,
  upsertBlockedIssue,
} from './lib/deploy-blocked-issue.mjs';

const API = 'https://api.github.com';
const BUILD_WORKFLOW = 'deploy.yml';
const PUBLISH_WORKFLOW = 'deploy-publish.yml';
const BRANCH = 'main';
// deploy.yml's scheduled run is only a queue reconciler: it deliberately
// skips the build graph and therefore never owns a Pages artifact. Direct
// workflow_dispatch and push builds remain valid source events.
const BUILD_EVENTS = new Set(['workflow_dispatch', 'push']);
const RUN_LISTING_WINDOW_DAYS = 35;
const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'action_required']);
const ACTIVE_DEPLOYMENT_STATES = new Set(['queued', 'pending', 'in_progress', 'waiting']);
export const DEFAULT_MAX_PUBLISH_ATTEMPTS = 3;
const PUBLISH_ISSUE_FLAG = 'PUBLISH_ISSUE_UPDATE';
const PUBLISH_WORKFLOW_NAME = 'Publish to GitHub Pages (deploy + validate)';

/** Minutes to wait after the last failed attempt, by number of failed attempts (15 -> 30 -> 60). */
export const PUBLISH_BACKOFF_MINUTES = Object.freeze([15, 30, 60]);

/**
 * Paths that make up the publisher toolchain. A publish is pinned to the SHA it
 * was dispatched from, so a retry can only behave differently when one of them
 * changed between that SHA and the current main tip.
 */
export const PUBLISH_TOOLCHAIN_PATH_RES = Object.freeze([
  /^\.github\/workflows\/deploy-publish\.ya?ml$/,
  /^\.github\/workflows\/post-deploy-[^/]*\.ya?ml$/,
  /^scripts\/ci\//,
  /^scripts\/lib\//,
]);

/**
 * The only place the publisher makes `contract-mismatch` (and its siblings, the
 * legacy source contract and missing fast-gate receipts) visible is this job:
 * `resolve-publish-plan` blocks, then it enqueues one current build request.
 * The verdict is terminal ("rebuild, never retry"), so a publish attempt whose
 * job list contains this job that ran is never retried.
 */
export const PUBLISH_REBUILD_REQUIRED_JOB_RE = /recover legacy publish contract/i;
const FILES_PER_PAGE = 100;
const COMPARE_MAX_FILES = 300;
const COMPARE_MAX_PAGES = COMPARE_MAX_FILES / FILES_PER_PAGE;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function timestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function skip(reason, detail = reason) {
  return { action: 'skip', reason, detail };
}

const SOURCE_SHA_RE = /^[0-9a-f]{40}$/i;
const PUBLISH_RUN_NAME_RE = /^Publish Pages build\s+\d+\s+@\s+([0-9a-f]{40})$/i;

function validSha(value) {
  const sha = text(value);
  return SOURCE_SHA_RE.test(sha) ? sha : '';
}

function sourceShaFromPublishRun(run) {
  const explicitSourceSha = validSha(run?.sourceSha || run?.source_sha);
  if (explicitSourceSha) return explicitSourceSha;
  const titleShas = new Set();
  for (const title of [run?.runName, run?.run_name, run?.displayTitle, run?.display_title]) {
    const match = text(title).match(PUBLISH_RUN_NAME_RE);
    if (match) titleShas.add(match[1].toLowerCase());
  }
  return titleShas.size === 1 ? [...titleShas][0] : '';
}

function deploymentHeadSha(deployment) {
  return text(deployment?.headSha || deployment?.head_sha || deployment?.sha);
}

function deploymentPayload(deployment) {
  if (deployment?.payload && typeof deployment.payload === 'object') return deployment.payload;
  if (typeof deployment?.payload !== 'string') return {};
  try {
    const parsed = JSON.parse(deployment.payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function deploymentSourceSha(deployment, latestStatus, publishRuns = []) {
  const payload = deploymentPayload(deployment);
  const explicitSourceSha = validSha(
    payload.sourceSha
      || payload.source_sha
      || deployment?.sourceSha
      || deployment?.source_sha,
  );
  if (explicitSourceSha) return explicitSourceSha;

  const runId = [
    latestStatus?.targetUrl,
    latestStatus?.target_url,
    latestStatus?.logUrl,
    latestStatus?.log_url,
  ]
    .map((url) => text(url).match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] || '')
    .find(Boolean);
  if (!runId) return '';
  return sourceShaFromPublishRun(
    (Array.isArray(publishRuns) ? publishRuns : []).find((run) => String(run?.id) === runId),
  );
}

function successfulDeploymentSourceSha({ deployment, publishRuns }) {
  const explicitSourceSha = deploymentSourceSha(deployment);
  if (explicitSourceSha) return explicitSourceSha;

  const deploymentSha = deploymentHeadSha(deployment).toLowerCase();
  if (!deploymentSha) return '';
  const matchingSourceShas = new Set(
    (Array.isArray(publishRuns) ? publishRuns : [])
      .filter((run) => text(run?.headSha || run?.head_sha).toLowerCase() === deploymentSha)
      .map(sourceShaFromPublishRun)
      .filter(Boolean)
      .map((sha) => sha.toLowerCase()),
  );
  return matchingSourceShas.size === 1 ? [...matchingSourceShas][0] : '';
}

function successfulBuilds(builds) {
  return (Array.isArray(builds) ? builds : [])
    .filter((run) => (
      text(run?.status) === 'completed'
      && text(run?.conclusion) === 'success'
      && text(run?.headBranch || run?.head_branch) === BRANCH
      && text(run?.headSha || run?.head_sha)
      && text(run?.event)
      && BUILD_EVENTS.has(text(run?.event))
      && numericId(run?.workflowId || run?.workflow_id)
      && numericId(run?.id)
    ))
    .sort((a, b) => (
      timestamp(b?.completedAt || b?.completed_at) - timestamp(a?.completedAt || a?.completed_at)
      || numericId(b?.id) - numericId(a?.id)
    ));
}

function sourceRunIdFromTitle(run) {
  const buildIdFromTitle = (title) => {
    const match = text(title).match(/\bbuild\s+(?:#\s*)?(\d+)\b/i);
    return match ? Number(match[1]) : null;
  };
  const displayTitleId = buildIdFromTitle(run?.displayTitle ?? run?.display_title);
  if (displayTitleId !== null) return displayTitleId;
  return buildIdFromTitle(run?.runName ?? run?.run_name);
}

function publishRunBelongsTo(run, candidate) {
  const candidateId = numericId(candidate?.id);
  if (!candidateId) return false;
  if (numericId(run?.sourceRunId || run?.source_run_id) === candidateId) return true;
  if (sourceRunIdFromTitle(run) === candidateId) return true;
  // This fallback covers only the old workflow_run-shaped records while the
  // dispatch-only contract rolls out. Dispatch runs are identified by their
  // explicit run-name above, not by the ref SHA (which is main's current tip).
  return text(run?.event) === 'workflow_run'
    && text(run?.headSha || run?.head_sha) === text(candidate?.headSha || candidate?.head_sha);
}

/** The publish attempts that belong to one build candidate (live ones included). */
export function candidateAttempts(publishRuns, candidate) {
  return (Array.isArray(publishRuns) ? publishRuns : []).filter((run) => publishRunBelongsTo(run, candidate));
}

/** Newest successful main build, i.e. the artifact the coordinator wants live. */
export function latestBuildCandidate(builds) {
  return successfulBuilds(builds)[0] || null;
}

/** First changed path that belongs to the publisher toolchain, or null. */
export function publishToolchainPathHit(files) {
  const list = (Array.isArray(files) ? files : []).map(text).filter(Boolean);
  return list.find((file) => PUBLISH_TOOLCHAIN_PATH_RES.some((re) => re.test(file))) || null;
}

/** Backoff after `failedCount` failed attempts: 15 -> 30 -> 60 min, then 60. */
export function publishBackoffMs(failedCount) {
  const n = Number.isSafeInteger(failedCount) && failedCount > 0 ? failedCount : 1;
  return PUBLISH_BACKOFF_MINUTES[Math.min(n, PUBLISH_BACKOFF_MINUTES.length) - 1] * 60_000;
}

/**
 * Turn one finished publish attempt into the record the policy reads.
 * Pure and total: whatever it cannot read degrades to `unknown`.
 *
 * @param {object} input
 * @param {{id, headSha, conclusion, completedAt}} input.run  the mapped publish run
 * @param {Array} [input.jobs]
 * @param {Record<string, Array>} [input.annotationsByJob]
 * @returns {object|null} `null` for a green attempt that left no rebuild-required evidence
 */
export function classifyPublishAttempt({ run, jobs = [], annotationsByJob = {} } = {}) {
  const conclusion = text(run?.conclusion);
  const list = Array.isArray(jobs) ? jobs : [];
  const rebuildRequired = list.some((job) => (
    PUBLISH_REBUILD_REQUIRED_JOB_RE.test(text(job?.name))
    && text(job?.status) === 'completed'
    && text(job?.conclusion) === 'success'
  ));
  if (conclusion === 'success' && !rebuildRequired) return null;
  const base = {
    id: numericId(run?.id),
    conclusion,
    completedAt: text(run?.completedAt),
    toolchainSha: validSha(run?.headSha || run?.head_sha),
    rebuildRequired,
  };
  if (rebuildRequired) {
    return {
      ...base,
      classification: 'deterministic',
      signature: 'publish::rebuild-required::source build cannot be published by this toolchain',
      job: 'publish',
      step: 'rebuild-required (contract-mismatch family)',
      firstError: 'the publisher blocked the source build and requested a current build (contract-mismatch, legacy contract or missing fast-gate receipts)',
    };
  }
  const classified = classifyDeployFailure({ jobs: list, annotationsByJob });
  if (classified.signature === 'no-failed-job' && ['cancelled', 'timed_out', 'skipped'].includes(conclusion)) {
    // Ended by the platform or by supersession, with no failed job to blame.
    return { ...base, classification: 'infra', signature: `publish::run-${conclusion}`, job: 'publish', step: `run ${conclusion}`, firstError: `the publish run ended ${conclusion} without a failed job` };
  }
  return { ...base, ...classified };
}

/**
 * What the retry policy would do with the attempts seen so far. Shared by the
 * decision and by the I/O shell, which only pays for the toolchain compare
 * when the policy needs it.
 *
 * @returns {'rebuild-required'|'immediate'|'same-deterministic'|'gated'|null}
 */
export function publishRetryPlan({ lastAttempt, failedAttempts } = {}) {
  if (!lastAttempt) return null;
  if (lastAttempt.rebuildRequired) return 'rebuild-required';
  const history = Array.isArray(failedAttempts) && failedAttempts.length > 0 ? failedAttempts : [lastAttempt];
  const sameSignature = history.filter((attempt) => attempt.signature === lastAttempt.signature).length;
  if (lastAttempt.classification === 'infra' && sameSignature <= 1) return 'immediate';
  if (lastAttempt.classification === 'deterministic' && sameSignature >= 2) return 'same-deterministic';
  return 'gated';
}

/**
 * Read the publisher-toolchain change between the attempt's SHA and the main
 * tip from compare pages. Unreadable or possibly truncated (300 files, no hit
 * seen) means `unreadable`: the policy then does not retry.
 *
 * @param {object} input
 * @param {string} input.baseSha
 * @param {string} input.headSha
 * @param {(page: number) => Promise<{files?: Array}>} input.fetchPage  one compare page
 */
export async function readToolchainChange({ baseSha, headSha, fetchPage }) {
  const base = validSha(baseSha);
  const head = validSha(headSha);
  if (!base || !head) return { state: 'unreadable', detail: 'the attempt or main SHA is missing or malformed' };
  if (base.toLowerCase() === head.toLowerCase()) return { state: 'unchanged', detail: 'the attempt already ran from the main tip' };
  try {
    for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
      const payload = await fetchPage(page);
      if (!Array.isArray(payload?.files)) throw new Error('compare response has no file list');
      const hit = publishToolchainPathHit(payload.files.map((file) => file?.filename));
      if (hit) return { state: 'changed', path: hit, detail: `changed: ${hit}` };
      if (payload.files.length < FILES_PER_PAGE) {
        return { state: 'unchanged', detail: 'no publisher toolchain path changed' };
      }
      if (payload.files.length >= COMPARE_MAX_FILES) break;
    }
    return { state: 'unreadable', detail: `compare file list may be truncated at ${COMPARE_MAX_FILES} files` };
  } catch (error) {
    return { state: 'unreadable', detail: `compare unreadable: ${String(error?.message || error).split('\n')[0]}` };
  }
}

function shortSignature(attempt) {
  return text(attempt?.signature).slice(0, 120) || 'unknown';
}

function failureLabel(attempt) {
  return `${attempt.classification} failure "${shortSignature(attempt)}"`;
}

/**
 * Escalate instead of stalling: ask for one build of the main tip, unless the
 * tip IS the candidate (a rebuild would make the same artifact), in which case
 * only the issue is updated.
 */
function escalate({ candidate, last, mainHeadSha, why, attempts }) {
  const candidateSha = text(candidate.headSha || candidate.head_sha);
  const requestRebuild = mainHeadSha.toLowerCase() !== candidateSha.toLowerCase();
  const failure = {
    classification: last.classification,
    signature: last.signature,
    job: last.job,
    step: last.step,
    firstError: last.firstError,
    attempts,
  };
  return {
    action: 'escalate',
    reason: requestRebuild ? 'escalate-rebuild' : 'escalate-blocked',
    requestRebuild,
    mainHeadSha,
    candidate,
    failure,
    detail: requestRebuild
      ? `${why}: ${failureLabel(last)} on build ${candidate.id}; requesting one build of main ${mainHeadSha}`
      : `${why}: ${failureLabel(last)} on build ${candidate.id}; main ${mainHeadSha} is the build already published, so a rebuild would repeat it (issue updated, no rearm request)`,
  };
}

function decideRetryGate({ candidate, attempts, lastAttempt, failedAttempts, toolchainChange, mainHeadSha, nowMs }) {
  const last = lastAttempt;
  const plan = publishRetryPlan({ lastAttempt, failedAttempts });
  const escalation = (why) => escalate({ candidate, last, mainHeadSha, why, attempts });
  if (plan === 'rebuild-required') return escalation('the publisher declared this source unpublishable (rebuild required, never retry)');
  if (plan === 'immediate') return null;
  if (plan === 'same-deterministic') return escalation('the same deterministic publish failure repeated');

  const history = Array.isArray(failedAttempts) && failedAttempts.length > 0 ? failedAttempts : [last];
  const waitMs = publishBackoffMs(history.length);
  const completedMs = timestamp(last.completedAt);
  const nextAtMs = completedMs ? completedMs + waitMs : 0;
  const nextAt = nextAtMs ? new Date(nextAtMs).toISOString() : 'now';
  const elapsed = nowMs >= nextAtMs;
  const state = text(toolchainChange?.state) || 'unreadable';
  const label = failureLabel(last);
  if (state === 'unreadable') {
    return skip('publish-toolchain-unreadable', `${label}; publisher toolchain change is unreadable (${text(toolchainChange?.detail) || 'no compare'}), not retrying`);
  }
  if (state === 'changed') {
    return elapsed
      ? null
      : skip('publish-backoff', `${label}; toolchain changed (${text(toolchainChange?.path)}) but backoff runs until ${nextAt} (${history.length} failed attempt(s))`);
  }
  return elapsed
    ? escalation('the publisher toolchain did not change and the backoff elapsed')
    : skip('publish-deterministic-unchanged', `${label}; publisher toolchain unchanged, next window ${nextAt} (then a rebuild of main is requested)`);
}

/**
 * Decide whether the coordinator should admit one Pages publish.
 *
 * `lastSuccessfulDeployment` is intentionally required to be known by the
 * caller. An unreadable Deployments API must not turn into a blind publish or
 * a false "already live" verdict.
 */
export function decideLatestPublish({
  builds,
  publishRuns,
  lastSuccessfulDeployment,
  activeDeployment = null,
  successfulDeploymentShas = [],
  maxAttempts = DEFAULT_MAX_PUBLISH_ATTEMPTS,
  // Retry policy inputs. Without `lastAttempt` and a valid `mainHeadSha` the
  // function keeps the plain bounded-retry behaviour (fail-safe).
  lastAttempt = null,
  failedAttempts = [],
  toolchainChange = null,
  mainHeadSha = '',
  nowMs = Date.now(),
} = {}) {
  const candidate = successfulBuilds(builds)[0];
  if (!candidate) return skip('no-successful-build', 'no successful main build is available to publish');

  const candidateSha = text(candidate.headSha || candidate.head_sha);
  const publishedDeploymentSha = deploymentHeadSha(lastSuccessfulDeployment);
  const publishedSourceSha = successfulDeploymentSourceSha({
    deployment: lastSuccessfulDeployment,
    publishRuns,
  });
  const publishedArtifactSha = publishedSourceSha || publishedDeploymentSha;
  if (publishedArtifactSha.toLowerCase() === candidateSha.toLowerCase()) {
    return skip('already-live', `${candidateSha} is the latest successful Pages deployment revision`);
  }

  // A receipt belongs to one historical source run; it is not proof that the
  // same source is still the current Pages deployment after a rollback. The
  // live deployment identity must be resolved first. If it is unknown or
  // points at another revision, keep the candidate publishable.

  // deploy-publish.yml deliberately keeps its long validate-dist and
  // post-deploy tails independent from the `pages-deploy` concurrency lock.
  // A workflow run can therefore remain in_progress after its Pages upload
  // has succeeded. The deployment API records the dispatch ref (`head_sha`),
  // while `source_sha` identifies the older build artifact and may differ.
  // Treat only an active run whose own ref has not been published as a blocker;
  // an unreadable ref remains fail-closed.
  const deployedRevisions = new Set(
    [
      ...(Array.isArray(successfulDeploymentShas) ? successfulDeploymentShas : []),
      publishedDeploymentSha,
    ]
      .map((sha) => text(sha).toLowerCase())
      .filter(Boolean),
  );
  // Count completed AND live attempts. A queued/in-progress retry consumes a
  // slot immediately; otherwise two concurrent reconciler ticks can each see
  // one completed attempt and both admit another publish.
  const candidateRuns = candidateAttempts(publishRuns, candidate);
  const attempts = candidateRuns.length;
  const hasLiveAttempt = candidateRuns.some((run) => LIVE_STATUSES.has(text(run?.status)));
  const cap = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_PUBLISH_ATTEMPTS;
  const tip = validSha(mainHeadSha);
  const retryContext = lastAttempt && tip ? { last: lastAttempt, tip } : null;
  if (attempts >= cap) {
    // A live attempt may still succeed; with no context the cap stays a plain
    // stop. Otherwise the cap escalates to a rebuild instead of stalling.
    if (hasLiveAttempt || !retryContext) {
      return skip('attempt-cap', `build ${candidate.id} already has ${attempts} publish attempt(s), including live runs (cap ${cap})`);
    }
    return escalate({
      candidate,
      last: retryContext.last,
      mainHeadSha: retryContext.tip,
      why: `attempt cap reached (${attempts}/${cap})`,
      attempts,
    });
  }

  const activeRun = (Array.isArray(publishRuns) ? publishRuns : []).find((run) => {
    if (!LIVE_STATUSES.has(text(run?.status))) return false;
    const runRevision = text(run?.headSha || run?.head_sha).toLowerCase();
    return !runRevision || !deployedRevisions.has(runRevision);
  });
  if (activeRun) {
    return skip('publish-moving', `publish run ${text(activeRun.id) || '<unknown>'} is ${text(activeRun.status)}`);
  }

  if (activeDeployment) {
    return skip('pages-moving', `Pages deployment ${text(activeDeployment.id) || '<unknown>'} is ${text(activeDeployment.state)}`);
  }

  if (attempts && retryContext) {
    const gate = decideRetryGate({
      candidate,
      attempts,
      lastAttempt: retryContext.last,
      failedAttempts,
      toolchainChange,
      mainHeadSha: retryContext.tip,
      nowMs,
    });
    if (gate) return gate;
  }

  return {
    action: 'dispatch',
    reason: attempts ? 'retry-publish' : 'publish-latest-build',
    detail: `dispatching Pages publish for successful build ${candidate.id} (${candidateSha})`,
    candidate,
  };
}

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const response = await fetch(`${API}${urlPath}`, {
    headers: githubApiHeaders(authToken()),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${response.status}`);
  return response.json();
}

async function ghPost(urlPath, body) {
  const response = await fetch(`${API}${urlPath}`, {
    method: 'POST',
    headers: githubApiHeaders(authToken(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${response.status}`);
}

function repository() {
  const repo = text(process.env.GITHUB_REPOSITORY);
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or malformed');
  return repo;
}

function mapBuild(run) {
  return {
    id: numericId(run?.id),
    workflowId: numericId(run?.workflow_id),
    headSha: text(run?.head_sha),
    headBranch: text(run?.head_branch),
    status: text(run?.status),
    conclusion: text(run?.conclusion),
    event: text(run?.event),
    completedAt: text(run?.completed_at),
  };
}

function mapPublish(run) {
  return {
    id: numericId(run?.id),
    headSha: text(run?.head_sha),
    sourceSha: sourceShaFromPublishRun(run),
    status: text(run?.status),
    conclusion: text(run?.conclusion),
    event: text(run?.event),
    displayTitle: text(run?.display_title),
    runName: text(run?.run_name),
    // A workflow run has no `completed_at`; `updated_at` is its end once completed.
    completedAt: text(run?.updated_at),
  };
}

async function listWorkflowRuns(repo, workflow) {
  const payload = await ghJson(
    `/repos/${repo}/actions/workflows/${workflow}/runs?branch=${BRANCH}&${createdSinceQuery(RUN_LISTING_WINDOW_DAYS)}&per_page=100`,
  );
  if (!Array.isArray(payload?.workflow_runs)) throw new Error(`${workflow} run listing is malformed`);
  return payload.workflow_runs;
}

async function inspectDeployments(repo, publishRuns = []) {
  const deployments = await ghJson(`/repos/${repo}/deployments?environment=github-pages&per_page=100`);
  if (!Array.isArray(deployments)) throw new Error('Pages deployment listing is malformed');
  let lastSuccessfulDeployment = null;
  let activeDeployment = null;
  const successfulDeploymentShas = new Set();
  for (const deployment of deployments) {
    const id = numericId(deployment?.id);
    if (!id) continue;
    const statuses = await ghJson(`/repos/${repo}/deployments/${id}/statuses?per_page=5`);
    if (!Array.isArray(statuses) || statuses.length === 0) continue;
    const latest = statuses[0];
    const state = text(latest?.state);
    if (!activeDeployment && ACTIVE_DEPLOYMENT_STATES.has(state)) {
      activeDeployment = { id, state };
    }
    if (!lastSuccessfulDeployment && state === 'success') {
      const deploymentSha = text(deployment?.sha);
      if (deploymentSha) successfulDeploymentShas.add(deploymentSha);
      lastSuccessfulDeployment = {
        id,
        sha: deploymentSha,
        sourceSha: deploymentSourceSha(deployment, latest, publishRuns),
        publishedAt: text(latest?.created_at),
      };
    } else if (state === 'success') {
      const deploymentSha = text(deployment?.sha);
      if (deploymentSha) successfulDeploymentShas.add(deploymentSha);
    }
  }
  return {
    lastSuccessfulDeployment,
    activeDeployment,
    successfulDeploymentShas: [...successfulDeploymentShas],
  };
}

function appendSummary(message) {
  const file = text(process.env.GITHUB_STEP_SUMMARY);
  if (file) fs.appendFileSync(file, `${message}\n`);
}

async function dispatchPublish(repo, candidate) {
  const sourceRunId = String(candidate.id);
  const sourceSha = text(candidate.headSha);
  await ghPost(`/repos/${repo}/actions/workflows/${PUBLISH_WORKFLOW}/dispatches`, {
    ref: BRANCH,
    inputs: {
      source_run_id: sourceRunId,
      source_sha: sourceSha,
      source_conclusion: 'success',
      source_branch: BRANCH,
      source_event_name: text(candidate.event) || 'workflow_dispatch',
      source_workflow: 'Deploy to GitHub Pages',
      source_workflow_path: '.github/workflows/deploy.yml',
      source_workflow_id: String(candidate.workflowId || ''),
    },
  });
}

function runUrl(repo) {
  const server = text(process.env.GITHUB_SERVER_URL);
  const id = text(process.env.GITHUB_RUN_ID);
  return server && id ? `${server}/${repo}/actions/runs/${id}` : '';
}

/**
 * Evidence for the retry policy: the finished attempts of the candidate (at
 * most the cap: one jobs read and one annotation read per failed job each),
 * the main tip and, only when the policy needs it, one compare. Every read
 * problem degrades to `unknown` / `unreadable`; nothing here may fail the run.
 */
async function gatherRetryEvidence({ repo, candidate, publishRuns }) {
  const finished = candidateAttempts(publishRuns, candidate)
    .filter((run) => text(run.status) === 'completed')
    .sort((a, b) => timestamp(b.completedAt) - timestamp(a.completedAt) || numericId(b.id) - numericId(a.id));
  const failedAttempts = [];
  for (const run of finished) {
    let jobs = [];
    let annotationsByJob = {};
    try {
      jobs = readRunJobs(repo, run.id);
      annotationsByJob = readFailedJobAnnotations(jobs);
    } catch (error) {
      console.warn(`::warning::could not read publish run ${run.id} (${String(error?.message || error).split('\n')[0]}); classified unknown`);
    }
    const attempt = classifyPublishAttempt({ run, jobs, annotationsByJob });
    if (attempt) failedAttempts.push(attempt);
  }
  const lastAttempt = failedAttempts[0] || null;
  let mainHeadSha = '';
  try {
    const tip = await ghJson(`/repos/${repo}/commits/${BRANCH}`);
    mainHeadSha = validSha(tip?.sha);
  } catch (error) {
    console.warn(`::warning::could not read the ${BRANCH} tip (${String(error?.message || error).split('\n')[0]}); publish retry policy not applied`);
  }
  let toolchainChange = null;
  if (lastAttempt && mainHeadSha && publishRetryPlan({ lastAttempt, failedAttempts }) === 'gated') {
    toolchainChange = await readToolchainChange({
      baseSha: lastAttempt.toolchainSha,
      headSha: mainHeadSha,
      fetchPage: (page) => ghJson(
        `/repos/${repo}/compare/${lastAttempt.toolchainSha}...${mainHeadSha}?per_page=${FILES_PER_PAGE}&page=${page}`,
      ),
    });
  }
  return { lastAttempt, failedAttempts, toolchainChange, mainHeadSha };
}

/**
 * Run `fn` with the job's GITHUB_TOKEN. The App token that reads and
 * dispatches is least-privilege (`statuses: read`, no issues); the two
 * escalation writes (commit status, issue) use the token the job grants
 * `statuses: write` and `issues: write`. Without it nothing is written.
 */
function withEscalationToken(fn) {
  const token = text(process.env.ESCALATION_TOKEN);
  if (!token) throw new Error('ESCALATION_TOKEN is not set');
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
}

function escalationIssueBody({ repo, verdict }) {
  const { failure, candidate } = verdict;
  const url = runUrl(repo);
  return [
    `The Pages publish of build ${candidate.id} (${text(candidate.headSha)}) is not being retried (${verdict.reason}).`,
    '',
    `- classification: ${failure.classification}`,
    `- failed publish attempts of this build: ${failure.attempts}`,
    `- signature: \`${text(failure.signature).slice(0, 300)}\``,
    `- first error: ${text(failure.firstError || '(none)').slice(0, 300)}`,
    `- decision: ${verdict.detail}`,
    url ? `- observed from: ${url}` : '',
    '',
    'The reconciler retries by itself when the publisher toolchain changes and the backoff (15, 30, 60 min) elapsed, requests one build of the main tip per SHA, and closes this issue when Pages publishes the candidate build.',
  ].filter((line) => line !== '').join('\n');
}

async function applyEscalation(repo, verdict) {
  try {
    withEscalationToken(() => {
      if (verdict.requestRebuild) {
        const result = enqueueDeployRearmRequest({
          repo,
          branch: BRANCH,
          headSha: verdict.mainHeadSha,
          reason: `publish-${verdict.failure.classification}`,
          sourceRunId: text(process.env.GITHUB_RUN_ID),
          sourceSha: text(verdict.candidate.headSha),
        });
        console.log(`[publish-request] rebuild request ${result.enqueued ? 'enqueued' : 'already handled'} for ${result.headSha}: ${result.reason}`);
      }
      upsertBlockedIssue({
        prefix: PUBLISH_BLOCKED_ISSUE_PREFIX,
        flag: PUBLISH_ISSUE_FLAG,
        workflowName: PUBLISH_WORKFLOW_NAME,
        failure: verdict.failure,
        body: escalationIssueBody({ repo, verdict }),
        runUrl: runUrl(repo),
        // One write per failure key: the reconciler ticks every 10 minutes.
        createOnly: true,
      });
    });
  } catch (error) {
    // Visibility and the rebuild request must never fail the reconciler.
    console.warn(`::warning::publish escalation could not be written: ${String(error?.message || error).split('\n')[0]}`);
  }
}

async function main() {
  const repo = repository();
  const [rawBuilds, rawPublishes] = await Promise.all([
    listWorkflowRuns(repo, BUILD_WORKFLOW),
    listWorkflowRuns(repo, PUBLISH_WORKFLOW),
  ]);
  const builds = rawBuilds.map(mapBuild);
  const publishRuns = rawPublishes.map(mapPublish);
  const deploymentState = await inspectDeployments(repo, publishRuns);
  const base = { builds, publishRuns, ...deploymentState };
  let verdict = decideLatestPublish(base);
  const candidate = latestBuildCandidate(builds);
  // Only a retry or the cap needs the failure evidence; a live attempt that
  // already holds the cap stays a plain stop.
  const needsEvidence = candidate
    && (verdict.reason === 'retry-publish' || verdict.reason === 'attempt-cap')
    && !candidateAttempts(publishRuns, candidate).some((run) => LIVE_STATUSES.has(text(run.status)));
  if (needsEvidence) {
    const evidence = await gatherRetryEvidence({ repo, candidate, publishRuns });
    verdict = decideLatestPublish({ ...base, ...evidence, nowMs: Date.now() });
  }
  console.log(`[publish-request] ${verdict.action} (${verdict.reason}): ${verdict.detail}`);
  appendSummary(verdict.action === 'dispatch'
    ? `🚦 **Pages publish queue**: ${verdict.detail}`
    : verdict.action === 'escalate'
      ? `🛑 **Pages publish queue escalated** (${verdict.reason}): ${verdict.detail}`
      : `✅ **Pages publish queue**: no action — ${verdict.reason} (${verdict.detail})`);
  if (verdict.action === 'escalate') {
    await applyEscalation(repo, verdict);
    return 0;
  }
  if (verdict.reason === 'already-live' && candidate && candidateAttempts(publishRuns, candidate).length > 0) {
    // The candidate is live: any open publish-blocked issue is stale. Guarded
    // by PUBLISH_ISSUE_UPDATE and by the job token; never throws.
    try {
      withEscalationToken(() => resolveBlockedIssues({
        prefix: PUBLISH_BLOCKED_ISSUE_PREFIX,
        flag: PUBLISH_ISSUE_FLAG,
        workflowName: PUBLISH_WORKFLOW_NAME,
        runUrl: runUrl(repo),
      }));
    } catch (error) {
      console.warn(`::warning::could not resolve publish-blocked issues: ${String(error?.message || error).split('\n')[0]}`);
    }
  }
  if (verdict.action !== 'dispatch') return 0;
  await dispatchPublish(repo, verdict.candidate);
  console.log(`[publish-request] dispatched ${PUBLISH_WORKFLOW} for build ${verdict.candidate.id}`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Pages publish reconciliation failed: ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
