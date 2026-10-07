import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { createdSinceQuery } from './lib/run-listing-window.mjs';

/**
 * request-latest-deploy.mjs — coalesce main pushes before the production build.
 *
 * `deploy.yml` is intentionally dispatch-only. GitHub's native concurrency
 * queue keeps one running and one pending workflow, then replaces the pending
 * member when another event arrives. That is safe for a cheap job, but it
 * makes a six-hour production build look starved when main moves every few
 * minutes. This control-plane step never builds or publishes: it only starts
 * one build for the current tip when no build is live.
 */

const LIVE_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
  'action_required',
]);

export const DEFAULT_MAX_BUILDS_PER_SHA = 2;

function skip(reason, detail = reason) {
  return { action: 'skip', reason, detail };
}

/**
 * Decide whether the dispatcher may start one build for the current main tip.
 * The cap prevents an unchanged, genuinely broken SHA from retrying forever;
 * a newer SHA gets a fresh budget and supersedes the old content by ancestry.
 */
export function decideLatestDeploy({
  headSha,
  runs,
  maxBuildsPerSha = DEFAULT_MAX_BUILDS_PER_SHA,
} = {}) {
  const head = String(headSha || '').trim();
  if (!head) return skip('no-head-sha', 'could not resolve the tip of main');

  const all = Array.isArray(runs) ? runs : [];
  const live = all.filter((run) => LIVE_STATUSES.has(String(run?.status || '')));
  if (live.length > 0) {
    return skip(
      'pipeline-moving',
      `${live.length} deploy run(s) are already queued or running; waiting for the owner of the build lock`,
    );
  }

  const forHead = all.filter((run) => String(run?.headSha || '') === head);
  if (forHead.some((run) => String(run?.conclusion || '') === 'success')) {
    return skip('head-already-built', `${head} already has a successful build`);
  }

  const cap = Number.isSafeInteger(maxBuildsPerSha) && maxBuildsPerSha > 0
    ? maxBuildsPerSha
    : DEFAULT_MAX_BUILDS_PER_SHA;
  const attempts = forHead.filter((run) => String(run?.status || '') === 'completed').length;
  if (attempts >= cap) {
    return skip(
      'attempt-cap',
      `${head} already has ${attempts} completed build attempt(s) (cap ${cap})`,
    );
  }

  return {
    action: 'dispatch',
    reason: 'pipeline-idle',
    detail: `no deploy run is live and ${head} has no successful build (${attempts} attempt(s)); dispatching one build`,
    headSha: head,
  };
}

/* c8 ignore start — the Actions shell around the pure decision core. */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ghJson(args) {
  const raw = gh(args);
  if (!raw) throw new Error(`empty GitHub response for ${args.join(' ')}`);
  return JSON.parse(raw);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.DEPLOY_BRANCH || 'main';
  const workflow = process.env.DEPLOY_WORKFLOW || 'deploy.yml';
  const maxBuildsPerSha = Number(process.env.DEPLOY_MAX_BUILDS_PER_SHA) || DEFAULT_MAX_BUILDS_PER_SHA;

  if (!repo) {
    console.warn('⚠️  GITHUB_REPOSITORY unset — not an Actions run, no deploy requested');
    return 0;
  }

  let headSha;
  let runs;
  try {
    headSha = gh(['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']);
    const rawRuns = ghJson([
      'api',
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&${createdSinceQuery(7)}&per_page=60`,
    ]);
    runs = (Array.isArray(rawRuns?.workflow_runs) ? rawRuns.workflow_runs : []).map((run) => ({
      id: run.id,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    }));
  } catch (error) {
    // A dispatcher must fail closed: an unreadable queue is not proof that the
    // build lock is free, so it must never start a competing build on a guess.
    console.warn(`⚠️  could not read the deploy queue — skipping: ${String(error?.message || error).split('\n')[0]}`);
    return 0;
  }

  const verdict = decideLatestDeploy({ headSha, runs, maxBuildsPerSha });
  console.log(`[deploy-request] head=${headSha} runs=${runs.length} → ${verdict.action} (${verdict.reason}): ${verdict.detail}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(
      summary,
      verdict.action === 'dispatch'
        ? `🚦 **Deploy request queue**: ${verdict.detail}\n`
        : `✅ **Deploy request queue**: no action — ${verdict.reason} (${verdict.detail})\n`,
    );
  }

  if (verdict.action !== 'dispatch' || process.env.DEPLOY_REQUEST_DRY_RUN === '1') return 0;

  try {
    gh(['workflow', 'run', workflow, '--repo', repo, '--ref', branch]);
    console.log(`[deploy-request] ✅ dispatched ${workflow} on ${branch} for ${headSha}`);
  } catch (error) {
    // The next push or the workflow_run completion event will retry. Do not
    // fail the control-plane run as if the production build itself failed.
    console.warn(`::warning::deploy dispatch failed: ${String(error?.message || error).split('\n')[0]}`);
  }
  return 0;
}

if (isInvokedDirectly(import.meta.url)) process.exit(main());
/* c8 ignore stop */
