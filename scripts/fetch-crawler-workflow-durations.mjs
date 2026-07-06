#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/fetch-crawler-workflow-durations.mjs
//
// Pulls recent successful-run durations for every .github/workflows/
// update-jobs-*.yml workflow via the GitHub REST API (bulk, per-workflow
// `runs?status=success` calls — NOT a single paginated `/actions/runs` scan,
// which would need to page through 140k+ repo-wide runs) and writes
// data/crawler-workflow-duration-baseline.json, the deterministic input
// scripts/generate-crawler-group-workflows.mjs bin-packs against (no GH API
// calls needed at generation time).
//
// Duration = updated_at - created_at for the most recent N successful runs
// per workflow, averaged. If a workflow has no successful run history, the
// generator falls back to the corpus median (this script just omits it from
// the output; loadDurationLookup() in the generator handles the fallback).
//
// Requires: `gh` CLI authenticated against the target repo.
// Usage: node scripts/fetch-crawler-workflow-durations.mjs
// Output: data/crawler-workflow-duration-baseline.json
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = path.resolve('.github/workflows');
const OUT_PATH = path.resolve('data/crawler-workflow-duration-baseline.json');
const RUNS_PER_WORKFLOW = 8;
const CONCURRENCY = 12;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

function getRepoSlug() {
  const out = sh('gh', ['repo', 'view', '--json', 'owner,name', '-q', '.owner.login + "/" + .name']);
  return out.trim();
}

function listCrawlerWorkflows(repoSlug) {
  const out = sh('gh', [
    'api',
    `repos/${repoSlug}/actions/workflows`,
    '--paginate',
    '-q',
    '.workflows[] | select(.path | test("update-jobs-.*\\\\.yml$")) | [.id, .name, .path] | @tsv',
  ]);
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, workflowPath] = line.split('\t');
      return { id, name, file: path.basename(workflowPath) };
    });
}

function fetchAvgDurationMs(repoSlug, workflowId) {
  const jq =
    '[.workflow_runs[] | ((.updated_at | fromdateiso8601) - (.created_at | fromdateiso8601))] | if length>0 then (add/length) else null end';
  const out = sh('gh', [
    'api',
    `repos/${repoSlug}/actions/workflows/${workflowId}/runs?status=success&per_page=${RUNS_PER_WORKFLOW}`,
    '-q',
    jq,
  ]).trim();
  if (out === 'null' || out === '') return null;
  const seconds = Number(out);
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000);
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function next() {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const repoSlug = getRepoSlug();
  console.log(`Repo: ${repoSlug}`);

  const workflows = listCrawlerWorkflows(repoSlug);
  console.log(`Found ${workflows.length} update-jobs-*.yml workflows registered with GitHub.`);

  if (workflows.length === 0) {
    console.error('No crawler workflows found via API — aborting (nothing to write).');
    process.exit(1);
  }

  const baseline = {};
  let fetched = 0;
  let missing = 0;

  await runPool(
    workflows,
    async (wf) => {
      let avgMs = null;
      try {
        avgMs = fetchAvgDurationMs(repoSlug, wf.id);
      } catch (error) {
        console.warn(`⚠️  ${wf.file}: API error — ${error.message}`);
      }
      if (avgMs === null) {
        missing += 1;
      } else {
        fetched += 1;
        baseline[wf.file] = {
          crawlerSlug: wf.file.replace(/^update-jobs-/, '').replace(/\.yml$/, ''),
          workflowId: wf.id,
          avgDurationMs: avgMs,
          sampleRuns: RUNS_PER_WORKFLOW,
        };
      }
    },
    CONCURRENCY
  );

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

  console.log(`✅ Wrote ${fetched} workflow durations -> ${path.relative('.', OUT_PATH)}`);
  if (missing > 0) {
    console.log(`ℹ️  ${missing} workflow(s) had no successful run history — generator will use corpus median as fallback.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
