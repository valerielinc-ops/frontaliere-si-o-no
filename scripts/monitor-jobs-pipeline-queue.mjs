#!/usr/bin/env node
/**
 * monitor-jobs-pipeline-queue.mjs — observability for the `jobs-data-pipeline`
 * concurrency group's `queue: max` behaviour (PR #7035, follow-up items 3+4 of
 * #7063, issue #7165).
 *
 * PR #7035 set `cancel-in-progress: false` + `queue: max` on every workflow
 * sharing the `jobs-data-pipeline` concurrency group, so a run that arrives
 * while another is in flight should WAIT (queued, up to GitHub's documented
 * cap of 100 pending runs — changelog 2026-05-07) instead of being cancelled.
 * Nothing observed whether that assumption actually holds in this repo's plan:
 *   (a) if the plan/context does not fully honour `queue: max`, it can degrade
 *       silently back to the old "1 pending run" limit, which CANCELS the
 *       superseded run instead of queuing it — with `cancel-in-progress: false`
 *       declared, a queued run being cancelled is exactly that signature;
 *   (b) if the queue genuinely fills toward the 100-run cap (crawler burst),
 *       runs beyond it are dropped with no operational signal at all.
 *
 * This scanner covers both, same shape as `scripts/ci/scan-job-timeouts.mjs`
 * (periodic `gh api` scan + `createGithubIssue`, not a change to the
 * pipeline workflows themselves — no workflow file needs to know it exists).
 *
 * Group membership is discovered by scanning every `.github/workflows/*.yml`
 * for a literal `concurrency.group: jobs-data-pipeline` — the same condition
 * `tests/job-translation-queue.test.ts` already enforces for PR #7035 — so a
 * fifth workflow added to the group later is picked up without touching this
 * file. (Detecting a group built via a GitHub `${{ }}` expression is a
 * separate, narrower gap — #7164/PR #7229 — out of scope here.) Parsed with a
 * small line-based scanner, not the `yaml` package: that package is a
 * devDependency, and this script — same convention as
 * `scripts/ci/scan-job-timeouts.mjs` — runs from a bare checkout with no
 * `npm ci` step, Node stdlib + local modules only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGithubIssue } from './lib/github-issue-creator.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '.github/workflows';
const JOBS_DATA_PIPELINE_GROUP = 'jobs-data-pipeline';
// GitHub's documented cap for a `queue: max` concurrency group (changelog 2026-05-07).
const QUEUE_CAP = 100;
const SATURATION_WARN_THRESHOLD = Number(process.env.QUEUE_SATURATION_WARN_THRESHOLD || 80);
const CANCELLED_LOOKBACK_MINUTES = Number(process.env.QUEUE_CANCELLED_LOOKBACK_MINUTES || 180);

function repoPath(suffix) {
  return REPO ? `repos/${REPO}/${suffix}` : `repos/{owner}/{repo}/${suffix}`;
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
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

/**
 * True when `yamlText` declares a top-level `concurrency:` mapping whose
 * `group:` key equals `groupName`. Deliberately NOT a full YAML parse (see
 * module docstring): walks the indented block that follows a `concurrency:`
 * line and reads its `group:` entry the same way every workflow in this
 * group actually writes it (`group: jobs-data-pipeline`, unquoted).
 */
export function workflowDeclaresGroup(yamlText, groupName) {
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^concurrency:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent === 0) break; // block-mapping ended, back to top level
      const match = line.match(/^\s*group:\s*(.+?)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, '') === groupName;
    }
  }
  return false;
}

/**
 * Every workflow file whose `concurrency.group` is the literal
 * `jobs-data-pipeline` string. Mirrors the inventory check in
 * `tests/job-translation-queue.test.ts` so a new group member is observed
 * automatically instead of needing this file edited too.
 */
export function discoverJobsDataPipelineWorkflows(dir = WORKFLOWS_DIR) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(dir, name))
    .filter((workflowPath) => workflowDeclaresGroup(readFileSync(workflowPath, 'utf8'), JOBS_DATA_PIPELINE_GROUP));
}

function workflowFileName(workflowPath) {
  return workflowPath.split('/').pop();
}

/**
 * Current pending queue depth for the group: sum of `status=queued` runs
 * across every member workflow. `gh api` scopes the runs listing to one
 * workflow file at a time — there is no group-level endpoint — so the group
 * total is the sum over its members.
 */
export function measureQueueDepth(workflowPaths) {
  let depth = 0;
  const perWorkflow = [];
  for (const workflowPath of workflowPaths) {
    const file = workflowFileName(workflowPath);
    const data = ghJson(repoPath(`actions/workflows/${file}/runs?status=queued&per_page=100`));
    const count = Array.isArray(data?.workflow_runs) ? data.workflow_runs.length : 0;
    depth += count;
    perWorkflow.push({ file, count });
  }
  return { depth, perWorkflow };
}

/**
 * A run cancelled BEFORE any of its jobs ever started is the signature of
 * `queue: max` NOT being honoured: with `cancel-in-progress: false` declared,
 * a queued run is only supposed to wait, never be dropped. `job.started_at`
 * is null on a job that never left the queue — an ordinary failure/cancel
 * that at least started always carries a `started_at`.
 */
export function wasCancelledWhileQueued(job) {
  return job?.status === 'completed' && job?.conclusion === 'cancelled' && !job?.started_at;
}

function findCancelledWhileQueued(workflowPaths, cutoffMs) {
  const hits = [];
  for (const workflowPath of workflowPaths) {
    const file = workflowFileName(workflowPath);
    const data = ghJson(repoPath(`actions/workflows/${file}/runs?status=cancelled&per_page=50`));
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    for (const run of runs) {
      const observedAt = Date.parse(run.updated_at || run.created_at || '');
      if (Number.isFinite(observedAt) && observedAt < cutoffMs) continue;
      const jobsData = ghJson(repoPath(`actions/runs/${run.id}/jobs?per_page=100`));
      const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
      const queuedKills = jobs.filter(wasCancelledWhileQueued);
      if (queuedKills.length > 0) hits.push({ run, workflow: file, jobs: queuedKills });
    }
  }
  return hits;
}

export async function main() {
  const workflowPaths = discoverJobsDataPipelineWorkflows();
  console.log(
    `[monitor-jobs-pipeline-queue] group members: `
      + `${workflowPaths.map(workflowFileName).join(', ') || '(none found)'}`,
  );
  if (workflowPaths.length === 0) {
    console.log(
      '[monitor-jobs-pipeline-queue] no workflow declares the jobs-data-pipeline '
        + 'concurrency group — nothing to observe.',
    );
    return;
  }

  const { depth, perWorkflow } = measureQueueDepth(workflowPaths);
  console.log(
    `[monitor-jobs-pipeline-queue] queue depth: ${depth}/${QUEUE_CAP} `
      + `(${perWorkflow.map((w) => `${w.file}=${w.count}`).join(', ')})`,
  );

  const cutoffMs = Date.now() - CANCELLED_LOOKBACK_MINUTES * 60_000;
  const cancelledWhileQueued = findCancelledWhileQueued(workflowPaths, cutoffMs);

  if (cancelledWhileQueued.length > 0) {
    console.log(
      `[monitor-jobs-pipeline-queue] ALERT: ${cancelledWhileQueued.length} run(s) `
        + 'cancelled while queued',
    );
    const title = 'jobs-data-pipeline: run cancellata mentre era in coda — '
      + 'queue:max potrebbe non essere applicato dal piano';
    const body = [
      '## Run cancellate prima di partire',
      '',
      '`queue: max` con `cancel-in-progress: false` (PR #7035) non dovrebbe mai '
        + 'cancellare una run in coda — solo farla attendere fino al cap di 100. '
        + 'Una run cancellata da `queued` (nessun job mai avviato) è il segnale che '
        + 'il piano/contesto di questo repo non applica la feature per intero e '
        + 'degrada silenziosamente al vecchio limite di 1 run pending.',
      '',
      ...cancelledWhileQueued.map(
        ({ run, workflow, jobs }) => `- **${workflow}** ${run.html_url} — `
          + `${jobs.length} job cancellati mentre erano in coda`,
      ),
      '',
      'Rilevato da `scripts/monitor-jobs-pipeline-queue.mjs` (scan periodico).',
    ].join('\n');
    if (DRY_RUN) {
      console.log(`[monitor-jobs-pipeline-queue] (dry-run) would report "${title}"`);
    } else {
      await createGithubIssue({
        title,
        description: body,
        priority: 1,
        labels: ['Bug', 'ci-timeout'],
        workflow: 'jobs-pipeline-queue-monitor',
      });
    }
  } else {
    console.log('[monitor-jobs-pipeline-queue] no run cancelled-while-queued in the lookback window.');
  }

  if (depth >= SATURATION_WARN_THRESHOLD) {
    console.log(
      `[monitor-jobs-pipeline-queue] ALERT: queue depth ${depth} >= threshold ${SATURATION_WARN_THRESHOLD}`,
    );
    const title = `jobs-data-pipeline: coda in saturazione (${depth}/${QUEUE_CAP})`;
    const body = [
      '## Preallarme saturazione coda',
      '',
      `Profondità corrente della coda \`jobs-data-pipeline\`: **${depth}/${QUEUE_CAP}** `
        + `(soglia di preallarme: ${SATURATION_WARN_THRESHOLD}).`,
      '',
      ...perWorkflow.map((w) => `- ${w.file}: ${w.count} run in coda`),
      '',
      `Oltre il cap di ${QUEUE_CAP} le run vengono scartate silenziosamente, senza `
        + 'segnale operativo. Rilevato da `scripts/monitor-jobs-pipeline-queue.mjs`.',
    ].join('\n');
    if (DRY_RUN) {
      console.log(`[monitor-jobs-pipeline-queue] (dry-run) would report "${title}"`);
    } else {
      await createGithubIssue({
        title,
        description: body,
        priority: 2,
        labels: ['Bug'],
        workflow: 'jobs-pipeline-queue-monitor',
      });
    }
  } else {
    console.log('[monitor-jobs-pipeline-queue] queue depth below saturation threshold — no alert.');
  }
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('monitor-jobs-pipeline-queue.mjs')) {
  main().catch((err) => {
    console.error(`[monitor-jobs-pipeline-queue] fatal: ${err.message}`);
    process.exit(1);
  });
}
