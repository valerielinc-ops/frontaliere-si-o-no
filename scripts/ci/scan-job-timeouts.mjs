#!/usr/bin/env node
/**
 * scan-job-timeouts.mjs — zero-workflow-file-touch timeout reporter.
 *
 * WHY centralized (one cron scan, not N workflow-file edits):
 * ~647 workflow files gate their failure reporter on `if: failure()`. GitHub Actions
 * marks a job that hit `timeout-minutes` as `cancelled`, not `failure` — `failure()`
 * never evaluates true for it, so a timed-out job silently reports nothing (the bug
 * that hid the `Send Job Alert Emails` timeout, run 28701746896, from ever opening an
 * issue). Patching the condition in every workflow file is the same 647-file-churn
 * problem `close-recovered-failure-issues.mjs` already solved for the mirror case
 * (issue auto-close): a single reconciler covers every workflow — present and future —
 * by construction, without touching any of them.
 *
 * TWO SIGNATURES, one reason to exist: a job that dies in a way `if: failure()`
 * cannot observe. (A) `timeout-minutes` — GitHub marks it `cancelled`, so
 * `failure()` is false. (B) HOST-KILL — the runner host itself dies mid-step, so
 * the job IS `failure` but the workflow's own reporter step never gets to run.
 *
 * (B) is issue #5773/#5772/#5771. Run 31672320271 (2026-08-13T06:01:15Z, `Deploy to
 * GitHub Pages`): `build-locale (it)` died INSIDE step 15 «Build (BUILD_LOCALE=it)»
 * at 06:19:48Z — no error, no stack, no exit code, and the step is still reported
 * `in_progress` by the API on a job whose conclusion is `failure`. Step 59 «Report
 * failure to GitHub Issues (build)» was one of the 50 steps left `pending`, so it
 * never ran; `deploy-publish.yml` is gated on `workflow_run.conclusion == success`
 * so it was a no-op too. The IT CDN push therefore never happened, which blocks
 * de/fr/en by design (the #2569 guard requires IT published first) — and the only
 * thing anybody could see were those three downstream symptoms. The dead leg itself
 * was invisible. This scanner is the observer that was missing.
 *
 * ALGORITHM (best-effort, stateless):
 *   1. List runs created within the lookback window, twice: conclusion `cancelled`
 *      (signature A) and conclusion `failure` (signature B).
 *   2A. For each cancelled run, list its jobs; a `cancelled` job is a *candidate*
 *      (concurrency groups with `cancel-in-progress: true` also cancel superseded
 *      runs — that is normal, not a timeout, so conclusion alone is not proof).
 *   3A. Fetch the job's check-run annotations. GitHub stamps a literal
 *      "... exceeded ... maximum execution time ..." annotation ONLY when the job was
 *      cancelled by `timeout-minutes`. That message is the actual timeout signature.
 *   2B. For each failed run, a job is host-killed when it is `failure` AND at least
 *      one of its steps is still `in_progress`. A job that failed normally always
 *      leaves every step concluded — the failing step carries `conclusion: failure`
 *      and the rest are absent. Measured over the 8 most recent failure runs of this
 *      repo: 7 had zero `in_progress` steps, and the only one that did was 31672320271.
 *      Costs no extra API call — `steps[]` ships inside the jobs listing already.
 *   4. On a match, report via the shared `createGithubIssue` — same stable
 *      `CI Failure: <workflow>` title every other reporter in this repo uses, so it
 *      dedupes onto (and is later auto-closed by) the same issue thread.
 *
 * WHY the same `CI Failure: <workflow>` title for both, and not a prettier one:
 * `close-recovered-failure-issues.mjs` closes on `TITLE_RE = /^(?:Workflow|Crawler|CI)
 * Failure: (.+)$/` and resolves the capture as a workflow name. A host-kill is a
 * transient host fault, so "the workflow went green again" IS the repair — this title
 * is on the auto-closing side of that regex on purpose. The rule it obeys is the one
 * in `report-workflow-failure.mjs`: no reporter ships until the same change says WHO
 * closes its issues, because with title dedup an unclosable issue is a permanent one.
 *
 * Stateless by design: no persisted scan cursor. The lookback window is sized wider
 * than the cron interval so no run is missed; the cost of the overlap is an extra
 * COMMENT on the canonical issue (never a duplicate issue) if the same run is seen
 * in two consecutive scans.
 *
 * DEDUP, and why one layer was not enough. A single run can time out in SEVERAL
 * jobs, and every one of them maps to the same `CI Failure: <workflow>` title. The
 * title-based dedup in `createGithubIssue` resolved through GitHub's SEARCH INDEX,
 * which is eventually consistent: the second job, seconds behind the first, did not
 * see the issue the first had just opened and opened its own. That is #5305/#5306 —
 * same run 31171006342, same title, 3 seconds apart. Two layers now close it:
 *   a) `emittedByTitle` below — an in-process map title → issue ref. Once a title
 *      has been reported in THIS scan, further jobs comment on that issue instead
 *      of calling the reporter again. No API lookup, so no race to lose.
 *   b) the listing fallback inside `searchIssuesByTitlePrefix` — covers the
 *      cross-PROCESS case (two scans, or this scan racing another reporter), which
 *      (a) by construction cannot see.
 */
import { execFileSync } from 'node:child_process';
import { createGithubIssue, commentOnGithubIssue } from '../lib/github-issue-creator.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const LOOKBACK_MINUTES = Number(process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES || 75);
const MAX_RUNS = 200; // safety cap per scan
const TIMEOUT_ANNOTATION_RE = /exceeded[^.]*(maximum execution time|maximum number of minutes)/i;
// A job that has only just failed can be read back mid-finalisation, with a step
// still momentarily `in_progress` — indistinguishable from a host-kill. Ignore
// anything that finished less than this ago; the 75m lookback is 15m wider than the
// hourly cron, so the next scan still sees it. Cheap insurance against a false
// host-kill issue on an ordinary red build.
const HOST_KILL_SETTLE_MS = Number(process.env.HOST_KILL_SETTLE_MS || 120_000);

function repoPath(suffix) {
  return REPO ? `repos/${REPO}/${suffix}` : `repos/{owner}/{repo}/${suffix}`;
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function ghJson(path, { allowFailure = true } = {}) {
  const out = gh(['api', path], { allowFailure });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function listRunsByStatus(status, cutoffMs) {
  const runs = [];
  const perPage = 100;
  for (let page = 1; runs.length < MAX_RUNS; page += 1) {
    const data = ghJson(repoPath(`actions/runs?status=${status}&per_page=${perPage}&page=${page}`));
    const batch = data?.workflow_runs || [];
    if (batch.length === 0) break;
    let hitCutoff = false;
    for (const run of batch) {
      if (Date.parse(run.created_at) < cutoffMs) {
        hitCutoff = true;
        break;
      }
      runs.push(run);
    }
    if (hitCutoff || batch.length < perPage) break;
  }
  return runs;
}

function listJobs(runId) {
  const data = ghJson(repoPath(`actions/runs/${runId}/jobs?per_page=100`));
  return data?.jobs || [];
}

function findTimeoutAnnotation(job) {
  if (job.conclusion !== 'cancelled' || !job.check_run_url) return null;
  const annotations = ghJson(`${job.check_run_url}/annotations`) || [];
  return annotations.find((a) => TIMEOUT_ANNOTATION_RE.test(a.message || '')) || null;
}

/**
 * Host-kill signature: the job is `failure` but at least one step never got a
 * conclusion and is still `in_progress` — i.e. the runner host went away while that
 * step was executing, so nothing downstream of it (including the workflow's own
 * `if: failure()` reporter) ever ran.
 *
 * Returns null for an ordinary failure, where every step is concluded.
 */
export function detectHostKill(job, nowMs = Date.now()) {
  if (job?.conclusion !== 'failure' || job?.status !== 'completed') return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const stuck = steps.filter((s) => s?.status === 'in_progress');
  if (stuck.length === 0) return null;

  const completedAt = Date.parse(job.completed_at || '');
  if (Number.isFinite(completedAt) && nowMs - completedAt < HOST_KILL_SETTLE_MS) return null;

  // Steps that never started at all: the blast radius of the kill, and the reason
  // the workflow reported nothing about itself.
  const neverRan = steps.filter((s) => s?.status === 'queued' || s?.status === 'pending');
  return { stuck, neverRan };
}

export async function main() {
  const nowMs = Date.now();
  const cutoffMs = nowMs - LOOKBACK_MINUTES * 60 * 1000;
  const cancelledRuns = listRunsByStatus('cancelled', cutoffMs);
  const failedRuns = listRunsByStatus('failure', cutoffMs);
  console.log(
    `[scan-job-timeouts] ${cancelledRuns.length} cancelled + ${failedRuns.length} failed run(s) `
      + `in the last ${LOOKBACK_MINUTES}m`,
  );

  let reported = 0;
  // title → issue ref already opened/matched during THIS scan. See the DEDUP note
  // in the header: this is layer (a), the one that removes the intra-scan race.
  // SHARED by both detectors on purpose: a host-kill takes out every job on that
  // host, so one run can produce several hits that all map to the same title.
  const emittedByTitle = new Map();

  async function emit({ title, description, labels, workflow, jobName }) {
    reported += 1;
    if (DRY_RUN) {
      const dup = emittedByTitle.has(title) ? ' (already emitted → would COMMENT)' : '';
      console.log(`[scan-job-timeouts] (dry-run) would report "${title}"${dup}`);
      emittedByTitle.set(title, { number: null });
      return;
    }

    const already = emittedByTitle.get(title);
    if (already?.number) {
      // Same title already reported in this scan: comment on the known issue
      // number. The second job's detail must survive — it is a distinct job
      // that died — but it must not become a second issue.
      commentOnGithubIssue(
        already.number,
        `➕ Altro job dello stesso scan con lo stesso titolo.\n\n${description}`,
      );
      console.log(`[scan-job-timeouts] deduped onto #${already.number} — ${jobName}`);
      return;
    }

    const issue = await createGithubIssue({ title, description, priority: 2, labels, workflow });
    // Record even a null-numbered result so a failed create doesn't turn every
    // remaining job of the run into another create attempt.
    emittedByTitle.set(title, issue || { number: null });
  }

  // (A) timeout — `cancelled`, proven by the check-run annotation.
  for (const run of cancelledRuns) {
    for (const job of listJobs(run.id)) {
      const hit = findTimeoutAnnotation(job);
      if (!hit) continue;

      const description = [
        '## Job cancellato per timeout',
        '',
        `**Job:** ${job.name}`,
        `**Motivo:** ${hit.message}`,
        `**Run:** ${run.html_url}`,
        `**Trigger:** ${run.event}`,
        `**Ref:** ${run.head_branch}`,
        '',
        'Rilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico, non dal workflow stesso — '
          + 'un job cancellato per timeout non passa mai `if: failure()`).',
      ].join('\n');

      console.log(`[scan-job-timeouts] TIMEOUT: ${run.name} / ${job.name} (run ${run.id})`);
      await emit({
        title: `CI Failure: ${run.name}`,
        description,
        labels: ['Bug', 'ci-timeout'],
        workflow: run.name,
        jobName: job.name,
      });
    }
  }

  // (B) host-kill — `failure` with a step frozen `in_progress`.
  for (const run of failedRuns) {
    for (const job of listJobs(run.id)) {
      const kill = detectHostKill(job, nowMs);
      if (!kill) continue;

      const stuckNames = kill.stuck.map((s) => `#${s.number} «${s.name}»`).join(', ');
      const description = [
        '## Job ucciso dall’host (runner morto a metà step)',
        '',
        `**Job:** ${job.name}`,
        `**Step rimasto \`in_progress\`:** ${stuckNames}`,
        `**Step mai partiti:** ${kill.neverRan.length}`,
        `**Run:** ${run.html_url}`,
        `**Trigger:** ${run.event}`,
        `**Ref:** ${run.head_branch}`,
        '',
        'Il job risulta `failure` ma nessuno step ha prodotto un errore, uno stack o un exit '
          + 'code: lo step di cui sopra è ancora `in_progress` via API su un job concluso. È la '
          + 'firma di un kill del runner host (OOM o perdita della VM), **non** di un bug '
          + 'applicativo.',
        '',
        '**Perché il workflow non ha segnalato niente da solo:** gli step di reporting sono a '
          + 'valle di quello ucciso, quindi sono rimasti `pending` e non hanno mai girato — '
          + '`if: failure()` non è mai stato valutato. Ogni consumer a valle gated su '
          + '`workflow_run.conclusion == "success"` è a sua volta un no-op. Senza questo scan '
          + 'l’evento è invisibile: si vedono solo i sintomi downstream.',
        '',
        '**Prima di rimediare, guarda i campioni di memoria nel log del run.** Un retry cieco '
          + 'maschererebbe un OOM ricorrente invece di misurarlo.',
        '',
        'Rilevato da `scripts/ci/scan-job-timeouts.mjs`.',
      ].join('\n');

      console.log(`[scan-job-timeouts] HOST-KILL: ${run.name} / ${job.name} (run ${run.id})`);
      await emit({
        title: `CI Failure: ${run.name}`,
        description,
        labels: ['Bug', 'ci-host-kill'],
        workflow: run.name,
        jobName: job.name,
      });
    }
  }

  console.log(`[scan-job-timeouts] done — ${reported} dead job(s) reported (dry-run=${DRY_RUN}).`);
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('scan-job-timeouts.mjs')) {
  main().catch((err) => {
    console.error(`[scan-job-timeouts] fatal: ${err.message}`);
    process.exit(1);
  });
}
