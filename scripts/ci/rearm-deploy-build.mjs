/**
 * rearm-deploy-build.mjs — make "every HEAD eventually gets a successful build"
 * an invariant instead of a hope (#5349).
 *
 * ── WHAT ACTUALLY GOES WRONG ────────────────────────────────────────────────
 * deploy.yml serialises the build under `pages-build-run` with
 * `cancel-in-progress: false`, so GitHub keeps 1 running + 1 pending and drops
 * the superseded middle. That is newest-wins and it is CORRECT on a linear
 * `main`: the newer build already contains the commits it superseded.
 *
 * Measured over the 100 deploy.yml runs from 2026-08-06T12:37Z to
 * 2026-08-08T05:58Z (~41 h): 82 cancelled, 10 success, 6 failure, 2 in flight.
 * The 82 cancellations are the design working — deploy.yml's own paths-ignore
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
 * The result is deliberately asymmetric: it can only ever ADD a build when the
 * pipeline has stopped. It never cancels, never reorders, never touches the
 * concurrency group, and never runs while the pipeline is moving on its own.
 */

import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Statuses GitHub uses for a run that has not reached a conclusion yet. */
const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'action_required']);

export const DEFAULT_MAX_BUILDS_PER_SHA = 2;

/**
 * Pure decision core — no network, no clock, no process state, so every branch
 * below is testable and the safety argument is readable in one place.
 *
 * @param {object} input
 * @param {string} input.headSha              current tip of `main`
 * @param {Array<{id: number|string, headSha: string, status: string, conclusion?: string|null}>} input.runs
 *        recent deploy.yml runs on `main`, newest first (order is irrelevant here)
 * @param {number|string} [input.selfRunId]   the caller's own run, excluded from
 *        the in-flight test (it is in_progress BY DEFINITION while this runs)
 *        and counted as already-completed against the cap (it is about to be)
 * @param {number} [input.maxBuildsPerSha]
 * @returns {{ action: 'dispatch'|'skip', reason: string, detail: string }}
 */
export function decideRearm({ headSha, runs, selfRunId, maxBuildsPerSha = DEFAULT_MAX_BUILDS_PER_SHA }) {
  if (!headSha) {
    // Fail closed: not knowing what HEAD is means not knowing what to build.
    return { action: 'skip', reason: 'no-head-sha', detail: 'could not resolve the tip of main' };
  }
  const self = selfRunId == null ? null : String(selfRunId);
  const all = Array.isArray(runs) ? runs : [];

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

  // 2. HEAD already has a green build — the invariant holds, nothing to do.
  if (forHead.some((r) => r.conclusion === 'success')) {
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

  return {
    action: 'dispatch',
    reason: 'pipeline-stopped',
    detail: `no deploy run is queued or running and ${headSha} has no successful build (${attempts} attempt(s) so far) — dispatching one build`,
  };
}

/* c8 ignore start — I/O shell around the pure core above */

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.REARM_WORKFLOW || 'deploy.yml';
  const branch = process.env.REARM_BRANCH || 'main';
  const selfRunId = process.env.GITHUB_RUN_ID;
  const maxBuildsPerSha = Number(process.env.REARM_MAX_BUILDS_PER_SHA) || DEFAULT_MAX_BUILDS_PER_SHA;
  const dryRun = process.env.REARM_DRY_RUN === '1';

  if (!repo) {
    console.warn('⚠️  GITHUB_REPOSITORY unset — not an Actions run, nothing to re-arm');
    return 0;
  }

  let headSha = '';
  let runs = [];
  try {
    headSha = gh(['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']);
    // per_page=60 comfortably spans the busiest measured window (100 runs / 41 h
    // ⇒ ~2.4/h); older runs cannot change any branch above.
    const raw = gh([
      'api',
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&per_page=60`,
      '--jq',
      '[.workflow_runs[] | {id, headSha: .head_sha, status, conclusion}]',
    ]);
    runs = JSON.parse(raw);
  } catch (err) {
    // Fail closed and LOUD-ish: an unreadable API means we cannot prove the
    // pipeline has stopped, and dispatching on a guess is how a storm starts.
    console.warn(`⚠️  could not read the deploy queue (${err?.message?.split('\n')[0]}) — skipping re-arm`);
    return 0;
  }

  const verdict = decideRearm({ headSha, runs, selfRunId, maxBuildsPerSha });
  console.log(`[rearm] head=${headSha} runs=${runs.length} → ${verdict.action} (${verdict.reason}): ${verdict.detail}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      summary,
      verdict.action === 'dispatch'
        ? `🔁 **Deploy re-arm (#5349)**: ${verdict.detail}\n`
        : `✅ Deploy re-arm (#5349): no action — ${verdict.reason} (${verdict.detail})\n`,
    );
  }

  if (verdict.action !== 'dispatch') return 0;
  if (dryRun) {
    console.log('[rearm] REARM_DRY_RUN=1 — not dispatching');
    return 0;
  }

  try {
    gh(['api', '-X', 'POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`, '-f', `ref=${branch}`]);
    console.log(`[rearm] ✅ dispatched ${workflow} on ${branch} — the pipeline is moving again`);
  } catch (err) {
    // Never fail the deploy over this: the publish-lag watchdog is still the
    // backstop, and a red run here would be a second failure on top of the one
    // that stopped the pipeline in the first place.
    console.warn(`::warning::deploy re-arm dispatch failed: ${err?.message?.split('\n')[0]}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.warn(`⚠️  rearm-deploy-build failed: ${err?.message}`);
      process.exit(0);
    });
}
/* c8 ignore stop */
