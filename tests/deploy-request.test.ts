import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  decideLatestDeploy,
  changedFilesRequiringDeploy,
  COMPARE_FILES_PROJECTION,
  DEFAULT_MAX_BUILDS_PER_SHA,
  DEPLOY_RUNS_PROJECTION,
  MAX_DURABLE_RETRY_ATTEMPTS,
} from '../scripts/ci/request-latest-deploy.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const done = (id: number, headSha: string, conclusion: string) => ({
  id,
  headSha,
  status: 'completed',
  conclusion,
});
const live = (id: number, status: string) => ({ id, headSha: HEAD, status, conclusion: null });

describe('decideLatestDeploy', () => {
  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('waits while a build is %s', (status) => {
    expect(decideLatestDeploy({ headSha: HEAD, runs: [live(1, status)] })).toMatchObject({
      action: 'skip',
      reason: 'pipeline-moving',
    });
  });

  it('dispatches the current tip after a burst superseded older commits', () => {
    expect(decideLatestDeploy({
      headSha: HEAD,
      runs: [done(1, OLD, 'cancelled'), done(2, OLD, 'cancelled')],
    })).toMatchObject({ action: 'dispatch', reason: 'pipeline-idle', headSha: HEAD });
  });

  it('does not rebuild a tip that already completed successfully', () => {
    expect(decideLatestDeploy({ headSha: HEAD, runs: [done(1, HEAD, 'success')] })).toMatchObject({
      action: 'skip',
      reason: 'head-already-built',
    });
  });

  it('gives a newer tip a fresh attempt budget', () => {
    const failedHead = [done(1, HEAD, 'failure'), done(2, HEAD, 'failure')];
    expect(decideLatestDeploy({ headSha: HEAD, runs: failedHead }).reason).toBe('attempt-cap');
    expect(decideLatestDeploy({ headSha: OLD, runs: failedHead }).action).toBe('dispatch');
  });

  it('fails closed when the current tip cannot be resolved', () => {
    expect(decideLatestDeploy({ headSha: '', runs: [] })).toMatchObject({
      action: 'skip',
      reason: 'no-head-sha',
    });
    expect(DEFAULT_MAX_BUILDS_PER_SHA).toBe(2);
  });

  it('re-applies the push denylist to workflow_run compare paths', () => {
    const ignored = [
      'data/border-wait-current.json',
      'data/translation-stats-history.json',
      'docs/operations.md',
    ];
    expect(changedFilesRequiringDeploy(ignored, [
      'data/border-wait-current.json',
      'data/translation-stats-history.json',
      'docs/**',
    ])).toEqual([]);
    expect(changedFilesRequiringDeploy([...ignored, 'components/App.tsx'], [
      'data/border-wait-current.json',
      'data/translation-stats-history.json',
      'docs/**',
    ])).toEqual(['components/App.tsx']);
  });
});

describe('deploy-request.yml contract', () => {
  const requestPath = resolve('.github/workflows/deploy-request.yml');
  const deployPath = resolve('.github/workflows/deploy.yml');
  const request = readFileSync(requestPath, 'utf8');
  const deploy = readFileSync(deployPath, 'utf8');

  it('keeps the expensive build dispatch-only', () => {
    const on = (YAML.parse(deploy) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on)).not.toContain('push');
    expect(Object.keys(on)).toContain('workflow_dispatch');
    expect(deploy).toContain('group: pages-build-run');
    expect(deploy).toMatch(/cancel-in-progress:\s*false/);
  });

  it('owns push and completion events in the cheap request workflow', () => {
    const on = (YAML.parse(request) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on)).toEqual(expect.arrayContaining(['push', 'workflow_run', 'workflow_dispatch']));
    expect(request).toContain('paths-ignore:');
    expect(request).toContain('scripts/ci/request-latest-deploy.mjs');
    expect(request).toContain('scripts/ci/mint-app-token.mjs');
    expect(request).toContain('/functions/src/githubApiHeaders.js');
    expect(request).toContain('APP_TOKEN_ACTIONS:-false');
    expect(request).toMatch(/actions:\s*write/);
    expect(request).toContain("cron: '*/5 * * * *'");
    expect(request).toContain('retry_head_sha');
    expect(request).toContain('DEPLOY_BUILT_SHA');
    expect(request).toContain('scripts/check-pages-publish-lag.mjs');
  });

  it('keeps durable self-retries bounded and visible when an API mutation fails', () => {
    const source = readFileSync(resolve('scripts/ci/request-latest-deploy.mjs'), 'utf8');
    expect(MAX_DURABLE_RETRY_ATTEMPTS).toBe(3);
    expect(source).toContain('queueDurableRetry');
    expect(source).toContain('deploy-queue-read-failed');
    expect(source).toContain('deploy-dispatch-failed');
    expect(source).toContain('return 1;');
  });

  it('does not introduce a second production build lock', () => {
    expect(request).toContain('group: deploy-request-dispatcher');
    expect(request).toContain('cancel-in-progress: false');
    expect(request).not.toMatch(/group:\s*pages-build-run/);
  });
});

// ── The shell around the decision: what `gh` hands back (issue 12308) ────────
// execFileSync stops reading a child at `maxBuffer`, 1 MiB by default, and
// throws ENOBUFS. The raw listing of 60 deploy runs is larger than that.
const DEFAULT_EXEC_BUFFER_BYTES = 1024 * 1024;
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RawRun = { id: number; head_sha: string; status: string; conclusion: string | null };

/** The sparse-checkout list of the dispatcher job, as repository-relative paths. */
function dispatcherCheckoutPaths(): string[] {
  const workflow = YAML.parse(readFileSync(resolve('.github/workflows/deploy-request.yml'), 'utf8')) as {
    jobs: { request: { steps: { uses?: string; with?: Record<string, string> }[] } };
  };
  const checkout = workflow.jobs.request.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const patterns = String(checkout?.with?.['sparse-checkout'] ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  expect(patterns.length).toBeGreaterThan(0);
  // Exact files only: a glob in this list needs a real matcher here first.
  for (const pattern of patterns) expect(pattern, pattern).toMatch(/^\/[\w./-]+$/);
  return patterns.map((pattern) => pattern.slice(1));
}

/**
 * What the dispatcher job has on disk: the files of its sparse checkout, and
 * nothing else. No node_modules either, as on the runner, where the job
 * installs none.
 */
function dispatcherCheckout(): string {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-request-checkout-'));
  temporary.push(directory);
  for (const relative of dispatcherCheckoutPaths()) {
    mkdirSync(dirname(join(directory, relative)), { recursive: true });
    copyFileSync(resolve(relative), join(directory, relative));
  }
  return directory;
}

/**
 * Runs the real script against a `gh` that answers like the REST API: whole
 * objects padded to a realistic size unless the caller asks for a projection,
 * which it then applies as `gh --jq` would. The script runs where the job
 * runs it, in the dispatcher's checkout: from the repository root it would
 * find files the job never has (issue 12344).
 */
function requestDeploy({ runs, compareFiles = [], env = {} }: {
  runs: RawRun[];
  compareFiles?: string[];
  env?: Record<string, string>;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-request-'));
  temporary.push(directory);
  const log = join(directory, 'gh.log');
  writeFileSync(log, '');
  // A run object of the REST API is about 18 kB, a compare file with its patch easily more.
  const padding = 'x'.repeat(20_000);
  const rawRuns = { total_count: runs.length, workflow_runs: runs.map((run) => ({ ...run, repository: { description: padding } })) };
  const rawCompare = { files: compareFiles.map((filename) => ({ filename, patch: padding })) };
  writeFileSync(join(directory, 'runs.json'), JSON.stringify(rawRuns));
  writeFileSync(join(directory, 'compare.json'), JSON.stringify(rawCompare));
  const gh = join(directory, 'gh');
  writeFileSync(gh, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] !== 'api') process.exit(0);",
    "const at = args.indexOf('--jq');",
    'const projection = at === -1 ? null : args[at + 1];',
    "const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));",
    "const answer = (value) => { process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\\n'); process.exit(0); };",
    "const unknown = () => { process.stderr.write('fake gh: no such projection: ' + projection + '\\n'); process.exit(1); };",
    "if (args[1].includes('/commits/')) answer(projection === '.sha' ? process.env.FAKE_HEAD_SHA : { sha: process.env.FAKE_HEAD_SHA });",
    "if (args[1].includes('/actions/workflows/')) {",
    "  const raw = read('runs.json');",
    '  if (projection === null) answer(raw);',
    `  if (projection !== ${JSON.stringify(DEPLOY_RUNS_PROJECTION)}) unknown();`,
    '  answer(raw.workflow_runs.map((run) => ({ id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion })));',
    '}',
    "if (args[1].includes('/compare/')) {",
    "  const raw = read('compare.json');",
    '  if (projection === null) answer(raw);',
    `  if (projection !== ${JSON.stringify(COMPARE_FILES_PROJECTION)}) unknown();`,
    '  answer({ files: raw.files.map((file) => file.filename), count: raw.files.length });',
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));
  chmodSync(gh, 0o755);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEPLOY_') && key !== 'GITHUB_STEP_SUMMARY'));
  const result = spawnSync(process.execPath, ['scripts/ci/request-latest-deploy.mjs'], {
    cwd: dispatcherCheckout(),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...cleanEnv,
      PATH: `${directory}${delimiter}${process.env.PATH || ''}`,
      GITHUB_REPOSITORY: 'fixture/site',
      FAKE_HEAD_SHA: HEAD,
      ...env,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    rawRunsBytes: Buffer.byteLength(JSON.stringify(rawRuns)),
    rawCompareBytes: Buffer.byteLength(JSON.stringify(rawCompare)),
  };
}

const rawDone = (id: number, headSha: string, conclusion: string): RawRun => ({ id, head_sha: headSha, status: 'completed', conclusion });
// The page the script asks for: 60 runs, none of them for the current tip.
const sixtyOldRuns = () => Array.from({ length: 60 }, (_, index) => rawDone(index + 1, OLD, index % 2 ? 'cancelled' : 'success'));

describe('the deploy request reads a queue larger than a pipe buffer', () => {
  it('dispatches one build when the raw listing would not fit the default buffer', () => {
    const run = requestDeploy({ runs: sixtyOldRuns() });
    expect(run.rawRunsBytes).toBeGreaterThan(DEFAULT_EXEC_BUFFER_BYTES);
    expect(run.output).not.toContain('deploy-queue-read-failed');
    expect(run.output).toContain(`head=${HEAD} runs=60 → dispatch (pipeline-idle)`);
    expect(run.status, run.output).toBe(0);
    expect(run.calls).toContainEqual(['workflow', 'run', 'deploy.yml', '--repo', 'fixture/site', '--ref', 'main']);
    // No durable retry was needed: the only dispatch is the build itself.
    expect(run.calls.filter((call) => call[0] === 'workflow')).toHaveLength(1);
  });

  it('still sees the live build in that listing and waits for it', () => {
    const runs = sixtyOldRuns();
    runs[37] = { id: 999, head_sha: OLD, status: 'in_progress', conclusion: null };
    const run = requestDeploy({ runs });
    expect(run.rawRunsBytes).toBeGreaterThan(DEFAULT_EXEC_BUFFER_BYTES);
    expect(run.output).toContain('→ skip (pipeline-moving)');
    expect(run.status, run.output).toBe(0);
    expect(run.calls.filter((call) => call[0] === 'workflow')).toHaveLength(0);
  });

  it('reads a compare whose patches would not fit either, and skips a data-only completion', () => {
    const compareFiles = Array.from({ length: 80 }, (_, index) => `data/build-history/2026-10-08-${index}.json`);
    const run = requestDeploy({
      runs: [rawDone(1, OLD, 'success')],
      compareFiles,
      env: { DEPLOY_EVENT_NAME: 'workflow_run', DEPLOY_BUILT_SHA: OLD },
    });
    expect(run.rawCompareBytes).toBeGreaterThan(DEFAULT_EXEC_BUFFER_BYTES);
    expect(run.output).not.toContain('workflow-run-path-compare-failed');
    expect(run.output).toContain('→ skip (workflow-run-ignored-only)');
    expect(run.status, run.output).toBe(0);
    expect(run.calls.filter((call) => call[0] === 'workflow')).toHaveLength(0);
  });

  it('re-arms conservatively when the compare reached the 300-file cap', () => {
    const compareFiles = Array.from({ length: 300 }, (_, index) => `data/build-history/2026-10-08-${index}.json`);
    const run = requestDeploy({
      runs: [rawDone(1, OLD, 'success')],
      compareFiles,
      env: { DEPLOY_EVENT_NAME: 'workflow_run', DEPLOY_BUILT_SHA: OLD },
    });
    expect(run.output).toContain('300-file cap');
    expect(run.output).toContain('→ dispatch (pipeline-idle)');
    expect(run.status, run.output).toBe(0);
  });

  it('never reads a REST answer without a projection', () => {
    const source = readFileSync(resolve('scripts/ci/request-latest-deploy.mjs'), 'utf8');
    // One place builds an `api` call, and it cannot be reached without a filter.
    expect(source.match(/'api'/g)).toHaveLength(1);
    expect(source).toContain("return gh(['api', path, '--jq', projection]);");
    expect(source).toMatch(/throw new Error\(`a --jq projection is required to read \$\{path\}`\)/);
    expect(source).toMatch(/maxBuffer: GH_MAX_BUFFER_BYTES/);
  });
});
