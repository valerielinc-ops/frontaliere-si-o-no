/**
 * unwedge-pages-deploy-queue.mjs — free the `pages-deploy` concurrency group
 * when a publish run is wedged at the `github-pages` environment gate.
 *
 * WHY THIS EXISTS
 *
 * The `deploy` job in `deploy-publish.yml` holds a job-level `concurrency`
 * group `pages-deploy` with `cancel-in-progress: false`. That `false` is
 * load-bearing: interrupting an in-flight `actions/deploy-pages` is what latches GitHub Pages into
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
 * WHAT MUST BE PROVEN BEFORE A CANCEL
 *
 * The run listing only nominates candidates. Each candidate is re-read right
 * before the cancel, and `cancelVerdict()` cancels only when all of these hold
 * on the fresh data:
 *
 *   - the run is still `waiting`: between the listing and the cancel it may
 *     have left the gate and started uploading, and a cancel then would be the
 *     exact interruption `cancel-in-progress: false` exists to prevent;
 *   - it is a run of `main`: the newest pending publish rebuilds `main`, so
 *     cancelling a waiting run of it loses nothing, while a run dispatched from
 *     another ref carries content no later publish reproduces;
 *   - GitHub lists a pending `github-pages` deployment for it: positive
 *     evidence that the environment gate is what holds it, not a runner queue;
 *   - its job parked at the gate (status `waiting`) was created more than the
 *     threshold ago. That job's `created_at` is when the run reached the gate;
 *     the run's own `created_at` is not, because a run can sit queued behind
 *     the concurrency group or for a runner long before the gated job exists.
 *
 * GitHub offers no compare-and-cancel, so a run can still leave the gate in
 * the single round trip between the re-read and the POST; against a 45-minute
 * minimum at the gate that window is the residual risk, and it is accepted.
 *
 * FAIL DIRECTION
 *
 * Fails CLOSED on every decision: anything it cannot positively establish —
 * unreadable timestamp, unexpected status, missing pending deployment, API
 * error — means "do not cancel". The harm of a missed unwedge is one more cycle
 * of a stall that is already visible; the harm of a wrong cancel is destroying
 * a live publish.
 *
 * Fails LOUD on what it could not do: an unreadable or malformed run listing,
 * a candidate it could not re-read, or a cancel GitHub refused all set exit
 * code 1 with an `::error::` annotation, because each of them can leave the
 * `pages-deploy` group jammed with nothing else reporting it. "Nothing wedged" and
 * "candidate re-read and found healthy" exit 0.
 *
 * The caller (pages-publish-lag-watchdog.yml) runs this step
 * `continue-on-error: true`, so an exit 1 shows as an annotation without ever
 * suppressing the lag check that follows it.
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
// See WHAT MUST BE PROVEN: only a run of this branch may be reaped.
const PUBLISH_BRANCH = 'main';
const PAGES_ENVIRONMENT = 'github-pages';

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * First pass over the run listing: the runs worth re-reading.
 *
 * `status === 'waiting'` is checked here and not delegated to the API's
 * `?status=waiting` filter alone: the filter is a convenience, this predicate
 * is the guarantee. If GitHub ever widens what that query returns, an
 * `in_progress` publish must still be untouchable.
 *
 * The run's `created_at` is only a lower bound on how long it can have been at
 * the gate, so a run younger than the threshold is dropped without further
 * calls. The gate-entry time that decides comes from the jobs, in
 * `cancelVerdict()`.
 *
 * @param {Array<{status?: string, head_branch?: string, created_at?: string, id?: number}>} runs
 * @param {{ nowMs: number, thresholdMinutes?: number, branch?: string }} opts
 * @returns {Array<object>} candidate runs (possibly empty)
 */
export function selectWedgedRuns(runs, { nowMs, thresholdMinutes = DEFAULT_WEDGE_MINUTES, branch = PUBLISH_BRANCH } = {}) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((run) => {
    // Anything that is executing, queued, or already finished is off limits.
    if (run?.status !== 'waiting') return false;
    if (run.head_branch !== branch) return false;
    const createdMs = Date.parse(run.created_at ?? '');
    // Unparseable timestamp → we cannot bound the age → do not cancel.
    if (!Number.isFinite(createdMs)) return false;
    return nowMs - createdMs > thresholdMinutes * 60_000;
  });
}

/**
 * When the run reached the environment gate: the `created_at` of its job parked
 * there (status `waiting`). With several waiting jobs the LATEST entry counts.
 * No waiting job, or an unreadable timestamp on one of them → NaN.
 *
 * @param {Array<{status?: string, created_at?: string}>} jobs
 * @returns {number} epoch ms, or NaN when it cannot be established
 */
export function gateEntryMs(jobs) {
  if (!Array.isArray(jobs)) return NaN;
  let latest = NaN;
  for (const job of jobs) {
    if (job?.status !== 'waiting') continue;
    const ms = Date.parse(job.created_at ?? '');
    if (!Number.isFinite(ms)) return NaN;
    if (!Number.isFinite(latest) || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * @param {Array<{environment?: {name?: string}}>} pendingDeployments
 * @returns {boolean} true when GitHub reports a pending github-pages deployment
 */
export function parkedAtPagesGate(pendingDeployments) {
  return Array.isArray(pendingDeployments)
    && pendingDeployments.some((p) => p?.environment?.name === PAGES_ENVIRONMENT);
}

/**
 * @param {number} enteredMs gate entry (see gateEntryMs)
 * @param {number} nowMs
 * @returns {number} whole minutes parked at the gate (0 when unknown)
 */
export function wedgeAgeMinutes(enteredMs, nowMs) {
  if (!Number.isFinite(enteredMs)) return 0;
  return Math.round((nowMs - enteredMs) / 60_000);
}

/**
 * Final decision on ONE run, from data re-read right before the cancel. Every
 * condition in WHAT MUST BE PROVEN has to hold; anything else is "do not
 * cancel", with the reason for the log.
 *
 * @returns {{ cancel: boolean, reason: string, ageMinutes: number }}
 */
export function cancelVerdict({
  run,
  jobs,
  pendingDeployments,
  nowMs,
  thresholdMinutes = DEFAULT_WEDGE_MINUTES,
  branch = PUBLISH_BRANCH,
} = {}) {
  const keep = (reason, ageMinutes = 0) => ({ cancel: false, reason, ageMinutes });
  if (run?.status !== 'waiting') return keep(`status is now ${run?.status ?? 'unknown'}`);
  if (run.head_branch !== branch) return keep(`head_branch ${run.head_branch ?? 'unknown'} is not ${branch}`);
  if (!parkedAtPagesGate(pendingDeployments)) return keep(`no pending ${PAGES_ENVIRONMENT} deployment`);
  const enteredMs = gateEntryMs(jobs);
  if (!Number.isFinite(enteredMs)) return keep('no waiting job with a readable created_at');
  const ageMinutes = wedgeAgeMinutes(enteredMs, nowMs);
  if (nowMs - enteredMs <= thresholdMinutes * 60_000) {
    return keep(`at the gate for ${ageMinutes} min, within the ${thresholdMinutes}-min threshold`, ageMinutes);
  }
  return { cancel: true, reason: `parked at the ${PAGES_ENVIRONMENT} environment gate for ${ageMinutes} min`, ageMinutes };
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
  // terminal state between the re-read and the cancel — the group is free
  // either way, which is the outcome we wanted.
  if (res.status === 202) return true;
  if (res.status === 409) {
    console.log(`  run ${runId}: already terminal (409) — group is free anyway`);
    return true;
  }
  return false;
}

/** Fresh run, jobs and pending deployments of one candidate, read together. */
async function rereadCandidate(runId) {
  const [run, jobsBody, pendingDeployments] = await Promise.all([
    ghJson(`/repos/${REPO}/actions/runs/${runId}`),
    ghJson(`/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
    ghJson(`/repos/${REPO}/actions/runs/${runId}/pending_deployments`),
  ]);
  if (!Array.isArray(jobsBody?.jobs)) throw new Error('jobs response has no jobs array');
  if (!Array.isArray(pendingDeployments)) throw new Error('pending_deployments response is not an array');
  return { run, jobs: jobsBody.jobs, pendingDeployments };
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const parsed = Number(process.env.WEDGE_MINUTES);
  const thresholdMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEDGE_MINUTES;

  console.log('── pages-deploy queue unwedge ──');

  let runs;
  try {
    const body = await ghJson(
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=waiting&per_page=50`,
    );
    if (!Array.isArray(body?.workflow_runs)) throw new Error('response has no workflow_runs array');
    runs = body.workflow_runs;
  } catch (err) {
    // Nothing is cancelled, but an unreadable queue may be hiding the very
    // wedge this exists for: say so and exit 1.
    console.log(`::error::Could not read ${WORKFLOW_FILE} runs: ${err.message} — not cancelling anything`);
    process.exitCode = 1;
    return;
  }

  const candidates = selectWedgedRuns(runs, { nowMs: Date.now(), thresholdMinutes });
  console.log(`Runs in status=waiting: ${runs.length} (threshold ${thresholdMinutes} min)`);

  if (candidates.length === 0) {
    // The common case, including "a run entered the gate a minute ago".
    console.log('✅ Nothing wedged past the threshold — pages-deploy is not blocked by a stuck gate.');
    return;
  }

  const failures = [];
  let cancelled = 0;
  for (const listed of candidates) {
    let fresh;
    try {
      fresh = await rereadCandidate(listed.id);
    } catch (err) {
      failures.push(`run ${listed.id}: could not re-read it (${err.message})`);
      continue;
    }
    const verdict = cancelVerdict({ ...fresh, nowMs: Date.now(), thresholdMinutes });
    if (!verdict.cancel) {
      console.log(`  run ${listed.id}: left alone — ${verdict.reason}`);
      continue;
    }
    console.log(
      `::warning::Run ${fresh.run.id} (${fresh.run.head_sha?.slice(0, 8) ?? '?'}) has been ${verdict.reason} — cancelling to release the pages-deploy group.`,
    );
    if (await cancelRun(fresh.run.id)) cancelled += 1;
    else failures.push(`run ${fresh.run.id}: GitHub refused the cancel`);
  }

  // The next queued publish starting is the real signal, and the lag watchdog
  // running right after this step is what reports whether the site is behind.
  console.log(`Cancelled ${cancelled} wedged run(s).`);
  if (failures.length > 0) {
    console.log(`::error::The pages-deploy queue may still be jammed: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    // ::error:: rather than a silent exit: the caller is continue-on-error, so
    // an annotation is the only way a broken unwedger stays visible.
    console.log(`::error::[unwedge-pages-deploy-queue] Fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
