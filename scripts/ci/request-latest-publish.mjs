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
 */

import fs from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';
import { createdSinceQuery } from './lib/run-listing-window.mjs';

const API = 'https://api.github.com';
const BUILD_WORKFLOW = 'deploy.yml';
const PUBLISH_WORKFLOW = 'deploy-publish.yml';
const BRANCH = 'main';
// deploy.yml's scheduled run is only a queue reconciler: it deliberately
// skips the build graph and therefore never owns a Pages artifact. Only the
// direct build triggers can be handed to deploy-publish.yml.
const BUILD_EVENTS = new Set(['push', 'workflow_dispatch']);
const RUN_LISTING_WINDOW_DAYS = 35;
const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'action_required']);
const ACTIVE_DEPLOYMENT_STATES = new Set(['queued', 'pending', 'in_progress', 'waiting']);
export const DEFAULT_MAX_PUBLISH_ATTEMPTS = 3;

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
  const match = text(run?.runName || run?.run_name).match(PUBLISH_RUN_NAME_RE);
  return match ? match[1] : '';
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
  const attempts = (Array.isArray(publishRuns) ? publishRuns : [])
    .filter((run) => publishRunBelongsTo(run, candidate))
    .length;
  const cap = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_PUBLISH_ATTEMPTS;
  if (attempts >= cap) {
    return skip('attempt-cap', `build ${candidate.id} already has ${attempts} publish attempt(s), including live runs (cap ${cap})`);
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

async function main() {
  const repo = repository();
  const [rawBuilds, rawPublishes] = await Promise.all([
    listWorkflowRuns(repo, BUILD_WORKFLOW),
    listWorkflowRuns(repo, PUBLISH_WORKFLOW),
  ]);
  const builds = rawBuilds.map(mapBuild);
  const publishRuns = rawPublishes.map(mapPublish);
  const deploymentState = await inspectDeployments(repo, publishRuns);
  const verdict = decideLatestPublish({
    builds,
    publishRuns,
    ...deploymentState,
  });
  console.log(`[publish-request] ${verdict.action} (${verdict.reason}): ${verdict.detail}`);
  appendSummary(verdict.action === 'dispatch'
    ? `🚦 **Pages publish queue**: ${verdict.detail}`
    : `✅ **Pages publish queue**: no action — ${verdict.reason} (${verdict.detail})`);
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
