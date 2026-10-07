import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { filterUnignored, parsePathsIgnore } from '../check-pages-publish-lag.mjs';
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
export const MAX_DURABLE_RETRY_ATTEMPTS = 3;

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

/**
 * A workflow_run event does not carry the changed paths that GitHub used for
 * the original push filter. Compare the completed build's SHA with the
 * current tip and apply the same denylist before re-arming. Keeping this pure
 * makes the important data-only no-op contract executable without GitHub.
 */
export function changedFilesRequiringDeploy(changedFiles, pathsIgnore) {
  return filterUnignored(
    Array.isArray(changedFiles) ? changedFiles : [],
    Array.isArray(pathsIgnore) ? pathsIgnore : [],
  );
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

function appendSummary(text) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${text}\n`);
}

function retryAttempt() {
  const value = Number.parseInt(process.env.DEPLOY_RETRY_ATTEMPT || '0', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Put a recovery request back into Actions' durable queue. A later push is
 * not a recovery strategy: the event that exposed the outage may be the only
 * event for that SHA. The bounded attempt number prevents a persistent API
 * outage from creating an unbounded self-dispatch storm; the schedule is the
 * long-lived reconciler after the bound.
 */
function queueDurableRetry({ repo, workflow, branch, headSha, reason }) {
  const head = String(headSha || '').trim();
  const attempt = retryAttempt();
  if (!head) {
    console.warn(`::error::cannot queue durable deploy retry for ${reason}: current head is unknown`);
    return false;
  }
  if (attempt >= MAX_DURABLE_RETRY_ATTEMPTS) {
    console.warn(
      `::warning::durable deploy retry cap reached for ${head} (${attempt}/${MAX_DURABLE_RETRY_ATTEMPTS}); `
        + 'the scheduled reconciler will retry without consuming another self-dispatch attempt',
    );
    return false;
  }
  try {
    gh([
      'workflow', 'run', workflow,
      '--repo', repo,
      '--ref', branch,
      '-f', `retry_head_sha=${head}`,
      '-f', `retry_attempt=${attempt + 1}`,
      '-f', `retry_reason=${reason}`,
    ]);
    console.log(
      `[deploy-request] durable retry queued for ${head} (${reason}, attempt ${attempt + 1}/${MAX_DURABLE_RETRY_ATTEMPTS})`,
    );
    appendSummary(`🔁 **Deploy request retry queued**: ${reason} for \`${head}\` (attempt ${attempt + 1}/${MAX_DURABLE_RETRY_ATTEMPTS}).`);
    return true;
  } catch (error) {
    console.warn(`::warning::could not queue durable deploy retry: ${String(error?.message || error).split('\n')[0]}`);
    appendSummary(`⚠️ **Deploy request retry unavailable**: ${reason} for \`${head}\`; scheduled reconciliation remains responsible.`);
    return false;
  }
}

function recoverAfterFailure({ repo, workflow, branch, headSha, reason, error }) {
  const detail = String(error?.message || error).split('\n')[0];
  console.warn(`⚠️ ${reason}: ${detail}`);
  const queued = queueDurableRetry({ repo, workflow, branch, headSha, reason });
  if (!queued) {
    // Returning failure makes the outage visible. The five-minute schedule is
    // the independent retry path when this run could not enqueue its own one.
    appendSummary(`❌ **Deploy request failed closed**: ${reason}; no durable self-retry could be queued.`);
    return 1;
  }
  return 0;
}

function deployRequestPathsIgnore() {
  const workflowPath = resolve(process.cwd(), '.github/workflows/deploy-request.yml');
  const globs = parsePathsIgnore(readFileSync(workflowPath, 'utf8'));
  if (globs.length === 0) throw new Error('could not parse paths-ignore from deploy-request.yml');
  return globs;
}

function changedFilesSince({ repo, baseSha, headSha }) {
  const compare = ghJson(['api', `repos/${repo}/compare/${baseSha}...${headSha}`]);
  if (!Array.isArray(compare?.files)) throw new Error('compare response has no files array');
  return compare.files.map((file) => file.filename).filter((file) => typeof file === 'string');
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.DEPLOY_BRANCH || 'main';
  const workflow = process.env.DEPLOY_WORKFLOW || 'deploy.yml';
  const maxBuildsPerSha = Number(process.env.DEPLOY_MAX_BUILDS_PER_SHA) || DEFAULT_MAX_BUILDS_PER_SHA;
  const eventName = process.env.DEPLOY_EVENT_NAME || '';
  const eventHeadSha = process.env.DEPLOY_EVENT_HEAD_SHA || process.env.DEPLOY_RETRY_HEAD_SHA || '';
  const completedBuildSha = process.env.DEPLOY_BUILT_SHA || '';

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
    if (!Array.isArray(rawRuns?.workflow_runs)) throw new Error('deploy run response has no workflow_runs array');
    runs = rawRuns.workflow_runs.map((run) => ({
      id: run.id,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    }));
  } catch (error) {
    // An unreadable queue is not proof that the build lock is free. Keep the
    // event alive by putting its known SHA back into Actions' queue rather
    // than silently consuming the only push/workflow_run notification.
    return recoverAfterFailure({
      repo,
      workflow: 'deploy-request.yml',
      branch,
      headSha: headSha || eventHeadSha,
      reason: 'deploy-queue-read-failed',
      error,
    });
  }

  // workflow_run has no paths filter. If main only moved through paths that
  // the push trigger ignores since the completed build, do not re-arm a full
  // Pages build for a data-only update. A compare failure is fail-closed and
  // gets the same durable retry treatment as a queue read failure.
  if (eventName === 'workflow_run' && completedBuildSha && completedBuildSha !== headSha) {
    try {
      const changed = changedFilesSince({ repo, baseSha: completedBuildSha, headSha });
      const pending = changedFilesRequiringDeploy(changed, deployRequestPathsIgnore());
      if (pending.length === 0) {
        const detail = `${headSha} only adds ${changed.length} ignored path(s) since completed build ${completedBuildSha}`;
        console.log(`[deploy-request] ${detail} → skip (workflow-run-ignored-only)`);
        appendSummary(`✅ **Deploy request queue**: no action — workflow-run completion contains only ignored paths since \`${completedBuildSha}\`.`);
        return 0;
      }
      console.log(`[deploy-request] workflow-run completion has ${pending.length} deploy-bound path(s) since ${completedBuildSha}`);
    } catch (error) {
      return recoverAfterFailure({
        repo,
        workflow: 'deploy-request.yml',
        branch,
        headSha,
        reason: 'workflow-run-path-compare-failed',
        error,
      });
    }
  }

  const verdict = decideLatestDeploy({ headSha, runs, maxBuildsPerSha });
  console.log(`[deploy-request] head=${headSha} runs=${runs.length} → ${verdict.action} (${verdict.reason}): ${verdict.detail}`);

  appendSummary(
    verdict.action === 'dispatch'
      ? `🚦 **Deploy request queue**: ${verdict.detail}`
      : `✅ **Deploy request queue**: no action — ${verdict.reason} (${verdict.detail})`,
  );

  if (verdict.action !== 'dispatch' || process.env.DEPLOY_REQUEST_DRY_RUN === '1') return 0;

  try {
    gh(['workflow', 'run', workflow, '--repo', repo, '--ref', branch]);
    console.log(`[deploy-request] ✅ dispatched ${workflow} on ${branch} for ${headSha}`);
  } catch (error) {
    // Do not consume the only request when the dispatch mutation is
    // ambiguous/failed. Queue a durable control-plane retry; if that mutation
    // also fails, return non-zero so the scheduled reconciler remains visible.
    return recoverAfterFailure({
      repo,
      workflow: 'deploy-request.yml',
      branch,
      headSha,
      reason: 'deploy-dispatch-failed',
      error,
    });
  }
  return 0;
}

if (isInvokedDirectly(import.meta.url)) process.exit(main());
/* c8 ignore stop */
