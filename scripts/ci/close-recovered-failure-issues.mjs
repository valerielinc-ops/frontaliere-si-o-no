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
 * ~300 `update-jobs-*` crawlers, `update-fuel-prices`, `quality-alerts`, etc. left their
 * failure issue OPEN even when the very next run went green (e.g. #2354: failed run
 * 27646211111, then two green runs, issue stayed open). Wiring `--resolve` into every
 * workflow file = 300-file churn that silently misses any future workflow. Instead this
 * single cron job reconciles ALL of them — present and future — by construction.
 *
 * ALGORITHM for `Workflow Failure:` / `CI Failure:` issues (unchanged):
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
 * ALGORITHM for `Crawler Failure:` issues — DIFFERENT since the crawler-workflow
 * consolidation (2026-07, see scripts/generate-crawler-group-workflows.mjs): 581
 * individual per-crawler workflows were replaced by 23 grouped `crawler-group-*.yml`
 * workflows, each running ~25 crawlers as concurrent `background: true` steps inside
 * ONE job. `Crawler Failure:` titles now embed `Run <slug>` (the crawler's OWN
 * background-step name, baked in as a literal at generation time — see that script's
 * "HAZARD FIX 3" comment) instead of a dispatchable workflow name, because
 * `${{ github.workflow }}` would otherwise resolve to the shared GROUP's name for every
 * crawler in it. `Run <slug>` cannot be looked up via `gh run list -w <name>` (it isn't a
 * workflow) — it identifies one STEP inside a group's shared job. So for these:
 *   1. Extract the crawler slug from `Run <slug>`.
 *   2. Find which `crawler-group-*.yml` file currently contains that crawler (greps each
 *      group file's `id: crawler-<slug>` markers — group membership can shift whenever
 *      the generator re-runs, so this is resolved fresh each time, not cached).
 *   3. Ask GitHub for that GROUP workflow's most-recent COMPLETED run on `main`.
 *   4. Fetch that run's job(s) via the Jobs API and find the STEP named `Run <slug>`
 *      inside it — steps have their OWN independent `conclusion` in the API response
 *      (confirmed empirically against a live run using this repo's other background-step
 *      workflow), so a sibling crawler's failure in the same job does NOT affect this
 *      step's own conclusion.
 *   5. If that STEP's conclusion is `success` and the run started after the issue was
 *      opened → close, exactly as the non-crawler path. Otherwise keep open.
 *   If the crawler can't be found in any current group file (renamed/removed), or the
 *   step can't be found in the run's job list (renamed background step id) → keep open
 *   (same conservative bias as the "no completed run" case).
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGithubIssue } from '../lib/github-issue-creator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const DRY_RUN = process.argv.includes('--dry-run');
// Stable titles minted by github-issue-creator.mjs failure reporters. For `Workflow`/`CI`
// prefixes, group 2 is the workflow display name (equals `github.workflow` and `gh run
// list -w <name>`). For `Crawler` prefixes (post-consolidation), group 2 is instead the
// literal `Run <slug>` background-step identifier — see the module docstring above.
export const TITLE_RE = /^(?:Workflow|Crawler|CI) Failure: (.+)$/;
export const CRAWLER_STEP_RE = /^Run (.+)$/;
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

// Find which crawler-group-*.yml currently contains a crawler's background step
// (`id: crawler-<slug>`). Group membership can shift whenever
// scripts/generate-crawler-group-workflows.mjs re-runs, so this reads the CURRENT
// workflow files directly each run (this script itself runs as a single short-lived
// process per cron invocation, so a fresh checkout is picked up naturally on the next
// scheduled run; no cross-invocation cache is kept). Returns the group workflow's
// `name:` (the dispatchable display name `gh run list -w` needs), or null if the
// crawler isn't found in any current group file.
export function findCrawlerGroupWorkflowName(slug, workflowsDir = WORKFLOWS_DIR) {
  const groupFiles = fs.existsSync(workflowsDir)
    ? fs.readdirSync(workflowsDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f))
    : [];
  // Anchored, whole-line match (not a plain substring check): a naive
  // `content.includes('id: crawler-' + slug)` would false-positive when one
  // crawler's slug is a prefix of another's in the same file (e.g. looking up
  // slug "hoch" would substring-match the UNRELATED "id: crawler-hoch-health"
  // line and return the wrong group) — the exact bug class flagged in
  // AdminPanel.tsx's failedSteps narrowing, guarded here too.
  const idLineRe = new RegExp(`^\\s*id:\\s*crawler-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  for (const file of groupFiles) {
    const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (idLineRe.test(content)) {
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

// Most-recent COMPLETED run of the named GROUP workflow, then the conclusion of the
// SPECIFIC background step named `Run <slug>` inside that run's job (steps carry their
// own independent conclusion in the Jobs API — a sibling crawler's failure in the same
// job does not affect this step's own conclusion). Returns
// { conclusion, status: 'completed', createdAt, databaseId } shaped like a run object
// (so the caller's existing green/afterFailure logic works unchanged), or null if the
// run, job, or step can't be resolved.
function latestCompletedCrawlerStepRun(slug) {
  const groupWorkflowName = findCrawlerGroupWorkflowName(slug);
  if (!groupWorkflowName) return null;

  const run = latestCompletedRun(groupWorkflowName);
  if (!run) return null;

  const jobsOut = gh(['api', `repos/${REPO || '{owner}/{repo}'}/actions/runs/${run.databaseId}/jobs`], { allowFailure: true });
  if (jobsOut === null) return null;
  let jobsData;
  try {
    jobsData = JSON.parse(jobsOut);
  } catch {
    return null;
  }
  const stepName = `Run ${slug}`;
  for (const job of jobsData.jobs || []) {
    const step = (job.steps || []).find((s) => s.name === stepName);
    if (step) {
      return {
        databaseId: run.databaseId,
        status: step.status,
        conclusion: step.conclusion,
        createdAt: run.createdAt,
      };
    }
  }
  return null; // background step not found in this run's job (renamed/removed?)
}

function main() {
  const issues = listFailureIssues();
  console.log(`[close-recovered] ${issues.length} open Workflow/Crawler/CI Failure issue(s)${DRY_RUN ? ' (dry-run)' : ''}`);
  let closed = 0;
  let kept = 0;
  let skipped = 0;

  for (const it of issues) {
    const crawlerStepMatch = CRAWLER_STEP_RE.exec(it.workflow);
    const isCrawlerStepIdentifier = it.title.startsWith('Crawler Failure:') && crawlerStepMatch;

    const run = isCrawlerStepIdentifier
      ? latestCompletedCrawlerStepRun(crawlerStepMatch[1])
      : latestCompletedRun(it.workflow);

    if (!run) {
      const reason = isCrawlerStepIdentifier
        ? `crawler '${crawlerStepMatch[1]}' not found in any current crawler-group-*.yml, or its step/run not resolvable`
        : 'no completed run on main (renamed/deleted?)';
      console.log(`  #${it.number} "${it.workflow}" — ${reason}, keep open`);
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

// CLI entry point (guarded so this module can be imported for unit tests without
// triggering real `gh` calls at import time).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
