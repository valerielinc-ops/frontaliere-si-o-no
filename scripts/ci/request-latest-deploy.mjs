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
 * one build for the current tip when it is not already the active or pending
 * candidate. If main advances while a build is live, the dispatch becomes the
 * latest pending candidate and replaces an obsolete pending run.
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
 *
 * @param {{
 *   headSha?: string,
 *   runs?: Array<{ id?: number, headSha?: string, status?: string, conclusion?: string | null }>,
 *   maxBuildsPerSha?: number,
 * }} [options]
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
  const queued = live.filter((run) => String(run?.status || '') !== 'in_progress');
  const staleQueued = queued.filter((run) => String(run?.headSha || '') !== head);

  // A new dispatch does not interrupt the running build. With the shared
  // `pages-build-run` group it takes the pending slot, replacing an older
  // pending SHA so that the next build contains the latest deployable changes.
  // This freshness repair deliberately precedes the per-SHA retry cap: leaving
  // the stale pending run in place could publish that older SHA after this
  // active run finishes. The replacement is bounded because the latest SHA
  // then occupies the pending slot and the next reconcile skips it.
  if (staleQueued.length > 0) {
    return {
      action: 'dispatch',
      reason: 'refresh-stale-pending',
      detail: `${staleQueued.length} pending deploy run(s) are behind main; dispatching ${head} to refresh the pending candidate`,
      headSha: head,
    };
  }

  if (queued.some((run) => String(run?.headSha || '') === head)) {
    return skip(
      'pipeline-moving',
      `the latest main SHA ${head} is already queued; waiting for the build lock`,
    );
  }

  const forHead = all.filter((run) => String(run?.headSha || '') === head);
  const alreadyBuilt = forHead.some((run) => String(run?.conclusion || '') === 'success');
  const staleRunning = live.some((run) => (
    String(run?.status || '') === 'in_progress' && String(run?.headSha || '') !== head
  ));

  if (staleRunning && alreadyBuilt) {
    return {
      action: 'dispatch',
      reason: 'queue-latest-behind-running-build',
      detail: `an older build is still running; queueing ${head} behind it to keep the final candidate current`,
      headSha: head,
    };
  }

  if (!staleRunning && live.some((run) => (
    String(run?.status || '') === 'in_progress' && String(run?.headSha || '') === head
  ))) {
    return skip('pipeline-moving', `the latest main SHA ${head} is already building`);
  }

  const cap = Number.isSafeInteger(maxBuildsPerSha) && maxBuildsPerSha > 0
    ? maxBuildsPerSha
    : DEFAULT_MAX_BUILDS_PER_SHA;
  const attempts = forHead.filter((run) => String(run?.status || '') === 'completed').length;

  if (staleRunning) {
    if (attempts >= cap) {
      return skip(
        'attempt-cap',
        `${head} already has ${attempts} completed build attempt(s) (cap ${cap}); not queueing another attempt behind the older live build`,
      );
    }
    return {
      action: 'dispatch',
      reason: 'queue-latest-behind-running-build',
      detail: `an older build is running; dispatching ${head} as the next candidate`,
      headSha: head,
    };
  }

  if (alreadyBuilt) {
    return skip('head-already-built', `${head} already has a successful build`);
  }

  if (attempts >= cap) {
    return skip(
      'attempt-cap',
      `${head} already has ${attempts} completed build attempt(s) (cap ${cap})`,
    );
  }

  return {
    action: 'dispatch',
    reason: 'pipeline-idle',
    detail: `no deploy run covers ${head} and it has no successful build (${attempts} attempt(s)); dispatching one build`,
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

/**
 * What this script needs from the two REST answers it reads, as `gh --jq`
 * filters. `gh` applies them before the answer crosses the pipe.
 */
export const DEPLOY_RUNS_PROJECTION = '[.workflow_runs[] | {id, headSha: .head_sha, status, conclusion}]';
export const COMPARE_FILES_PROJECTION = '{files: [.files[].filename], count: (.files | length)}';

function newestLiveRun(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => LIVE_STATUSES.has(String(run?.status || '')))
    .reduce((newest, run) => (
      newest && Number(newest.id) > Number(run?.id) ? newest : run
    ), null);
}

// The second line of defence, should a projection ever grow: execFileSync
// stops reading at `maxBuffer`, 1 MiB when it is not given.
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/* c8 ignore start — the Actions shell around the pure decision core. */
function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GH_MAX_BUFFER_BYTES,
  }).trim();
}

/**
 * One REST read, always projected. The raw listing of 60 deploy runs is well
 * over a megabyte: read whole through the default buffer it ended in ENOBUFS
 * on every attempt, the three durable retries included, and from the moment
 * this workflow replaced the push trigger no deploy was requested (issue
 * 12308). A read without a projection is a programming error here, not an
 * option.
 */
function ghApi(path, projection) {
  if (typeof projection !== 'string' || !projection.trim()) {
    throw new Error(`a --jq projection is required to read ${path}`);
  }
  return gh(['api', path, '--jq', projection]);
}

function ghApiJson(path, projection) {
  const raw = ghApi(path, projection);
  if (!raw) throw new Error(`empty GitHub response for ${path}`);
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
  // With its patches a compare of 300 files is megabytes: only the names travel.
  const compare = ghApiJson(`repos/${repo}/compare/${baseSha}...${headSha}`, COMPARE_FILES_PROJECTION);
  if (!Array.isArray(compare?.files)) throw new Error('compare response has no files array');
  const files = compare.files.filter((file) => typeof file === 'string');
  return { files, truncated: Number(compare.count) >= 300 };
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
    headSha = ghApi(`repos/${repo}/commits/${branch}`, '.sha');
    runs = ghApiJson(
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&${createdSinceQuery(7)}&per_page=60`,
      DEPLOY_RUNS_PROJECTION,
    );
    if (!Array.isArray(runs)) throw new Error('deploy run response is not a list of runs');
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

  // Push ignores and workflow_run completions share one path check. When a
  // build is already live, compare main to the newest live candidate: ignored
  // data-only commits need not replace that candidate, but deployable commits
  // must refresh it even while the older build is still running.
  const latestLive = newestLiveRun(runs);
  const compareBaseSha = String(latestLive?.headSha || '')
    || (eventName === 'workflow_run' ? completedBuildSha : '');
  if (compareBaseSha && compareBaseSha !== headSha) {
    const compareLabel = latestLive
      ? `newest live build ${latestLive.id}`
      : `completed build ${completedBuildSha}`;
    try {
      const comparison = changedFilesSince({ repo, baseSha: compareBaseSha, headSha });
      const pending = changedFilesRequiringDeploy(comparison.files, deployRequestPathsIgnore());
      if (!comparison.truncated && pending.length === 0) {
        const reason = latestLive ? 'live-build-ignored-only' : 'workflow-run-ignored-only';
        const detail = `${headSha} only adds ${comparison.files.length} ignored path(s) since ${compareLabel}`;
        console.log(`[deploy-request] ${detail} → skip (${reason})`);
        appendSummary(`✅ **Deploy request queue**: no action — changes since ${compareLabel} contain only ignored paths.`);
        return 0;
      }
      if (comparison.truncated) {
        console.log('[deploy-request] compare response reached GitHub’s 300-file cap; refreshing conservatively');
      }
      console.log(`[deploy-request] ${pending.length} deploy-bound path(s) since ${compareLabel}`);
    } catch (error) {
      return recoverAfterFailure({
        repo,
        workflow: 'deploy-request.yml',
        branch,
        headSha,
        reason: 'deploy-path-compare-failed',
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
