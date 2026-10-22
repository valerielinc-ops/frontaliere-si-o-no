#!/usr/bin/env node

/**
 * Durable, per-SHA requests for a deploy re-arm.
 *
 * Callers outside deploy.yml may enqueue a request, but they never dispatch
 * deploy.yml. The deploy schedule/finalizer reads the status and is the only
 * consumer allowed to create the build run. A request is fulfilled by the
 * first deploy run for that SHA created after the request; that makes a lost
 * post-dispatch acknowledgement harmless and bounds the request to one build.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const DEPLOY_REARM_REQUEST_CONTEXT = 'frontaliere/deploy-rearm-request';
const SHA_RE = /^[0-9a-f]{40}$/i;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function timestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function validSha(value) {
  const sha = text(value);
  return SHA_RE.test(sha) ? sha : '';
}

function requestStatuses(statuses) {
  return (Array.isArray(statuses) ? statuses : [])
    .filter((status) => text(status?.context) === DEPLOY_REARM_REQUEST_CONTEXT)
    .sort((a, b) => timestamp(b?.created_at || b?.createdAt) - timestamp(a?.created_at || a?.createdAt));
}

/**
 * Resolve the one request for a SHA.
 *
 * @returns {{state: 'none'|'pending'|'fulfilled'|'invalid', request?: object, reason: string}}
 */
export function resolveDeployRearmRequest({ statuses = [], runs = [], headSha } = {}) {
  const sha = validSha(headSha);
  if (!sha) return { state: 'invalid', reason: 'current deploy SHA is missing or malformed' };
  const latest = requestStatuses(statuses).find((status) => text(status?.state).toLowerCase() === 'pending');
  if (!latest) return { state: 'none', reason: `no ${DEPLOY_REARM_REQUEST_CONTEXT} status for ${sha}` };

  const requestedAt = timestamp(latest?.created_at || latest?.createdAt);
  if (!requestedAt) {
    return { state: 'invalid', reason: 'deploy re-arm request has no valid creation time' };
  }
  const fulfilledRun = (Array.isArray(runs) ? runs : []).find((run) => (
    validSha(run?.headSha || run?.head_sha).toLowerCase() === sha.toLowerCase()
      && timestamp(run?.createdAt || run?.created_at) >= requestedAt
  ));
  if (fulfilledRun) {
    return {
      state: 'fulfilled',
      request: latest,
      reason: `deploy run ${text(fulfilledRun.id) || '<unknown>'} was created after the request`,
    };
  }
  return {
    state: 'pending',
    request: latest,
    reason: `canonical regression requests one bounded build for ${sha}`,
  };
}

function gh(args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  }).trim();
}

function ghJson(args) {
  const raw = gh(args);
  if (!raw) throw new Error(`empty GitHub API response for ${args.join(' ')}`);
  return JSON.parse(raw);
}

function requireRepo(repo = process.env.GITHUB_REPOSITORY) {
  const value = text(repo);
  if (!/^[^/]+\/[^/]+$/.test(value)) throw new Error('GITHUB_REPOSITORY is missing or malformed');
  return value;
}

export function readDeployRearmStatuses({ repo = process.env.GITHUB_REPOSITORY, headSha } = {}) {
  const repository = requireRepo(repo);
  const sha = validSha(headSha);
  if (!sha) throw new Error('deploy re-arm status SHA is missing or malformed');
  const pages = ghJson([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repository}/commits/${sha}/statuses?per_page=100`,
  ]);
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error('deploy re-arm status response is malformed');
  }
  return pages.flat();
}

export function readDeployRearmRuns({ repo = process.env.GITHUB_REPOSITORY, headSha } = {}) {
  const repository = requireRepo(repo);
  const sha = validSha(headSha);
  if (!sha) throw new Error('deploy re-arm run SHA is missing or malformed');
  const payload = ghJson([
    'api',
    `repos/${repository}/actions/workflows/deploy.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
  ]);
  if (!Array.isArray(payload?.workflow_runs)) throw new Error('deploy re-arm run response is malformed');
  return payload.workflow_runs.map((run) => ({
    id: run?.id,
    headSha: run?.head_sha,
    createdAt: run?.created_at,
    status: run?.status,
    conclusion: run?.conclusion,
    event: run?.event,
  }));
}

export function enqueueDeployRearmRequest({
  repo = process.env.GITHUB_REPOSITORY,
  branch = 'main',
  headSha,
  reason = 'canonical-regression',
  sourceRunId = process.env.GITHUB_RUN_ID || '',
  sourceSha = process.env.GITHUB_SHA || '',
} = {}) {
  const repository = requireRepo(repo);
  const currentSha = validSha(headSha) || validSha(
    gh(['api', `repos/${repository}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha']),
  );
  if (!currentSha) throw new Error(`could not resolve ${branch} tip for deploy re-arm request`);
  const statuses = readDeployRearmStatuses({ repo: repository, headSha: currentSha });
  const runs = readDeployRearmRuns({ repo: repository, headSha: currentSha });
  const existing = resolveDeployRearmRequest({ statuses, runs, headSha: currentSha });
  if (existing.state === 'pending' || existing.state === 'fulfilled') {
    return { enqueued: false, headSha: currentSha, state: existing.state, reason: existing.reason };
  }
  if (existing.state === 'invalid') throw new Error(existing.reason);

  const detail = [
    `reason=${text(reason).slice(0, 48) || 'unspecified'}`,
    text(sourceRunId) ? `source-run=${text(sourceRunId)}` : '',
    validSha(sourceSha) ? `source-sha=${validSha(sourceSha).slice(0, 12)}` : '',
  ].filter(Boolean).join(' ');
  gh([
    'api',
    '--method', 'POST',
    `repos/${repository}/statuses/${currentSha}`,
    '-f', 'state=pending',
    '-f', `context=${DEPLOY_REARM_REQUEST_CONTEXT}`,
    '-f', `description=${detail.slice(0, 140)}`,
    '-f', `target_url=https://github.com/${repository}/actions`,
  ]);
  return {
    enqueued: true,
    headSha: currentSha,
    state: 'pending',
    reason: detail,
  };
}

if (process.argv[1]) {
  let invoked = false;
  try {
    invoked = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch { /* c8 ignore — direct invocation path is best-effort */ }
  if (invoked) {
    try {
      const result = enqueueDeployRearmRequest({
        reason: process.argv.includes('--reason')
          ? process.argv[process.argv.indexOf('--reason') + 1]
          : 'canonical-regression',
        sourceRunId: process.argv.includes('--source-run-id')
          ? process.argv[process.argv.indexOf('--source-run-id') + 1]
          : process.env.GITHUB_RUN_ID,
        sourceSha: process.argv.includes('--source-sha')
          ? process.argv[process.argv.indexOf('--source-sha') + 1]
          : process.env.GITHUB_SHA,
      });
      console.log(`[deploy-rearm-request] ${result.enqueued ? 'enqueued' : 'already handled'} ${result.headSha}: ${result.reason}`);
    } catch (error) {
      console.error(`::error::deploy re-arm request failed: ${error?.message || error}`);
      process.exitCode = 1;
    }
  }
}
