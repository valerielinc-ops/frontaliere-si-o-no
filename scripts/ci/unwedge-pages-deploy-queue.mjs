/**
 * unwedge-pages-deploy-queue.mjs — free the `pages-deploy` concurrency group
 * when a publish run is wedged at the `github-pages` environment gate.
 *
 * WHY THIS EXISTS
 *
 * `deploy-publish.yml` holds `concurrency: { group: pages-deploy,
 * cancel-in-progress: false }`. That `false` is load-bearing: interrupting an
 * in-flight `actions/deploy-pages` is what latches GitHub Pages into
 * status=errored and freezes the site on an old build (prod outage
 * 2026-06-05). The cost of it is that GitHub will never evict the group's
 * holder, however long it holds.
 *
 * The `deploy` job declares `environment: github-pages` — mandatory, because
 * actions/deploy-pages binds the Pages deployment to the run through that
 * environment's OIDC identity. A job parked at an environment gate is not
 * "running", so no Actions-side deadline applies to it: not `timeout-minutes`,
 * not the 360-minute job default. Measured 2026-08-06 on
 * valerielinc-ops/frontaliere-si-o-no run 31118787881:
 *
 *   - `deploy` entered `waiting` at 2026-08-06T16:09:08Z and was still there
 *     14 h later — past 2× the default job timeout.
 *   - `/actions/runs/31118787881/pending_deployments` → `wait_timer: 0`,
 *     `reviewers: []`; `/environments/github-pages/deployment_protection_rules`
 *     → empty. There was nothing to approve and nothing to expire.
 *   - Its github-pages deployment 5782748003 never left state=waiting.
 *   - Run 31119921972 then sat pending 7 h 13 m (16:27:59Z → 23:40:35Z) as the
 *     ONLY other run in the group, and never started a job.
 *
 * Net effect: `deploy-publish.yml` scored 0 success across its 300 most recent
 * runs (2026-08-01T20:25Z → 2026-08-07T05:40Z); its last success was
 * 2026-07-27T22:15Z, ten days earlier.
 *
 * WHAT IT CANCELS, AND WHAT IT DELIBERATELY WILL NOT
 *
 * ONLY runs whose status is literally `waiting` — i.e. runs that have not begun
 * executing anything. Never `in_progress`, never `queued`. This is the whole
 * safety argument: a `waiting` run has no half-finished Pages upload to
 * interrupt, so unwedging can never contribute to the cancelled-deployment
 * bursts that cause the errored-latch outage above. A publish that fails, times
 * out, or dies half-way reaches a terminal conclusion on its own and releases
 * the group without this script's help.
 *
 * The alternative — rejecting the pending deployment via
 * `POST /actions/runs/{id}/pending_deployments` with `state: rejected` — is not
 * usable here: that call requires the caller to be a listed environment
 * reviewer, and the gate reports `reviewers: []` / `current_user_can_approve:
 * false` for GITHUB_TOKEN. Cancelling the run is the only lever available to a
 * workflow token.
 *
 * THRESHOLD
 *
 * A healthy run clears the gate in 4-6 s (run 30299092721: 6 s; 31096435063:
 * 4 s), worst observed 7 m 28 s (30310076907, which also included concurrency
 * queueing). The wedge ran 840+ min. The 45-minute default sits ~6× above the
 * worst healthy observation and ~1/18 of the observed wedge, so it cannot fire
 * on a slow-but-live gate — and since the caller
 * (pages-publish-lag-watchdog.yml) is hourly, a wedge is cleared within 45-105
 * minutes rather than indefinitely.
 *
 * FAIL DIRECTION
 *
 * Opposite to the lag watchdog it ships with, on purpose. That watchdog fails
 * OPEN (an indeterminate read must not page). This one fails CLOSED: anything
 * it cannot positively establish — unreadable timestamp, unexpected status, API
 * error — means "do not cancel". The harm of a missed unwedge is one more hour
 * of a stall that is already visible; the harm of a wrong cancel is destroying
 * a live publish.
 *
 * Exit code: 0 on every expected path, including "nothing wedged" and API
 * errors. Non-zero only on an unexpected crash, and the caller runs the step
 * `continue-on-error: true` so a broken unwedger can never suppress the lag
 * check that follows it.
 */

import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const API = 'https://api.github.com';
// Addressed by filename rather than numeric id (300318685) so a workflow
// rename/recreate surfaces as a 404 in the log instead of silently reaping
// nothing forever.
const WORKFLOW_FILE = 'deploy-publish.yml';
const DEFAULT_WEDGE_MINUTES = 45;

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * Pick the runs that are wedged at an environment gate and safe to cancel.
 *
 * `status === 'waiting'` is checked here and not delegated to the API's
 * `?status=waiting` filter alone: the filter is a convenience, this predicate
 * is the guarantee. If GitHub ever widens what that query returns, an
 * `in_progress` publish must still be untouchable.
 *
 * @param {Array<{status?: string, created_at?: string, id?: number}>} runs
 * @param {{ nowMs: number, thresholdMinutes?: number }} opts
 * @returns {Array<object>} runs to cancel (possibly empty)
 */
export function selectWedgedRuns(runs, { nowMs, thresholdMinutes = DEFAULT_WEDGE_MINUTES } = {}) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((run) => {
    // Anything that is executing, queued, or already finished is off limits.
    if (run?.status !== 'waiting') return false;
    // `created_at` is when the run entered the gate: for a workflow_run-driven
    // publish, run_started_at equals it (verified across all 40 recent runs),
    // and a waiting job never advances either field afterwards.
    const enteredMs = Date.parse(run.created_at ?? '');
    // Unparseable timestamp → we cannot prove the age → do not cancel.
    if (!Number.isFinite(enteredMs)) return false;
    return nowMs - enteredMs > thresholdMinutes * 60_000;
  });
}

/**
 * @param {object} run
 * @param {number} nowMs
 * @returns {number} whole minutes the run has been parked at the gate
 */
export function wedgeAgeMinutes(run, nowMs) {
  const enteredMs = Date.parse(run?.created_at ?? '');
  if (!Number.isFinite(enteredMs)) return 0;
  return Math.round((nowMs - enteredMs) / 60_000);
}

// ── Network (not unit-tested; exercised live) ───────────────────────

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const res = await fetch(`${API}${urlPath}`, { headers: githubApiHeaders(authToken()) });
  if (!res.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${res.status}`);
  return res.json();
}

/** @returns {Promise<boolean>} true when GitHub accepted the cancellation */
async function cancelRun(runId) {
  const res = await fetch(`${API}/repos/${REPO}/actions/runs/${runId}/cancel`, {
    method: 'POST',
    headers: githubApiHeaders(authToken()),
  });
  // 202 Accepted is the documented success. 409 means the run already reached a
  // terminal state between the list and the cancel — the group is free either
  // way, which is the outcome we wanted.
  if (res.status === 202) return true;
  if (res.status === 409) {
    console.log(`  run ${runId}: already terminal (409) — group is free anyway`);
    return true;
  }
  console.log(`::warning::Could not cancel run ${runId} — HTTP ${res.status}`);
  return false;
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const parsed = Number(process.env.WEDGE_MINUTES);
  const thresholdMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEDGE_MINUTES;

  let runs;
  try {
    const body = await ghJson(
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=waiting&per_page=50`,
    );
    runs = body.workflow_runs || [];
  } catch (err) {
    // Fail closed: an unreadable queue is not evidence of a wedge.
    console.log(`⚠️ Could not read ${WORKFLOW_FILE} runs: ${err.message} — not cancelling anything`);
    process.exit(0);
  }

  const nowMs = Date.now();
  const wedged = selectWedgedRuns(runs, { nowMs, thresholdMinutes });

  console.log('── pages-deploy queue unwedge ──');
  console.log(`Runs in status=waiting: ${runs.length} (threshold ${thresholdMinutes} min)`);

  if (wedged.length === 0) {
    // The common case, including "a run entered the gate a minute ago".
    console.log('✅ Nothing wedged past the threshold — pages-deploy is not blocked by a stuck gate.');
    process.exit(0);
  }

  for (const run of wedged) {
    const age = wedgeAgeMinutes(run, nowMs);
    console.log(
      `::warning::Run ${run.id} (${run.head_sha?.slice(0, 8) ?? '?'}) has been parked at the github-pages environment gate for ${age} min — cancelling to release the pages-deploy group.`,
    );
    await cancelRun(run.id);
  }

  // Never fails the caller: the next queued publish starting is the real
  // signal, and the lag watchdog running right after this step is what reports
  // whether the site is actually behind.
  console.log(`Cancelled ${wedged.length} wedged run(s). The newest pending publish can now acquire the group.`);
  process.exit(0);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    // ::error:: rather than a silent exit: the caller is continue-on-error, so
    // an annotation is the only way a broken unwedger stays visible.
    console.log(`::error::[unwedge-pages-deploy-queue] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
