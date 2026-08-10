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
 * ALGORITHM (best-effort, stateless):
 *   1. List runs with conclusion `cancelled` created within the lookback window.
 *   2. For each run, list its jobs; a `cancelled` job is a *candidate* (concurrency
 *      groups with `cancel-in-progress: true` also cancel superseded runs — that is
 *      normal, not a timeout, so conclusion alone is not proof).
 *   3. Fetch the job's check-run annotations. GitHub stamps a literal
 *      "... exceeded ... maximum execution time ..." annotation ONLY when the job was
 *      cancelled by `timeout-minutes`. That message is the actual timeout signature.
 *   4. On a match, report via the shared `createGithubIssue` — same stable
 *      `CI Failure: <workflow>` title every other reporter in this repo uses, so it
 *      dedupes onto (and is later auto-closed by) the same issue thread.
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

function listCancelledRuns(cutoffMs) {
  const runs = [];
  const perPage = 100;
  for (let page = 1; runs.length < MAX_RUNS; page += 1) {
    const data = ghJson(repoPath(`actions/runs?status=cancelled&per_page=${perPage}&page=${page}`));
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

export async function main() {
  const cutoffMs = Date.now() - LOOKBACK_MINUTES * 60 * 1000;
  const runs = listCancelledRuns(cutoffMs);
  console.log(`[scan-job-timeouts] ${runs.length} cancelled run(s) in the last ${LOOKBACK_MINUTES}m`);

  let reported = 0;
  // title → issue ref already opened/matched during THIS scan. See the DEDUP note
  // in the header: this is layer (a), the one that removes the intra-scan race.
  const emittedByTitle = new Map();

  for (const run of runs) {
    for (const job of listJobs(run.id)) {
      const hit = findTimeoutAnnotation(job);
      if (!hit) continue;

      reported += 1;
      const title = `CI Failure: ${run.name}`;
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
      if (DRY_RUN) {
        const dup = emittedByTitle.has(title) ? ' (already emitted → would COMMENT)' : '';
        console.log(`[scan-job-timeouts] (dry-run) would report "${title}"${dup}`);
        emittedByTitle.set(title, { number: null });
        continue;
      }

      const already = emittedByTitle.get(title);
      if (already?.number) {
        // Same title already reported in this scan: comment on the known issue
        // number. The second job's detail must survive — it is a distinct job
        // that timed out — but it must not become a second issue.
        commentOnGithubIssue(
          already.number,
          `➕ Altro job dello stesso scan con lo stesso titolo.\n\n${description}`,
        );
        console.log(`[scan-job-timeouts] deduped onto #${already.number} — ${job.name}`);
        continue;
      }

      const issue = await createGithubIssue({
        title,
        description,
        priority: 2,
        labels: ['Bug', 'ci-timeout'],
        workflow: run.name,
      });
      // Record even a null-numbered result so a failed create doesn't turn every
      // remaining job of the run into another create attempt.
      emittedByTitle.set(title, issue || { number: null });
    }
  }
  console.log(`[scan-job-timeouts] done — ${reported} timeout(s) reported (dry-run=${DRY_RUN}).`);
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('scan-job-timeouts.mjs')) {
  main().catch((err) => {
    console.error(`[scan-job-timeouts] fatal: ${err.message}`);
    process.exit(1);
  });
}
