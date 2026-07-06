#!/usr/bin/env node
/**
 * close-recovered-failure-issues.mjs — zero-Claude reconciler.
 *
 * Auto-closes the auto-generated `Workflow Failure: <name>` / `Crawler Failure: <name>` /
 * `CI Failure: <name>` issues once the workflow has recovered — i.e. its NEXT run after
 * the failure is green. These three are the only failure-title prefixes minted by the
 * github-issue-creator.mjs reporters across all workflows (Crawler 439, Workflow 50, CI 8).
 *
 * WHY this is centralized (one reconciler, not 300 per-workflow steps):
 * Every scheduled workflow already opens a stable-titled issue on `if: failure()` via
 * scripts/lib/github-issue-creator.mjs. The mirror `--resolve` step (close on green) was
 * only ever wired into ~5 workflows (deploy/lighthouse/post-deploy/watchdog), so the
 * ~300 crawlers (consolidated 2026-07 into 23 `crawler-group-*.yml` workflows;
 * each crawler still opens its own failure issue via its own composite step),
 * plus `update-fuel-prices`, `quality-alerts`, etc. left their
 * failure issue OPEN even when the very next run went green (e.g. #2354: failed run
 * 27646211111, then two green runs, issue stayed open). Wiring `--resolve` into every
 * workflow file = 300-file churn that silently misses any future workflow. Instead this
 * single cron job reconciles ALL of them — present and future — by construction.
 *
 * ALGORITHM (per open failure issue):
 *   1. Parse the workflow display name out of the stable title prefix.
 *   2. Ask GitHub for that workflow's most-recent COMPLETED run on `main`.
 *   3. If that run is `success` AND started after the issue was opened (so it is a run
 *      that happened *after* the reported failure, not a stale pre-failure green) →
 *      close the issue via the same resolveGithubIssue() the inline `--resolve` uses
 *      (posts the "✅ Auto-resolved — green again" comment; reopens automatically if the
 *      same failure recurs).
 *   4. Otherwise (latest completed run still red, or no completed run / renamed workflow)
 *      → leave the issue open. Bias is conservative: never close while currently red.
 *
 * Best-effort and idempotent: safe to run on a schedule. `--dry-run` reports without
 * mutating. Scope is strictly the three auto-generated failure-title prefixes; follow-up,
 * tracker, validation-failure and other issues are never touched.
 *
 * One known edge: a workflow whose `CI Failure:` title is a literal that does NOT equal
 * its `name:` (only `persist-job-stats`: title "Persist Job Stats" vs name "Persist Job
 * Stats History") won't resolve via `gh run list -w <title>` → its issue stays open
 * (conservative/safe). Fixing that mismatch belongs in persist-job-stats.yml, not here.
 */
import { execFileSync } from 'node:child_process';
import { resolveGithubIssue } from '../lib/github-issue-creator.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// Stable titles minted by github-issue-creator.mjs failure reporters. Group 2 is the
// workflow display name, which equals `github.workflow` (and `gh run list -w <name>`).
const TITLE_RE = /^(?:Workflow|Crawler|CI) Failure: (.+)$/;
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

function repoFlag() {
  return REPO ? ['--repo', REPO] : [];
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function listFailureIssues() {
  const out = gh([
    'issue', 'list', '--state', 'open', '--limit', '300',
    '--json', 'number,title,createdAt', ...repoFlag(),
  ]);
  return JSON.parse(out)
    .map((i) => ({ issue: i, m: TITLE_RE.exec(i.title) }))
    .filter(({ m }) => m)
    .map(({ issue, m }) => ({
      number: issue.number,
      title: issue.title,
      createdAt: issue.createdAt,
      workflow: m[1].trim(),
    }));
}

// Most-recent COMPLETED run of the named workflow on main, or null if the workflow has
// no runs (e.g. renamed/deleted) — in which case we conservatively leave the issue open.
function latestCompletedRun(workflowName) {
  const out = gh([
    'run', 'list', '-w', workflowName, '-b', 'main', '-L', '20',
    '--json', 'databaseId,conclusion,status,createdAt', ...repoFlag(),
  ], { allowFailure: true });
  if (out === null) return null;
  let runs;
  try {
    runs = JSON.parse(out);
  } catch {
    return null;
  }
  return runs.find((r) => r.status === 'completed') || null;
}

function main() {
  const issues = listFailureIssues();
  console.log(`[close-recovered] ${issues.length} open Workflow/Crawler/CI Failure issue(s)${DRY_RUN ? ' (dry-run)' : ''}`);
  let closed = 0;
  let kept = 0;
  let skipped = 0;

  for (const it of issues) {
    const run = latestCompletedRun(it.workflow);
    if (!run) {
      console.log(`  #${it.number} "${it.workflow}" — no completed run on main (renamed/deleted?), keep open`);
      skipped++;
      continue;
    }
    const green = run.conclusion === 'success';
    // The failing run that opened the issue started BEFORE the issue's createdAt (the
    // reporter step runs after the job failed). So a green run created at/after the issue
    // is necessarily a LATER run — the "next run is ok" the user asked for.
    const afterFailure = Date.parse(run.createdAt) >= Date.parse(it.createdAt);

    if (green && afterFailure) {
      const runUrl = REPO ? `https://github.com/${REPO}/actions/runs/${run.databaseId}` : undefined;
      if (DRY_RUN) {
        console.log(`  #${it.number} WOULD CLOSE — recovered (run ${run.databaseId} success @ ${run.createdAt})`);
      } else {
        resolveGithubIssue(it.title, { workflow: it.workflow, runUrl });
        console.log(`  #${it.number} CLOSED — recovered via run ${run.databaseId}`);
      }
      closed++;
    } else if (green && !afterFailure) {
      console.log(`  #${it.number} latest green run ${run.databaseId} predates issue — keep open`);
      kept++;
    } else {
      console.log(`  #${it.number} still red (latest completed run ${run.databaseId}=${run.conclusion}) — keep open`);
      kept++;
    }
  }

  console.log(`[close-recovered] done: closed=${closed} kept=${kept} skipped=${skipped}`);
}

main();
