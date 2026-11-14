import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
/**
 * rearm-deploy-build.mjs — make "every HEAD eventually gets a successful build"
 * an invariant instead of a hope (#5349).
 *
 * ── WHAT ACTUALLY GOES WRONG ────────────────────────────────────────────────
 * deploy.yml serialises the build under `pages-build-run` with
 * `cancel-in-progress: false`, so GitHub keeps 1 running + 1 pending and drops
 * only a superseded pending dispatch. That is newest-wins and it is CORRECT on
 * a linear `main`: the newer build already contains the commits it superseded;
 * The schedule in deploy.yml is only a best-effort recovery edge for a
 * pending cancellation; deploy-stalled-watchdog.yml covers missed schedule
 * delivery and terminal runs that cannot reach this final job. Neither
 * resolver enters the build graph itself.
 *
 * Measured over the 100 deploy.yml runs from 2026-08-06T12:37Z to
 * 2026-08-08T05:58Z (~41 h): 82 cancelled, 10 success, 6 failure, 2 in flight.
 * The 82 cancellations are the design working — deploy-request.yml's paths-ignore
 * comment records that 121/121 of them started zero jobs, i.e. they were
 * cancelled while still pending and cost nothing. Chasing that number is the
 * wrong lever, and this script does not try to.
 *
 * The real hole is much narrower and much more expensive. In that same 41 h
 * window there was exactly ONE moment when a deploy.yml run reached a terminal
 * state with NOTHING else queued or in progress:
 *
 *     2026-08-06T16:27:57Z — run ended `failure`, pipeline idle 412 minutes
 *
 * Nothing re-triggers a build in that state. `main` keeps moving, every commit
 * on it stays unbuilt and unpublished, and the pipeline only restarts when a
 * human happens to push. Six hours and fifty-two minutes of dead pipeline, from
 * one failed run — the same order of magnitude as the 638-minute publish lag
 * that filed #5349.
 *
 * ── WHY RE-ARM AND NOT DEBOUNCE ─────────────────────────────────────────────
 * Debouncing the trigger (schedule instead of push) removes the queue by
 * removing events — it buys the invariant with latency that every urgent merge
 * then pays, and it would not have helped here at all: the queue was not
 * overfull at 16:27, it was EMPTY. Re-arm adds the missing edge instead:
 * when the pipeline stops with work outstanding, start it again.
 *
 * ── THE TWO TRAPS, CLOSED EXPLICITLY ────────────────────────────────────────
 * RECURSION. A re-armed build completes and re-runs this check, so a naive
 * version loops forever on a commit whose build is genuinely broken. The cap is
 * on the SHA, not on the recursion depth: `maxBuildsPerSha` counts the runs that
 * already exist for HEAD (including the caller's own run, which is about to
 * finish). Every re-arm adds exactly one completed run for that sha, so the
 * count strictly increases and the chain terminates after at most
 * `maxBuildsPerSha - 1` re-arms — one retry at the default of 2. A genuinely
 * broken commit is retried once and then left alone; deploy.yml files its own
 * failure issue, and nothing here papers over it.
 *
 * STORM. Many cancelled builds must not produce many re-arms. Two things make
 * that impossible rather than unlikely: the decision is taken for the CURRENT
 * HEAD only — one sha, so at most one dispatch, regardless of how many commits
 * were superseded — and `decideRearm` returns `skip` the instant any other
 * deploy.yml run is queued or in progress. In the saturated regime (99 of those
 * 100 runs) that check is what fires, and this script is a no-op.
 *
 * The result is deliberately asymmetric: it can only ever ADD a build after a
 * terminal run, or when an observer finds an idle unbuilt tip. The first
 * successful attempt gets one bounded successor too: build-history/data commits
 * can advance `main` after the caller's queue snapshot, so treating that first
 * success as the end of the chain leaves the new tip unbuilt. It never cancels,
 * never reorders, never touches the concurrency group, and never runs while the
 * pipeline is moving on its own.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { createdSinceQuery } from './lib/run-listing-window.mjs';
import { readDeployRearmStatuses, resolveDeployRearmRequest } from './deploy-rearm-request.mjs';
import {
  buildLocaleFromJobName,
  classifyBuildLocaleFailure,
  detectBuildLocaleHostKill,
  HOST_KILL_SETTLE_MS,
} from './lib/deploy-job-failure-signature.mjs';
import {
  classifyDeployFailure,
  extractFailurePaths,
  failureKey,
} from './deploy-failure-classifier.mjs';

/** Statuses GitHub uses for a run that has not reached a conclusion yet. */
const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'action_required']);

export const DEFAULT_MAX_BUILDS_PER_SHA = 2;
export const DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS = 1;

const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';
const DEPLOY_WORKFLOW_NAME = 'Deploy to GitHub Pages';
const PREPARED_SNAPSHOT_ARTIFACT = 'prepared-snapshot';
const SHA_RE = /^[0-9a-f]{40}$/i;
const FAILED_LEG_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

function recoverySkip(reason, detail) {
  return { action: 'skip', reason, detail: detail || reason };
}

function annotationsForJob(annotationsByJob, jobId) {
  if (annotationsByJob instanceof Map) return annotationsByJob.get(String(jobId)) || [];
  if (annotationsByJob && typeof annotationsByJob === 'object') {
    return annotationsByJob[String(jobId)] || [];
  }
  return [];
}

/**
 * Decide whether exactly one build-locale matrix job may be re-run.
 *
 * This is deliberately separate from `decideRearm`: the existing whole-run
 * re-arm is still the fallback for ordinary failures, while this path is only
 * admitted when the failed leg, its run attempt, and its prepared snapshot are
 * all bound to the same SHA.
 *
 * @returns {{action: 'rerun'|'skip', reason: string, detail: string, job?: object, classification?: object}}
 */
export function decideBuildLocaleRecovery({
  run,
  workflow,
  jobs,
  artifacts,
  annotationsByJob = {},
  expectedSha,
  currentAttempt = run?.run_attempt,
  nowMs = Date.now(),
  maxRecoveryAttempts = DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS,
  settleMs = HOST_KILL_SETTLE_MS,
} = {}) {
  const runId = String(run?.id ?? '').trim();
  const runSha = String(run?.head_sha ?? '').trim();
  const expected = String(expectedSha ?? '').trim();
  if (!runId || !SHA_RE.test(runSha) || !SHA_RE.test(expected) || runSha.toLowerCase() !== expected.toLowerCase()) {
    return recoverySkip('provenance-sha-mismatch', 'run SHA is missing or differs from the current workflow SHA');
  }
  if (workflow?.path !== DEPLOY_WORKFLOW_PATH || run?.name !== DEPLOY_WORKFLOW_NAME) {
    return recoverySkip('provenance-workflow-mismatch', 'the observed run is not the canonical deploy workflow');
  }
  if (run?.head_branch !== 'main') {
    return recoverySkip('provenance-branch-mismatch', 'targeted locale recovery is restricted to main');
  }

  const attempt = Number(currentAttempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return recoverySkip('run-attempt-unreadable', 'the workflow run attempt is not a safe positive integer');
  }
  if (!Number.isSafeInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 1 || attempt > maxRecoveryAttempts) {
    return recoverySkip('recovery-attempt-cap', `locale recovery attempt ${attempt} exceeds cap ${maxRecoveryAttempts}`);
  }

  const snapshotArtifacts = Array.isArray(artifacts)
    ? artifacts.filter((artifact) => artifact?.name === PREPARED_SNAPSHOT_ARTIFACT)
    : [];
  if (snapshotArtifacts.length !== 1) {
    return recoverySkip(
      snapshotArtifacts.length === 0 ? 'snapshot-missing' : 'snapshot-ambiguous',
      `expected exactly one ${PREPARED_SNAPSHOT_ARTIFACT} artifact for run ${runId}`,
    );
  }
  const snapshot = snapshotArtifacts[0];
  if (snapshot.expired !== false || String(snapshot.workflow_run?.id ?? '') !== runId) {
    return recoverySkip('snapshot-provenance-mismatch', 'prepared snapshot is expired or belongs to another run');
  }

  const currentJobs = Array.isArray(jobs) ? jobs : [];
  const candidates = currentJobs.flatMap((job) => {
    if (String(job?.run_id ?? '') !== runId
        || Number(job?.run_attempt) !== attempt
        || String(job?.head_sha ?? '').toLowerCase() !== runSha.toLowerCase()
        || !buildLocaleFromJobName(job?.name)) return [];
    const classification = classifyBuildLocaleFailure(
      job,
      annotationsForJob(annotationsByJob, job.id),
      { nowMs, settleMs },
    );
    return classification ? [{ job, classification }] : [];
  });

  if (candidates.length === 0) {
    return recoverySkip('no-retryable-locale-leg', 'no build-locale job has a confirmed host-loss, timeout or memory signature');
  }
  if (candidates.length !== 1) {
    return recoverySkip(
      'ambiguous-retryable-locale-legs',
      `${candidates.length} build-locale jobs have a retryable signature; refusing a partial choice`,
    );
  }

  const [{ job, classification }] = candidates;
  // A leg lost before publishing its manifest aborts the others at the hreflang
  // barrier. Rerunning it alone cannot turn the run green, and would only spend
  // hours before the same whole-run re-arm that this skip reaches at once.
  const failedSibling = currentJobs.find((other) => other?.id !== job.id
    && Number(other?.run_attempt) === attempt
    && buildLocaleFromJobName(other?.name)
    && FAILED_LEG_CONCLUSIONS.has(other?.conclusion));
  if (failedSibling) {
    return recoverySkip(
      'sibling-locale-leg-failed',
      `${failedSibling.name} also failed, so rerunning only ${job.name} cannot complete the run`,
    );
  }
  return {
    action: 'rerun',
    reason: classification.kind,
    detail: `${job.name} is recoverable from the same SHA and prepared snapshot`,
    job,
    classification,
  };
}

/**
 * Pure decision core — no network, no clock, no process state, so every branch
 * below is testable and the safety argument is readable in one place.
 *
 * @param {object} input
 * @param {string} input.headSha              current tip of `main`
 * @param {Array<{id: number|string, headSha: string, status: string, conclusion?: string|null, event?: string}>} input.runs
 *        recent deploy.yml runs on `main`, newest first (order is irrelevant here)
 * @param {number|string} [input.selfRunId]   the caller's own run, excluded from
 *        the in-flight test (it is in_progress BY DEFINITION while this runs)
 *        and counted as already-completed against the cap (it is about to be)
 * @param {string} [input.selfConclusion]      known final conclusion for the
 *        caller when the final job runs before the Actions run is terminal
 * @param {string} [input.selfHeadSha]          SHA built by the caller; used to
 *        keep a green run of an older SHA from masking a newer main tip
 * @param {number} [input.maxBuildsPerSha]
 * @param {{state?: string, reason?: string}} [input.redeployRequest]
 * @returns {{ action: 'dispatch'|'skip', reason: string, detail: string }}
 */
export function decideRearm({
  headSha,
  runs,
  selfRunId,
  selfConclusion = '',
  selfHeadSha = '',
  maxBuildsPerSha = DEFAULT_MAX_BUILDS_PER_SHA,
  redeployRequest = null,
}) {
  if (!headSha) {
    // Fail closed: not knowing what HEAD is means not knowing what to build.
    return { action: 'skip', reason: 'no-head-sha', detail: 'could not resolve the tip of main' };
  }
  const self = selfRunId == null ? null : String(selfRunId);
  const all = (Array.isArray(runs) ? runs : []).filter((run) => run?.event !== 'schedule');
  const selfRun = self ? all.find((run) => String(run.id) === self) : null;
  const selfBuiltSha = String(selfHeadSha || selfRun?.headSha || '').toLowerCase();
  const currentHead = String(headSha).toLowerCase();

  // 1. Is the pipeline still moving on its own? Then there is nothing to
  //    re-arm, and dispatching would evict the very run we are waiting for:
  //    with 1 running + 1 pending, a new arrival cancels the PENDING member.
  //    This is the branch that fires in the saturated regime.
  const live = all.filter((r) => String(r.id) !== self && LIVE_STATUSES.has(r.status));
  if (live.length) {
    return {
      action: 'skip',
      reason: 'pipeline-moving',
      detail: `${live.length} deploy run(s) still queued/in progress (e.g. ${live[0].id} ${live[0].status})`,
    };
  }

  const forHead = all.filter((r) => r.headSha === headSha);

  // A canonical regression can require one fresh build even when HEAD already
  // has a green build. The request is a status on this SHA and is considered
  // fulfilled only by a run created after that status; therefore this branch
  // cannot loop or rebuild for an old request.
  if (redeployRequest?.state === 'pending') {
    return {
      action: 'dispatch',
      reason: 'canonical-regression-redeploy',
      detail: redeployRequest.reason || `durable redeploy request for ${headSha}`,
    };
  }

  // 2. A prior successful attempt already completed this SHA's bounded chain.
  // The caller itself is excluded here: a first successful caller still needs
  // one successor so commits emitted at the end of the run cannot leave main's
  // new tip without a build.
  if (forHead.some((r) => String(r.id) !== self && r.conclusion === 'success')) {
    return { action: 'skip', reason: 'head-already-built', detail: `${headSha} already has a successful build` };
  }

  // 3. The recursion cap. The caller's own run is counted here even though it
  //    is still in_progress: it is finishing right now, and counting it is what
  //    makes each re-arm strictly increase this number.
  const attempts = forHead.filter((r) => r.status === 'completed' || String(r.id) === self).length;
  if (attempts >= maxBuildsPerSha) {
    return {
      action: 'skip',
      reason: 'attempt-cap',
      detail: `${headSha} already has ${attempts} build attempt(s) (cap ${maxBuildsPerSha}) — not retrying a build that keeps failing`,
    };
  }

  // 4. The first successful caller is terminal from GitHub's perspective, but
  // it is not terminal for this lifecycle: one successor closes the race with
  // build-history/data commits created near the end of the run. The attempt
  // cap and the prior-success guard above make this a single successor, not a
  // success loop.
  if (self
      && selfBuiltSha === currentHead
      && String(selfConclusion).toLowerCase() === 'success'
      && attempts === 1) {
    return {
      action: 'dispatch',
      reason: 'post-success-rearm',
      detail: `first successful build of ${headSha} completed — dispatching one bounded successor to close the main-tip race`,
    };
  }

  // 5. A successful caller that is not the first attempt is already covered by
  // the bounded chain. This is defensive for callers whose run listing marks
  // the current run successful before the prior-success row is visible.
  if (self
      && selfBuiltSha === currentHead
      && String(selfConclusion).toLowerCase() === 'success') {
    return { action: 'skip', reason: 'head-already-built', detail: `${headSha} already has a successful build` };
  }

  return {
    action: 'dispatch',
    reason: 'pipeline-stopped',
    detail: `no deploy run is queued or running and ${headSha} has no successful build (${attempts} attempt(s) so far) — dispatching one build`,
  };
}

// ── Failure circuit breaker (independent of the SHA) ───────────────────────
//
// `decideRearm` bounds retries per SHA. On a `main` that moves ~12 times an
// hour that is no bound at all for a DETERMINISTIC failure: every new SHA gets
// a fresh budget, so a broken test, an unreadable dataset or a memory guard was
// retried forever (2026-11-12: 20 consecutive `prep` failures with the same
// ERR_STRING_TOO_LONG, one every ~8 minutes; 41 failed builds out of 55 between
// 9 and 14 November). The breaker below is keyed on the failure SIGNATURE, so
// it does not care which SHA failed.

/** Minimum minutes between the end of the last failed run and the next re-arm, by streak length. */
export const FAILURE_BACKOFF_MINUTES = Object.freeze({
  deterministic: Object.freeze([20, 40, 80, 160, 240]),
  unknown: Object.freeze([10, 20, 40, 60]),
});
/** Absolute ceiling: re-arm builds started for non-infra failures in the window. */
export const DEFAULT_NON_INFRA_BUDGET_MAX = 6;
export const DEFAULT_NON_INFRA_BUDGET_WINDOW_HOURS = 12;
/** Runs walked back to measure a streak: one more than the longest backoff ladder. */
export const FAILURE_HISTORY_MAX_RUNS = 6;

/** Paths whose change can plausibly fix any build failure, whatever the signature. */
const BUILD_AFFECTING_PATH_RES = [
  /^\.github\/workflows\/deploy[^/]*\.ya?ml$/,
  /^scripts\/ci\//,
  /^build-plugins\//,
  /^vite\.config[^/]*$/,
  /^package(?:-lock)?\.json$/,
];

/**
 * Minutes to wait after the last failed run for a streak of `count` failures.
 * `infra` never waits here: it keeps the immediate-retry behaviour.
 */
export function failureBackoffMinutes(classification, count) {
  const ladder = FAILURE_BACKOFF_MINUTES[classification] ?? FAILURE_BACKOFF_MINUTES.unknown;
  const n = Number.isSafeInteger(count) && count > 0 ? count : 1;
  return ladder[Math.min(n, ladder.length) - 1];
}

/** True when any changed file is one the failure points at, or a build-affecting path. */
export function changeTouchesFailure(changedFiles, signaturePaths = []) {
  const files = Array.isArray(changedFiles) ? changedFiles.map(String) : [];
  const wanted = new Set((Array.isArray(signaturePaths) ? signaturePaths : []).map(String));
  return files.find((file) => wanted.has(file) || BUILD_AFFECTING_PATH_RES.some((re) => re.test(file))) || null;
}

/**
 * Pure circuit breaker applied when `decideRearm` says `pipeline-stopped`.
 *
 * @param {object} input
 * @param {number} input.nowMs
 * @param {{classification: string, signature: string, streak: number, lastEndedAtMs: number}|null} input.failure
 *        `null` when the last concluded run did not fail (nothing to break)
 * @param {boolean} [input.touchedSinceFailure]  a commit between the failed SHA and HEAD
 *        touches the failure's paths or a build-affecting path (fail-safe: `false`)
 * @param {number} [input.rearmFailuresInWindow]  re-arm builds that failed in the budget window
 * @param {number} [input.budgetMax]
 * @returns {{action: 'proceed'|'skip', reason: string, detail: string, waitMs?: number, nextAtMs?: number}}
 */
export function decideFailureBackoff({
  nowMs,
  failure,
  touchedSinceFailure = false,
  rearmFailuresInWindow = 0,
  budgetMax = DEFAULT_NON_INFRA_BUDGET_MAX,
}) {
  if (!failure || !failure.streak || failure.classification === 'infra') {
    return { action: 'proceed', reason: 'no-failure-streak', detail: 'no non-infrastructure failure streak to back off from' };
  }
  const short = String(failure.signature || '').slice(0, 120);
  if (rearmFailuresInWindow >= budgetMax) {
    return {
      action: 'skip',
      reason: 'rearm-budget-exhausted',
      detail: `${rearmFailuresInWindow} re-arm build(s) failed in the last ${DEFAULT_NON_INFRA_BUDGET_WINDOW_HOURS} h `
        + `(budget ${budgetMax}); not retrying "${short}" until the window drains or a human intervenes`,
    };
  }
  if (touchedSinceFailure) {
    return {
      action: 'proceed',
      reason: 'failure-backoff-released',
      detail: `a commit since the failed build touches the failing code or the build tooling; backoff for "${short}" released`,
    };
  }
  const waitMs = failureBackoffMinutes(failure.classification, failure.streak) * 60_000;
  const nextAtMs = failure.lastEndedAtMs + waitMs;
  if (nowMs < nextAtMs) {
    return {
      action: 'skip',
      reason: 'failure-backoff',
      detail: `${failure.classification} failure "${short}" repeated ${failure.streak}x; `
        + `next re-arm not before ${new Date(nextAtMs).toISOString()} (${Math.ceil((nextAtMs - nowMs) / 60_000)} min)`,
      waitMs,
      nextAtMs,
    };
  }
  return {
    action: 'proceed',
    reason: 'failure-backoff-elapsed',
    detail: `${failure.classification} failure "${short}" repeated ${failure.streak}x; backoff elapsed`,
  };
}

/**
 * Measure the streak of consecutive failed runs that share the failure key
 * (`job::step`) of the most recent concluded run. Pure over already-read
 * inputs; the I/O shell supplies one `classify(run)` per run it walks.
 *
 * @param {object} input
 * @param {Array<{id, headSha, status, conclusion, event?, createdAt?, updatedAt?}>} input.runs  non-schedule, any order
 * @param {string|number} [input.selfRunId]
 * @param {string} [input.selfConclusion]
 * @param {number} [input.nowMs]
 * @returns {{sequence: Array}} newest-first sequence of concluded runs; `failed` marks failures
 */
export function sequenceConcludedRuns({ runs, selfRunId, selfConclusion = '', nowMs = Date.now() }) {
  const self = selfRunId == null ? null : String(selfRunId);
  const out = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || run.event === 'schedule') continue;
    const isSelf = self != null && String(run.id) === self;
    if (!isSelf && run.status !== 'completed') continue;
    const conclusion = isSelf
      ? (String(selfConclusion).toLowerCase() === 'success' ? 'success' : 'failure')
      : String(run.conclusion || '');
    // cancelled/skipped runs are newest-wins supersession, not a verdict.
    if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral' || !conclusion) continue;
    const endedAtMs = isSelf ? nowMs : Date.parse(run.updatedAt || run.createdAt || '');
    out.push({ ...run, conclusion, failed: conclusion === 'failure' || conclusion === 'timed_out', endedAtMs });
  }
  out.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '') || 0);
  // The caller's own run is the newest by definition even if clocks disagree.
  if (self != null) {
    const idx = out.findIndex((run) => String(run.id) === self);
    if (idx > 0) out.unshift(...out.splice(idx, 1));
  }
  return { sequence: out };
}

/**
 * Count re-arm-started builds that ended in failure inside the budget window.
 * A re-arm dispatch is a `workflow_dispatch` by a bot actor (the default
 * GITHUB_TOKEN dispatches as `github-actions[bot]`).
 */
export function countRearmFailuresInWindow({
  runs,
  selfRunId,
  selfConclusion = '',
  nowMs = Date.now(),
  windowHours = DEFAULT_NON_INFRA_BUDGET_WINDOW_HOURS,
}) {
  const since = nowMs - windowHours * 3_600_000;
  const self = selfRunId == null ? null : String(selfRunId);
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (run?.event !== 'workflow_dispatch') return false;
    if (!/\[bot\]$/.test(String(run?.actor || ''))) return false;
    if (!(Date.parse(run?.createdAt || '') >= since)) return false;
    if (self != null && String(run.id) === self) return String(selfConclusion).toLowerCase() !== 'success';
    return run.status === 'completed' && (run.conclusion === 'failure' || run.conclusion === 'timed_out');
  }).length;
}

/**
 * Keep the source-promotion gate fail-closed while allowing the one expected
 * admission failure: a translation hold. The final deploy job is deliberately
 * scheduled with `always()`, so it must distinguish that narrow case from a
 * malformed/foreign promotion context before it can dispatch another build.
 * A watchdog has no promotion result because it is an observer, not a build
 * candidate; its queue and SHA checks are the admission boundary instead.
 */
export function decideRearmAdmission({
  promotionResult = '',
  translationResult = '',
  sourceResult = '',
} = {}) {
  const promotion = String(promotionResult).trim().toLowerCase();
  const translation = String(translationResult).trim().toLowerCase();
  const source = String(sourceResult).trim().toLowerCase();
  if (!promotion || promotion === 'success') {
    return { allowed: true, reason: 'admission-passed' };
  }
  if (promotion === 'failure' && translation === 'failure' && source === 'success') {
    return {
      allowed: true,
      reason: 'translation-handoff-failed',
      detail: 'the translation hold is resolved by the handoff TTL/fallback path; source promotion remains intact',
    };
  }
  return {
    allowed: false,
    reason: 'promotion-gate-failed',
    detail: `promotion=${promotion || 'unknown'} translation=${translation || 'unknown'} source=${source || 'unknown'}`,
  };
}

/**
 * The queue snapshot used for admission can become stale while the GitHub API
 * request is in flight. The caller must therefore take a second snapshot
 * while it still owns the durable `deploy-rearm-dispatch` job claim and use
 * that snapshot as the final admission decision.
 *
 * @param {{action: 'dispatch'|'skip', reason: string, detail: string}} initialVerdict
 * @param {{action: 'dispatch'|'skip', reason: string, detail: string}} freshVerdict
 * @returns {{action: 'dispatch'|'skip', reason: string, detail: string}}
 */
export function decideDispatchAfterFreshQueue(initialVerdict, freshVerdict) {
  if (initialVerdict?.action !== 'dispatch') return initialVerdict;
  if (freshVerdict?.action === 'dispatch') return freshVerdict;
  return {
    action: 'skip',
    reason: `pre-dispatch-${freshVerdict?.reason || 'queue-recheck-failed'}`,
    detail: `pre-dispatch queue recheck blocked the dispatch: ${freshVerdict?.detail || 'fresh queue state was not admissible'}`,
  };
}

const TERMINAL_TARGETED_JOB_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

/**
 * Turn a failed targeted-rerun POST into a safe next action.
 *
 * A non-zero `gh api` exit is ambiguous: GitHub may have accepted the POST
 * and the client may have lost the response. A broad workflow dispatch in
 * that case would race the targeted rerun. Only an explicit 4xx rejection,
 * corroborated by an unchanged terminal target job and run attempt, admits
 * the bounded whole-run fallback. Every other observation is fail-closed.
 *
 * @returns {{action: 'fallback'|'skip', reason: string, detail: string}}
 */
export function decideTargetedRerunFallback({
  requestStatus,
  originalAttempt,
  observedRunAttempt,
  originalJobId,
  originalJobName,
  observedJobs,
} = {}) {
  const expectedAttempt = Number(originalAttempt);
  const runAttempt = Number(observedRunAttempt);
  const status = Number(requestStatus);
  const jobs = Array.isArray(observedJobs) ? observedJobs : [];
  const matchingJobs = jobs.filter((job) => (
    String(job?.id ?? '') === String(originalJobId ?? '')
      || (String(job?.run_id ?? '') && String(job?.name ?? '') === String(originalJobName ?? ''))
  ));

  const admitted = runAttempt > expectedAttempt
    || matchingJobs.some((job) => Number(job?.run_attempt) > expectedAttempt)
    || matchingJobs.some((job) => (
      Number(job?.run_attempt) === expectedAttempt
        && String(job?.id ?? '') !== String(originalJobId ?? '')
        && LIVE_STATUSES.has(String(job?.status ?? ''))
    ));
  if (admitted) {
    return {
      action: 'skip',
      reason: 'targeted-rerun-admitted',
      detail: 'the post failed after the targeted job/run moved to a newer or live attempt; broad dispatch is suppressed',
    };
  }

  const unchangedTerminalJob = matchingJobs.some((job) => (
    String(job?.id ?? '') === String(originalJobId ?? '')
      && Number(job?.run_attempt) === expectedAttempt
      && job?.status === 'completed'
      && TERMINAL_TARGETED_JOB_CONCLUSIONS.has(String(job?.conclusion ?? ''))
  ));
  const explicitRejection = Number.isSafeInteger(status) && status >= 400 && status < 500;
  if (explicitRejection
      && Number.isSafeInteger(expectedAttempt)
      && runAttempt === expectedAttempt
      && unchangedTerminalJob) {
    return {
      action: 'fallback',
      reason: 'targeted-rerun-rejected',
      detail: `GitHub rejected the targeted rerun with HTTP ${status} and the target remained on attempt ${expectedAttempt}`,
    };
  }

  return {
    action: 'skip',
    reason: 'targeted-rerun-admission-ambiguous',
    detail: 'could not prove both an explicit rejection and an unchanged target; no broad re-arm is dispatched',
  };
}

/* c8 ignore start — I/O shell around the pure core above */

const REARM_LISTING_WINDOW_DAYS = 7;

// execFileSync stops reading at `maxBuffer`, 1 MiB when it is not given, and
// throws ENOBUFS: that is how the request queue next door went blind (issue
// 12308). The listing here is already projected; the buffer is the second line.
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GH_MAX_BUFFER_BYTES,
  }).trim();
}

function ghJson(args) {
  const raw = gh(args);
  if (!raw) throw new Error(`empty GitHub API response for ${args.join(' ')}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON from GitHub API for ${args.join(' ')}`);
  }
}

function githubHttpStatus(error) {
  const text = [error?.stderr, error?.stdout, error?.message]
    .filter((value) => value != null)
    .map((value) => String(value))
    .join('\n');
  const match = text.match(/\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/i);
  return match ? Number(match[1]) : null;
}

function inspectTargetedRerunPostFailure({
  repo,
  runId,
  jobId,
  jobName,
  originalAttempt,
  requestStatus,
} = {}) {
  try {
    const run = ghJson(['api', `repos/${repo}/actions/runs/${runId}`]);
    const jobsPayload = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`]);
    return decideTargetedRerunFallback({
      requestStatus,
      originalAttempt,
      observedRunAttempt: run?.run_attempt,
      originalJobId: jobId,
      originalJobName: jobName,
      observedJobs: jobsPayload?.jobs,
    });
  } catch (probeError) {
    return {
      action: 'skip',
      reason: 'targeted-rerun-admission-unreadable',
      detail: `could not verify targeted rerun admission: ${String(probeError?.message || probeError).split('\n')[0]}`,
    };
  }
}

const RUNS_PROJECTION = '[.workflow_runs[] | {id, headSha: .head_sha, headBranch: .head_branch, status, conclusion, event, actor: .actor.login, createdAt: .created_at, updatedAt: .updated_at}]';

function mergeRuns(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const run of collection) {
      if (run?.id == null) continue;
      byId.set(String(run.id), run);
    }
  }
  return [...byId.values()];
}

function readJobAnnotations(job) {
  if (!job?.check_run_url) throw new Error(`job ${job?.id || '?'} has no check-run URL`);
  const raw = gh([
    'api',
    `${job.check_run_url}/annotations`,
    '--paginate',
    '--slurp',
  ]);
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed.every((page) => Array.isArray(page))) return parsed.flat();
  throw new Error(`unreadable annotations for job ${job.id || '?'}`);
}

function settleWaitMs(job, nowMs) {
  const completedAt = Date.parse(job?.completed_at || '');
  if (!Number.isFinite(completedAt)) return 0;
  return Math.max(0, Math.min(HOST_KILL_SETTLE_MS, HOST_KILL_SETTLE_MS - (nowMs - completedAt)));
}

function readRearmQueueState({ repo, workflow, branch }) {
  const headSha = gh(['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']);
  // per_page=60 comfortably spans the busiest measured window (100 runs / 41 h
  // ⇒ ~2.4/h); this recent branch listing is for the live queue. The `created`
  // window makes those 60 the CURRENT ones: a `branch=` listing without it can
  // come back frozen weeks in the past (scripts/ci/lib/run-listing-window.mjs),
  // and here a stale listing shows no live run — i.e. it reads as
  // `pipeline-stopped` and dispatches. The second, head_sha-filtered listing
  // below is the durable per-SHA history used for the success and retry cap.
  // decideRearm() does not depend on row order.
  const raw = gh([
    'api',
    `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&${createdSinceQuery(REARM_LISTING_WINDOW_DAYS)}&per_page=60`,
    '--jq',
    RUNS_PROJECTION,
  ]);
  const recentRuns = JSON.parse(raw);
  // The recent branch listing is enough to see the live queue, but its
  // seven-day window is not enough to enforce "one retry, then idle until a
  // new commit". The head_sha filter is the durable per-SHA ledger: it keeps
  // old failures/successes in the decision even when the branch has been
  // quiet for weeks. The durable query is intentionally unbounded by
  // `created`; filter its projected head_branch locally so the full history
  // remains branch-safe without creating a branch listing without a window.
  // Merge by run id so a current run appearing in both responses is counted
  // once.
  const rawForHead = gh([
    'api',
    `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
    '--jq',
    RUNS_PROJECTION,
  ]);
  const durableRuns = JSON.parse(rawForHead);
  const runs = mergeRuns(
    recentRuns,
    Array.isArray(durableRuns) ? durableRuns.filter((run) => run?.headBranch === branch) : [],
  );
  const statuses = readDeployRearmStatuses({ repo, headSha });
  const redeployRequest = resolveDeployRearmRequest({ statuses, runs, headSha });
  if (redeployRequest.state === 'invalid') {
    throw new Error(`could not resolve the durable redeploy request: ${redeployRequest.reason}`);
  }
  return { headSha, runs, redeployRequest };
}

/**
 * Completed `workflow_dispatch` runs of the last days, newest first. deploy.yml
 * has no push trigger, so every build is a dispatch; asking for that event
 * keeps the 10-minute schedule ticks (6 an hour) from crowding the streak and
 * budget window out of a 60-row page.
 */
function readCompletedBuildRuns({ repo, workflow, branch }) {
  const raw = gh([
    'api',
    `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&event=workflow_dispatch&status=completed&${createdSinceQuery(REARM_LISTING_WINDOW_DAYS)}&per_page=40`,
    '--jq',
    RUNS_PROJECTION,
  ]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readRunJobs(repo, runId) {
  const payload = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`]);
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

/**
 * Classify the last concluded run and measure how many consecutive runs failed
 * with the same `job::step`. API budget: one run listing, one jobs read for the
 * latest run plus one annotation read per failed job there (at most 4), and a
 * jobs read per EARLIER run walked back (at most FAILURE_HISTORY_MAX_RUNS - 1,
 * stopping at the first run that differs). Fails safe: any read problem yields
 * `null`, i.e. no backoff and the pre-existing behaviour.
 */
function inspectFailureStreak({ repo, workflow, branch, runs, selfRunId, selfConclusion, selfHeadSha, nowMs }) {
  try {
    const completed = readCompletedBuildRuns({ repo, workflow, branch });
    const known = mergeRuns(completed, (Array.isArray(runs) ? runs : []).filter((run) => run?.event !== 'schedule'));
    if (selfRunId && !known.some((run) => String(run.id) === String(selfRunId))) {
      known.push({
        id: selfRunId, headSha: selfHeadSha, status: 'in_progress', conclusion: null,
        event: 'workflow_dispatch', createdAt: new Date(nowMs).toISOString(),
      });
    }
    const { sequence } = sequenceConcludedRuns({ runs: known, selfRunId, selfConclusion, nowMs });
    const latest = sequence[0];
    if (!latest || !latest.failed) return { failure: null, rearmFailuresInWindow: 0 };

    const jobs = readRunJobs(repo, latest.id);
    const annotationsByJob = {};
    for (const job of jobs.filter((j) => j?.status === 'completed' && ['failure', 'timed_out', 'cancelled'].includes(String(j?.conclusion))).slice(0, 4)) {
      try {
        annotationsByJob[String(job.id)] = readJobAnnotations(job);
      } catch {
        annotationsByJob[String(job.id)] = [];
      }
    }
    const classified = classifyDeployFailure({ jobs, annotationsByJob });
    const rearmFailuresInWindow = countRearmFailuresInWindow({ runs: known, selfRunId, selfConclusion, nowMs });
    if (classified.classification === 'infra') {
      return { failure: { ...classified, streak: 1, lastEndedAtMs: latest.endedAtMs, lastHeadSha: latest.headSha }, rearmFailuresInWindow };
    }

    const key = failureKey(classified.signature);
    let streak = 1;
    for (const earlier of sequence.slice(1, FAILURE_HISTORY_MAX_RUNS)) {
      if (!earlier.failed) break;
      const earlierClass = classifyDeployFailure({ jobs: readRunJobs(repo, earlier.id), annotationsByJob: {} });
      if (failureKey(earlierClass.signature) !== key) break;
      streak += 1;
    }
    return {
      failure: { ...classified, streak, lastEndedAtMs: latest.endedAtMs, lastHeadSha: latest.headSha },
      rearmFailuresInWindow,
    };
  } catch (err) {
    console.warn(`::warning::could not classify the last deploy failure (${String(err?.message || err).split('\n')[0]}) — no failure backoff applied`);
    return null;
  }
}

/** Files changed between the failed build's SHA and HEAD, or `null` when unreadable. */
function readChangedFiles({ repo, base, head }) {
  try {
    if (!SHA_RE.test(String(base)) || !SHA_RE.test(String(head))) return null;
    if (String(base).toLowerCase() === String(head).toLowerCase()) return [];
    const raw = gh(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '[.files[]?.filename]']);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Apply the failure circuit breaker to a `pipeline-stopped` verdict.
 * Returns the (possibly downgraded) verdict.
 */
function applyFailureBreaker({ verdict, repo, workflow, branch, headSha, runs, selfRunId, selfConclusion, selfHeadSha, nowMs }) {
  if (verdict.action !== 'dispatch' || verdict.reason !== 'pipeline-stopped') return { verdict, breaker: null };
  const inspected = inspectFailureStreak({ repo, workflow, branch, runs, selfRunId, selfConclusion, selfHeadSha, nowMs });
  if (!inspected?.failure) return { verdict, breaker: null };
  const { failure, rearmFailuresInWindow } = inspected;
  let decision = decideFailureBackoff({ nowMs, failure, touchedSinceFailure: false, rearmFailuresInWindow });
  if (decision.action === 'skip' && decision.reason === 'failure-backoff') {
    // Only now is the (single) compare call worth its cost.
    const changed = readChangedFiles({ repo, base: failure.lastHeadSha, head: headSha });
    const hit = changed == null ? null : changeTouchesFailure(changed, extractFailurePaths(failure.firstError));
    if (hit) {
      decision = decideFailureBackoff({ nowMs, failure, touchedSinceFailure: true, rearmFailuresInWindow });
      decision = { ...decision, detail: `${decision.detail} (changed: ${hit})` };
    }
  }
  const breaker = { failure, decision, rearmFailuresInWindow };
  if (decision.action === 'skip') {
    return { verdict: { action: 'skip', reason: decision.reason, detail: decision.detail }, breaker };
  }
  return { verdict, breaker };
}

const BLOCKED_ISSUE_PREFIX = 'Deploy build blocked:';

function blockedIssueTitle(failure) {
  const short = `${failure.job || 'deploy'} / ${failure.step || 'unknown step'}`.replace(/\s+/g, ' ').slice(0, 100);
  return `${BLOCKED_ISSUE_PREFIX} ${short}`;
}

/**
 * One issue per failure key. github-issue-creator dedups on the stable title and
 * comments on the open canonical issue instead of opening a second one. Never
 * throws: visibility must not cost a deploy.
 */
function upsertBlockedIssue({ failure, decision, runUrl }) {
  try {
    const body = [
      `The deploy re-arm is holding back new builds (${decision.reason}).`,
      '',
      `- classification: ${failure.classification}`,
      `- consecutive failures with this job/step: ${failure.streak}`,
      `- signature: \`${String(failure.signature).slice(0, 300)}\``,
      `- first error: ${String(failure.firstError || '(none)').slice(0, 300)}`,
      `- detail: ${decision.detail}`,
      runUrl ? `- observed from: ${runUrl}` : '',
      '',
      'The re-arm releases the hold by itself when the backoff elapses, when a commit touches the failing code or the build tooling, and closes this issue at the first green build.',
    ].filter((line) => line !== '').join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'rearm-blocked-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    execFileSync('node', [
      'scripts/lib/github-issue-creator.mjs',
      '--title', blockedIssueTitle(failure),
      '--description-file', file,
      '--workflow', DEPLOY_WORKFLOW_NAME,
      ...(runUrl ? ['--run-url', runUrl] : []),
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (err) {
    console.warn(`::warning::could not update the blocked-build issue: ${String(err?.message || err).split('\n')[0]}`);
  }
}

/** First green build: close every open `Deploy build blocked:` issue. Never throws. */
function resolveBlockedIssues({ runUrl }) {
  try {
    const listed = JSON.parse(gh([
      'issue', 'list', '--state', 'open', '--search', `in:title "${BLOCKED_ISSUE_PREFIX}"`,
      '--json', 'number,title', '--limit', '30',
    ]));
    for (const issue of Array.isArray(listed) ? listed : []) {
      if (!String(issue?.title || '').startsWith(BLOCKED_ISSUE_PREFIX)) continue;
      execFileSync('node', [
        'scripts/lib/github-issue-creator.mjs', '--resolve',
        '--title', issue.title, '--workflow', DEPLOY_WORKFLOW_NAME,
        ...(runUrl ? ['--run-url', runUrl] : []),
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    }
  } catch (err) {
    console.warn(`::warning::could not resolve blocked-build issues: ${String(err?.message || err).split('\n')[0]}`);
  }
}

async function inspectBuildLocaleRecovery({
  repo,
  runId,
  expectedSha,
  currentAttempt,
  maxRecoveryAttempts = DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS,
} = {}) {
  if (!repo || !runId || !expectedSha) {
    return recoverySkip('recovery-context-missing', 'run id, repository, or current SHA is unavailable');
  }

  try {
    const runPath = `repos/${repo}/actions/runs/${runId}`;
    let run = ghJson(['api', runPath]);
    let jobsPayload = ghJson(['api', `${runPath}/jobs?filter=all&per_page=100`]);
    let jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];

    // A just-finalised ordinary failure can briefly expose a frozen step. Wait
    // only when the exact Build step has the host-loss shape, and never longer
    // than the shared observer settle window.
    const nowMs = Date.now();
    const settleWait = Math.max(
      0,
      ...jobs
        .filter((job) => detectBuildLocaleHostKill(job, nowMs, 0))
        .map((job) => settleWaitMs(job, nowMs)),
    );
    if (settleWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleWait));
      run = ghJson(['api', runPath]);
      jobsPayload = ghJson(['api', `${runPath}/jobs?filter=all&per_page=100`]);
      jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
    }

    if (!run?.workflow_url) {
      throw new Error('workflow run has no workflow_url for provenance lookup');
    }
    const workflow = ghJson(['api', run.workflow_url]);

    const artifactsPayload = ghJson([
      'api',
      `${runPath}/artifacts?name=${encodeURIComponent(PREPARED_SNAPSHOT_ARTIFACT)}&per_page=100`,
    ]);
    const annotationsByJob = {};
    for (const job of jobs) {
      if (!buildLocaleFromJobName(job?.name)
          || !['cancelled', 'timed_out', 'failure'].includes(String(job?.conclusion || ''))
          || job?.status !== 'completed') continue;
      if (job.conclusion === 'failure') {
        // A plain failure is only recoverable on a memory signature; an
        // unreadable annotation list must not abort the existing host-loss and
        // timeout paths, it just leaves this leg non-recoverable.
        try {
          annotationsByJob[String(job.id)] = readJobAnnotations(job);
        } catch {
          annotationsByJob[String(job.id)] = [];
        }
      } else {
        annotationsByJob[String(job.id)] = readJobAnnotations(job);
      }
    }

    return decideBuildLocaleRecovery({
      run,
      workflow,
      jobs,
      artifacts: artifactsPayload?.artifacts,
      annotationsByJob,
      expectedSha,
      currentAttempt: currentAttempt || run?.run_attempt,
      maxRecoveryAttempts,
      nowMs: Date.now(),
    });
  } catch (err) {
    return recoverySkip(
      'recovery-api-unreadable',
      `cannot prove locale recovery inputs: ${String(err?.message || err).split('\n')[0]}`,
    );
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.REARM_WORKFLOW || 'deploy.yml';
  const branch = process.env.REARM_BRANCH || 'main';
  const selfRunId = process.env.GITHUB_RUN_ID;
  const maxBuildsPerSha = Number(process.env.REARM_MAX_BUILDS_PER_SHA) || DEFAULT_MAX_BUILDS_PER_SHA;
  const maxLocaleRecoveryAttempts = intFromEnv(
    'REARM_MAX_LOCALE_RECOVERY_ATTEMPTS',
    DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS,
  );
  const dryRun = process.env.REARM_DRY_RUN === '1';

  if (!repo) {
    console.warn('⚠️  GITHUB_REPOSITORY unset — not an Actions run, nothing to re-arm');
    return 0;
  }

  const admission = decideRearmAdmission({
    promotionResult: process.env.REARM_PROMOTION_RESULT,
    translationResult: process.env.REARM_TRANSLATION_RESULT,
    sourceResult: process.env.REARM_SOURCE_RESULT,
  });
  if (!admission.allowed) {
    console.log(`[rearm] skip: ${admission.reason} (${admission.detail})`);
    return 0;
  }

  // This is the terminal build's admission, captured before the build ran.
  // Do not reread the mutable translation marker here: build-history/data
  // commits can create a newer pending marker while this run is finishing,
  // and that must not suppress the bounded successor dispatch.
  const localeRecovery = process.env.REARM_SKIP_LOCALE_RECOVERY === '1'
    ? recoverySkip('recovery-disabled', 'locale recovery is disabled for the schedule-only resolver')
    : await inspectBuildLocaleRecovery({
      repo,
      runId: process.env.GITHUB_RUN_ID,
      expectedSha: process.env.GITHUB_SHA,
      currentAttempt: process.env.GITHUB_RUN_ATTEMPT,
      maxRecoveryAttempts: maxLocaleRecoveryAttempts,
    });
  if (localeRecovery.action === 'rerun') {
    const jobId = localeRecovery.job?.id;
    console.log(
      `[rearm] ${localeRecovery.reason}: retrying only ${localeRecovery.job?.name || 'the failed locale leg'} `
        + `(${jobId}) from the original run and prepared snapshot`,
    );
    let recoveryRequested = false;
    try {
      gh(['api', '-X', 'POST', `repos/${repo}/actions/jobs/${jobId}/rerun`]);
      recoveryRequested = true;
    } catch (err) {
      // A job rerun can be rejected while this workflow run is still open: the
      // recovery decision runs in the terminal run's own `rearm` job, before
      // GitHub has marked that run completed. A non-zero client exit is also
      // ambiguous, though: the POST may have been accepted and the response
      // lost. Probe the run/job attempt before allowing the broad fallback.
      const admission = inspectTargetedRerunPostFailure({
        repo,
        runId: process.env.GITHUB_RUN_ID,
        jobId,
        jobName: localeRecovery.job?.name,
        originalAttempt: localeRecovery.job?.run_attempt || process.env.GITHUB_RUN_ATTEMPT,
        requestStatus: githubHttpStatus(err),
      });
      if (admission.action !== 'fallback') {
        console.warn(`::warning::targeted build-locale recovery request outcome is ${admission.reason}: ${admission.detail}`);
        console.warn('::warning::skipping whole-run re-arm because a second recovery could race an admitted targeted rerun');
        return 0;
      }
      console.warn(`::warning::targeted build-locale recovery request rejected: ${admission.detail}`);
      console.warn('::warning::falling back to the bounded whole-run re-arm for the same main tip');
    }
    if (recoveryRequested) {
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try {
          const { appendFileSync } = await import('node:fs');
          appendFileSync(
            summary,
            `🔁 **Targeted build-locale recovery**: reran ${localeRecovery.job.name} `
              + `for ${localeRecovery.reason} on the same SHA/snapshot; no other matrix leg was dispatched.\n`,
          );
        } catch (err) {
          // The summary is diagnostic only. A successful recovery request must
          // not be turned into a second build because the summary file failed.
          console.warn(`::warning::could not write targeted recovery summary: ${err?.message?.split('\n')[0]}`);
        }
      }
      return 0;
    }
  }
  if (localeRecovery.reason === 'recovery-api-unreadable') {
    console.warn(`::warning::${localeRecovery.detail} — falling back to the existing whole-run re-arm decision`);
  }

  let queueState;
  try {
    queueState = readRearmQueueState({ repo, workflow, branch });
  } catch (err) {
    // Fail closed and LOUD-ish: an unreadable API means we cannot prove the
    // pipeline has stopped, and dispatching on a guess is how a storm starts.
    console.warn(`⚠️  could not read the deploy queue (${err?.message?.split('\n')[0]}) — skipping re-arm`);
    return 0;
  }

  const { headSha, runs, redeployRequest } = queueState;

  const baseVerdict = decideRearm({
    headSha,
    runs,
    selfRunId,
    selfConclusion: process.env.REARM_SELF_CONCLUSION,
    selfHeadSha: process.env.GITHUB_SHA,
    maxBuildsPerSha,
    redeployRequest,
  });
  const issueUpdates = process.env.REARM_ISSUE_UPDATE === '1';
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  // First green build of the caller: the blocked-build issue is stale.
  if (issueUpdates && String(process.env.REARM_SELF_CONCLUSION).toLowerCase() === 'success') {
    resolveBlockedIssues({ runUrl });
  }
  // The failure circuit breaker only ever turns a `pipeline-stopped` dispatch
  // into a skip; infra failures and every other reason pass through untouched.
  const { verdict, breaker } = applyFailureBreaker({
    verdict: baseVerdict,
    repo,
    workflow,
    branch,
    headSha,
    runs,
    selfRunId,
    selfConclusion: process.env.REARM_SELF_CONCLUSION,
    selfHeadSha: process.env.GITHUB_SHA,
    nowMs: Date.now(),
  });
  if (breaker?.decision.action === 'skip' && issueUpdates) {
    upsertBlockedIssue({ failure: breaker.failure, decision: breaker.decision, runUrl });
  }
  console.log(`[rearm] head=${headSha} runs=${runs.length} → ${verdict.action} (${verdict.reason}): ${verdict.detail}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  const writeSummary = async (entry) => {
    if (!summary) return;
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      summary,
      entry.action === 'dispatch'
        ? `🔁 **Deploy re-arm (#5349)**: ${entry.detail}\n`
        : (entry.reason === 'failure-backoff' || entry.reason === 'rearm-budget-exhausted')
          ? `⏸ **Deploy re-arm held back** — ${entry.reason}: ${entry.detail}\n`
          : `✅ Deploy re-arm (#5349): no action — ${entry.reason} (${entry.detail})\n`,
    );
  };

  if (verdict.action !== 'dispatch') {
    await writeSummary(verdict);
    return 0;
  }
  if (dryRun) {
    console.log('[rearm] REARM_DRY_RUN=1 — not dispatching');
    await writeSummary(verdict);
    return 0;
  }

  // The job-level `deploy-rearm-dispatch` concurrency group is the durable
  // claim shared by the schedule resolver and the final rearm job. Re-read the
  // queue while that claim is still held, immediately before dispatch. This is
  // the safety edge for a legitimate workflow_dispatch build that appeared
  // after the first listing: it remains in `pages-build-run` and this resolver
  // does not add a second run that could evict it.
  let freshQueueState;
  try {
    freshQueueState = readRearmQueueState({ repo, workflow, branch });
  } catch (err) {
    const blocked = {
      action: 'skip',
      reason: 'pre-dispatch-queue-unreadable',
      detail: `could not re-read the deploy queue: ${err?.message?.split('\n')[0]}`,
    };
    console.warn(`⚠️  ${blocked.detail} — skipping re-arm`);
    await writeSummary(blocked);
    return 0;
  }
  const freshVerdict = decideRearm({
    headSha: freshQueueState.headSha,
    runs: freshQueueState.runs,
    selfRunId,
    selfConclusion: process.env.REARM_SELF_CONCLUSION,
    selfHeadSha: process.env.GITHUB_SHA,
    maxBuildsPerSha,
    redeployRequest: freshQueueState.redeployRequest,
  });
  const finalVerdict = decideDispatchAfterFreshQueue(verdict, freshVerdict);
  if (finalVerdict.action !== 'dispatch') {
    console.log(`[rearm] ${finalVerdict.reason}: ${finalVerdict.detail}`);
    await writeSummary(finalVerdict);
    return 0;
  }

  try {
    await writeSummary(finalVerdict);
    // Mark this run as a recovery admission. Its workflow-level lane is
    // intentionally separate from an independent manual dispatch, so a
    // manual pending build cannot be evicted between the final queue read and
    // this POST. The per-locale build jobs retain the shared production lock.
    gh([
      'api', '-X', 'POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`,
      '-f', `ref=${branch}`,
      '-F', 'inputs[rearm_dispatch]=true',
    ]);
    console.log(`[rearm] ✅ dispatched ${workflow} on ${branch} — the pipeline is moving again`);
  } catch (err) {
    // Never fail the deploy over this: the stalled-deploy watchdog is still the
    // backstop, and a red run here would be a second failure on top of the one
    // that stopped the pipeline in the first place.
    console.warn(`::warning::deploy re-arm dispatch failed: ${err?.message?.split('\n')[0]}`);
  }
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.warn(`⚠️  rearm-deploy-build failed: ${err?.message}`);
      process.exit(0);
    });
}
/* c8 ignore stop */
