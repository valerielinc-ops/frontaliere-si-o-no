import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/backfill-expired-from-history.yml', import.meta.url),
  'utf8',
);
const recoveryWorkflow = readFileSync(
  new URL('../.github/workflows/backfill-expired-from-history-recovery.yml', import.meta.url),
  'utf8',
);
const backfillRun = parseYaml(workflow).jobs.backfill.steps
  .find((step: { id?: string }) => step.id === 'backfill').run as string;
const progressRelativePath = '.github/backfill-expired-from-history-progress.tsv';

function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...extra,
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string; timeout?: number } = {},
) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function requireCommandSuccess(command: string, args: string[], cwd: string, env: Record<string, string>) {
  const result = runCommand(command, args, { cwd, env });
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed: ' + result.stderr);
  }
}

function runWorkflowHarness(options: {
  crawlerKeys?: string[];
  failCrawler?: string;
  interruptCrawler?: string;
  testGateExit?: number;
  checkpointBatchSize?: number;
  runBudgetSeconds?: number;
  crawlerDelaySeconds?: number;
} = {}) {
  const crawlerKeys = options.crawlerKeys ?? ['alpha'];
  const root = mkdtempSync(join(tmpdir(), 'backfill-workflow-harness-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const eventsPath = join(root, 'events.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(eventsPath, '');

  const setupEnv = isolatedEnv(home);
  const writeExecutable = (path: string, contents: string) => {
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  };
  const nodeShim = [
    '#!/bin/bash',
    'set -euo pipefail',
    'case "$1" in',
    '  scripts/ci/prefetch-history-blobs.mjs)',
    '    printf "%s\\n" "prefetch:$CRAWLER_KEYS" >> "$EVENT_LOG"',
    '    ;;',
    '  scripts/backfill-expired-from-history.mjs)',
    '    printf "%s\\n" "crawler:$CRAWLER_KEYS:start" >> "$EVENT_LOG"',
    '    if [ "$CRAWLER_KEYS" = "$INTERRUPT_CRAWLER" ]; then',
    '      mkdir -p data/jobs/expired/by-crawler',
    '      printf "%s\\n" "$CRAWLER_KEYS" > "data/jobs/expired/by-crawler/$CRAWLER_KEYS.json"',
    '      printf "%s\\n" "crawler:$CRAWLER_KEYS:interrupted" >> "$EVENT_LOG"',
    '      kill -TERM "$PPID"',
    '      exit 0',
    '    fi',
    '    if [ -n "${CRAWLER_DELAY_SECONDS:-}" ]; then sleep "$CRAWLER_DELAY_SECONDS"; fi',
    '    if [ "$CRAWLER_KEYS" = "$FAIL_CRAWLER" ]; then',
    '      printf "%s\\n" "crawler:$CRAWLER_KEYS:failed" >> "$EVENT_LOG"',
    '      exit 23',
    '    fi',
    '    mkdir -p data/jobs/expired/by-crawler',
    '    printf "%s\\n" "$CRAWLER_KEYS" > "data/jobs/expired/by-crawler/$CRAWLER_KEYS.json"',
    '    printf "%s\\n" "crawler:$CRAWLER_KEYS:complete" >> "$EVENT_LOG"',
    '    ;;',
    '  scripts/assemble-jobs-dataset.mjs)',
    '    printf "%s\\n" assemble >> "$EVENT_LOG"',
    '    ;;',
    '  scripts/audit-expired-at-parsable.mjs)',
    '    printf "%s\\n" audit >> "$EVENT_LOG"',
    '    ;;',
    '  *)',
    '    printf "%s\\n" "unexpected-node:$1" >> "$EVENT_LOG"',
    '    exit 97',
    '    ;;',
    'esac',
    '',
  ].join('\n');
  const ghShim = [
    '#!/bin/bash',
    'set -euo pipefail',
    'printf "dispatch:%s\\n" "$*" >> "$EVENT_LOG"',
    '',
  ].join('\n');
  const npmShim = [
    '#!/bin/bash',
    'set -euo pipefail',
    'printf "test:%s\\n" "$*" >> "$EVENT_LOG"',
    'exit "$TEST_GATE_EXIT"',
    '',
  ].join('\n');
  const commitShim = [
    '#!/bin/bash',
    'set -euo pipefail',
    'progress_path="$3"',
    'state="$(cut -f3 "$progress_path")"',
    'cursor="$(cut -f2 "$progress_path")"',
    'printf "push:%s:%s\\n" "$state" "$cursor" >> "$EVENT_LOG"',
    'git add -- data/jobs/expired/by-crawler "$progress_path"',
    'git commit -m "test: simulated backfill checkpoint" >/dev/null',
    'git push origin HEAD:main >/dev/null',
    'printf "has_changes=true\\n" >> "$GITHUB_OUTPUT"',
    '',
  ].join('\n');

  try {
    requireCommandSuccess('git', ['init', '--bare', remote], root, setupEnv);
    requireCommandSuccess('git', ['init', repo], root, setupEnv);
    requireCommandSuccess('git', ['-C', repo, 'checkout', '-b', 'main'], root, setupEnv);
    requireCommandSuccess('git', ['-C', repo, 'config', 'user.name', 'Backfill Harness'], root, setupEnv);
    requireCommandSuccess('git', ['-C', repo, 'config', 'user.email', 'backfill-test@example.invalid'], root, setupEnv);
    mkdirSync(join(repo, '.github'), { recursive: true });
    mkdirSync(join(repo, 'data/jobs/by-crawler'), { recursive: true });
    mkdirSync(join(repo, 'data/jobs/expired/by-crawler'), { recursive: true });
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    mkdirSync(join(repo, 'scripts/ci'), { recursive: true });
    for (const key of crawlerKeys) {
      writeFileSync(join(repo, 'data/jobs/by-crawler', key + '.json'), '[]\n');
    }
    writeFileSync(join(repo, 'data/jobs/expired/by-crawler/.gitkeep'), '');
    writeExecutable(join(repo, 'scripts/lib/git-commit-data.sh'), commitShim);
    writeExecutable(join(bin, 'node'), nodeShim);
    writeExecutable(join(bin, 'npm'), npmShim);
    writeExecutable(join(bin, 'gh'), ghShim);
    requireCommandSuccess('git', ['add', '--all'], repo, setupEnv);
    requireCommandSuccess('git', ['commit', '-m', 'test: initialize isolated backfill fixture'], repo, setupEnv);
    requireCommandSuccess('git', ['remote', 'add', 'origin', remote], repo, setupEnv);
    requireCommandSuccess('git', ['push', '-u', 'origin', 'main'], repo, setupEnv);

    const runEnv = isolatedEnv(home, {
      PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
      EVENT_LOG: eventsPath,
      RUNNER_TEMP: root,
      TMPDIR: root,
      DRY_RUN: '0',
      MAX_COMMITS: '0',
      CRAWLER_KEYS: crawlerKeys.join(','),
      HISTORY_SINCE: 'all',
      BACKFILL_PROGRESS_PATH: progressRelativePath,
      FAIL_CRAWLER: options.failCrawler ?? '',
      INTERRUPT_CRAWLER: options.interruptCrawler ?? '',
      TEST_GATE_EXIT: String(options.testGateExit ?? 0),
      BACKFILL_CHECKPOINT_BATCH_SIZE: String(options.checkpointBatchSize ?? 8),
      BACKFILL_RUN_BUDGET_SECONDS: String(options.runBudgetSeconds ?? 3600),
      CRAWLER_DELAY_SECONDS: String(options.crawlerDelaySeconds ?? 0),
      GITHUB_PAT: 'test-pat',
      GITHUB_REPOSITORY: 'owner/repository',
    });
    // GitHub's Ubuntu runner has Bash 5, while macOS /bin/bash 3.2 lacks
    // mapfile. This equivalent array read keeps the extracted workflow block
    // executable locally; the workflow's actual mapfile line remains asserted
    // by the contract test below.
    const portableRun = backfillRun.replace(
      'mapfile -t key_list <<< "$keys"',
      'key_list=()\nwhile IFS= read -r key; do key_list+=("$key"); done <<< "$keys"',
    );
    const result = runCommand('bash', ['-c', portableRun], {
      cwd: repo,
      env: runEnv,
      timeout: 15000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      events: readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean),
      progress: existsSync(join(repo, progressRelativePath))
        ? readFileSync(join(repo, progressRelativePath), 'utf8').trimEnd()
        : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectGatesBeforeEveryPush(events: string[]) {
  const pushIndexes = events.map((event, index) => event.startsWith('push:') ? index : -1)
    .filter((index) => index >= 0);
  expect(pushIndexes.length).toBeGreaterThan(0);
  let previousPush = -1;
  for (const pushIndex of pushIndexes) {
    const beforePush = events.slice(previousPush + 1, pushIndex);
    const assembleIndex = beforePush.indexOf('assemble');
    const testIndex = beforePush.indexOf('test:run test:backfill');
    const auditIndex = beforePush.indexOf('audit');
    expect(assembleIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex).toBeGreaterThan(assembleIndex);
    expect(auditIndex).toBeGreaterThan(testIndex);
    previousPush = pushIndex;
  }
}

function hashWorkset(keys: string[]) {
  const hashDir = mkdtempSync(join(tmpdir(), 'backfill-workset-hash-'));
  try {
    const result = runCommand('git', ['hash-object', '--stdin'], {
      cwd: hashDir,
      env: isolatedEnv(hashDir),
      input: keys.join('\n') + '\n',
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    rmSync(hashDir, { recursive: true, force: true });
  }
}

function progressLine(keys: string[], cursor: string, status: 'active' | 'complete') {
  return hashWorkset(keys) + '\t' + cursor + '\t' + status + '\n';
}

function resolveResumeState(progress: string, currentKeys: string[]) {
  const progressDir = mkdtempSync(join(tmpdir(), 'backfill-resume-'));
  const progressPath = join(progressDir, 'progress.tsv');
  const keys = currentKeys.join('\n');
  writeFileSync(progressPath, progress);

  try {
    const resumeStart = workflow.indexOf("          last_completed_key=''");
    const resumeEnd = workflow.indexOf('          checkpoint_count=0', resumeStart);
    expect(resumeStart).toBeGreaterThanOrEqual(0);
    expect(resumeEnd).toBeGreaterThan(resumeStart);
    const resumeBlock = workflow.slice(resumeStart, resumeEnd);
    const script = [
      'set -euo pipefail',
      'progress_path="$1"',
      'workset_hash="$2"',
      'keys="$3"',
      resumeBlock,
      'printf "__STATUS__=%s\\n" "$saved_status"',
      'printf "__CURSOR__=%s\\n" "$last_completed_key"',
      'printf "__KEYS__\\n%s\\n" "$keys"',
    ].join('\n');
    const result = runCommand('bash', [
      '-c',
      script,
      'backfill-resume-fixture',
      progressPath,
      hashWorkset(currentKeys),
      keys,
    ], { env: isolatedEnv(progressDir) });
    expect(result.status, result.stderr).toBe(0);

    const keysMarker = '__KEYS__\n';
    const keysAt = result.stdout.indexOf(keysMarker);
    expect(keysAt).toBeGreaterThanOrEqual(0);
    const metadata = result.stdout.slice(0, keysAt);
    const remainingKeys = result.stdout.slice(keysAt + keysMarker.length).trimEnd().split('\n').filter(Boolean);
    return {
      status: metadata.match(/^__STATUS__=(.*)$/m)?.[1],
      cursor: metadata.match(/^__CURSOR__=(.*)$/m)?.[1],
      remainingKeys,
      output: result.stdout,
    };
  } finally {
    rmSync(progressDir, { recursive: true, force: true });
  }
}

describe('backfill-expired-from-history.yml — durable checkpoints', () => {
  it('keeps full commit/tree history and prefetches each bounded crawler batch before its walk', () => {
    const checkoutStart = workflow.indexOf('- name: Checkout (full commit/tree history — slice blobs prefetched per batch below)');
    const setupStart = workflow.indexOf('- name: Setup Node.js');
    const walkStart = workflow.indexOf('- name: Recover dropped jobs and repair active firstSeenAt metadata (checkpointed batches)');
    const checkoutBlock = workflow.slice(checkoutStart, setupStart);
    const prefetchAt = workflow.indexOf('CRAWLER_KEYS="$batch_crawler_keys" node scripts/ci/prefetch-history-blobs.mjs');
    const walkAt = workflow.indexOf('CRAWLER_KEYS="$key" node scripts/backfill-expired-from-history.mjs');

    expect(checkoutStart).toBeGreaterThanOrEqual(0);
    expect(setupStart).toBeGreaterThan(checkoutStart);
    expect(walkStart).toBeGreaterThan(setupStart);
    expect(checkoutBlock).toContain('fetch-depth: 0');
    expect(checkoutBlock).toContain('filter: blob:none');
    expect(prefetchAt).toBeGreaterThan(walkStart);
    expect(walkAt).toBeGreaterThan(prefetchAt);
    expect(workflow).toContain('batch_keys=("${key_list[@]:batch_start:checkpoint_batch_size}")');
    expect(workflow).toContain('batch_crawler_keys');
    expect(workflow).toContain("HISTORY_SINCE: ${{ inputs.history_since || '45 days ago' }}");
  });

  it('gives the full active-plus-expired assembly an explicit heap ceiling', () => {
    const backfillStart = workflow.indexOf('  backfill:');
    const stepsStart = workflow.indexOf('    steps:', backfillStart);

    expect(backfillStart).toBeGreaterThanOrEqual(0);
    expect(stepsStart).toBeGreaterThan(backfillStart);
    expect(workflow.slice(backfillStart, stepsStart))
      .toContain("NODE_OPTIONS: '--max-old-space-size=8192'");
  });

  it('processes one crawler at a time and checkpoints partial batches', () => {
    const backfillStart = workflow.indexOf('- name: Recover dropped jobs and repair active firstSeenAt metadata (checkpointed batches)');
    const reassembleStart = workflow.indexOf('- name: Reassemble dataset');
    const block = workflow.slice(backfillStart, reassembleStart);

    expect(backfillStart).toBeGreaterThanOrEqual(0);
    expect(reassembleStart).toBeGreaterThan(backfillStart);
    expect(block).toContain("if: inputs.dry_run != true && inputs.dry_run != 'true'");
    expect(block).toContain('BACKFILL_CHECKPOINT_BATCH_SIZE');
    expect(block).toContain("BACKFILL_CHECKPOINT_BATCH_SIZE: '8'");
    expect(block).toContain('checkpoint_batch_size="${BACKFILL_CHECKPOINT_BATCH_SIZE:-8}"');
    expect(block).toContain("BACKFILL_RUN_BUDGET_SECONDS: '3600'");
    expect(block).toContain('run_budget_seconds="${BACKFILL_RUN_BUDGET_SECONDS:-3600}"');
    expect(block).toContain('continuation_required=0');
    expect(block).toContain('GITHUB_PAT');
    expect(block).toContain('actions/workflows/backfill-expired-from-history.yml/dispatches');
    expect(block).toContain('inputs[max_commits]');
    expect(block).toContain('inputs[crawler_keys]');
    expect(block).toContain('inputs[history_since]');
    expect(block).toContain('elapsed_seconds=');
    expect(block).toContain('crawlers=${checkpoint_count}');
    expect(workflow).not.toContain('human_approval:');
    expect(workflow).not.toContain('human-side-effect-gate.mjs');
    expect(block).toContain('CRAWLER_KEYS="$key" node scripts/backfill-expired-from-history.mjs');
    expect(block).toContain('trap on_exit EXIT');
    expect(block).toContain("trap 'on_signal 143' TERM");
    expect(block).toContain("trap 'on_signal 130' INT");
    expect(block).toContain('backfill-expired-from-history-progress.tsv');
    expect(block).toContain('last_completed_key');
    expect(block).toContain('workset_hash');
    expect(block.split('[ "$checkpoint_count" -gt 0 ] || has_dirty_checkpoint').length - 1).toBe(2);
    expect(block).toContain('checkpoint_cursor="${last_completed_key:--}"');
    expect(block).toContain('"$saved_last" != \'-\'');
    expect(block).toContain('checkpoint 1');
    expect(block).toContain('has_dirty_checkpoint');
    const checkpointOutputGuardStart = block.indexOf('checkpoint_dirty=0');
    const checkpointOutputGuardEnd = block.indexOf('rm -f "$checkpoint_output"', checkpointOutputGuardStart);
    const checkpointOutputGuard = block.slice(checkpointOutputGuardStart, checkpointOutputGuardEnd);
    expect(checkpointOutputGuard).toContain('if has_dirty_checkpoint; then');
    expect(checkpointOutputGuard).not.toContain('if has_dirty_slices; then');
    expect(block).toContain('data/jobs/by-crawler data/jobs/expired/by-crawler');
    expect(block).toContain('grep . >/dev/null');
    expect(block).not.toContain('rg -q');
    expect(block).toContain('node scripts/assemble-jobs-dataset.mjs');
    expect(block).toContain('npm run test:backfill');
    expect(block).toContain('node scripts/audit-expired-at-parsable.mjs');
    expect(block).toContain('GITHUB_OUTPUT="$checkpoint_output"');
    expect(block).toContain('git-commit-data.sh --slice-only');
    expect(block).toContain("^has_changes=true$");
    expect(block).toContain("^has_changes=false$");
    expect(block).toContain('git reset --hard origin/main');
    expect(block).toContain('mapfile -t key_list <<< "$keys"');
    expect(block).toContain('for key in "${batch_keys[@]}"; do');
    expect(block).toContain('CRAWLER_KEYS="$batch_crawler_keys" node scripts/ci/prefetch-history-blobs.mjs');
    expect(block).toContain('batch_size="${#batch_keys[@]}"');
    expect(block).toContain('checkpoint history backfill slices');
    expect(block.indexOf('npm run test:backfill')).toBeLessThan(block.indexOf('git-commit-data.sh --slice-only'));
  });

  it('resumes an active cursor, restarts complete worksets, and resets a changed active workset', () => {
    const originalKeys = ['assura-ch', 'atec-personal', 'atena'];
    const active = resolveResumeState(progressLine(originalKeys, 'assura-ch', 'active'), originalKeys);
    const complete = resolveResumeState(progressLine(originalKeys, 'assura-ch', 'complete'), originalKeys);

    expect(active.status).toBe('active');
    expect(active.cursor).toBe('assura-ch');
    expect(active.remainingKeys).toEqual(['atec-personal', 'atena']);
    expect(active.output).toContain('Resuming after durable crawler checkpoint: assura-ch');

    expect(complete.status).toBe('complete');
    expect(complete.cursor).toBe('');
    expect(complete.remainingKeys).toEqual(originalKeys);
    expect(complete.output).toContain('Previous crawler workset completed; starting a fresh pass.');

    const changedKeys = ['assura-ch', 'atena', 'new-crawler'];
    const changed = resolveResumeState(progressLine(originalKeys, 'assura-ch', 'active'), changedKeys);
    expect(changed.status).toBe('active');
    expect(changed.cursor).toBe('');
    expect(changed.remainingKeys).toEqual(changedKeys);
    expect(changed.output).toContain('Crawler workset changed; starting a fresh cursor.');
    expect(changed.output).not.toContain('Resuming after durable crawler checkpoint');
  });

  it('keeps a failed test gate non-zero and does not push a checkpoint', () => {
    const result = runWorkflowHarness({ testGateExit: 17 });

    expect(result.status).not.toBe(0);
    expect(result.events, 'status=' + result.status + '\n' + result.stdout + result.stderr).toContain('crawler:alpha:complete');
    expect(result.events).toContain('assemble');
    expect(result.events).toContain('test:run test:backfill');
    expect(result.events).not.toContain('audit');
    expect(result.events.some((event) => event.startsWith('push:'))).toBe(false);
    expect(result.progress.split('\t')).toHaveLength(3);
    expect(result.progress.split('\t')[1]).toBe('alpha');
    expect(result.progress.split('\t')[2]).toBe('active');
  });

  it('runs gates before checkpoint pushes and advances the cursor for one completed crawler', () => {
    const result = runWorkflowHarness();

    expect(result.status).toBe(0);
    expect(result.events).toContain('crawler:alpha:complete');
    expect(result.events.indexOf('crawler:alpha:complete')).toBeLessThan(result.events.indexOf('push:active:alpha'));
    expectGatesBeforeEveryPush(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual([
      'push:active:alpha',
      'push:complete:alpha',
    ]);
    expect(new Set(result.events.filter((event) => event.startsWith('push:')).map((event) => event.split(':')[2])))
      .toEqual(new Set(['alpha']));
    expect(result.progress.split('\t')).toEqual([hashWorkset(['alpha']), 'alpha', 'complete']);
  });

  it('queues the remaining workset after a bounded run budget', () => {
    const result = runWorkflowHarness({
      crawlerKeys: ['alpha', 'beta'],
      checkpointBatchSize: 1,
      runBudgetSeconds: 1,
      crawlerDelaySeconds: 2,
    });

    expect(result.status).toBe(0);
    expect(result.events).toContain('crawler:alpha:complete');
    expect(result.events).not.toContain('crawler:beta:complete');
    expect(result.events).toContain('push:active:alpha');
    expect(result.events.some((event) => event.startsWith('dispatch:'))).toBe(true);
    expect(result.progress.split('\t')).toEqual([hashWorkset(['alpha', 'beta']), 'alpha', 'active']);
    expect(result.stdout).toContain('queueing the remaining crawler workset');
  });

  it('checkpoints prior crawler output after a later crawler errors and keeps the run failed', () => {
    const result = runWorkflowHarness({ crawlerKeys: ['alpha', 'beta'], failCrawler: 'beta' });

    expect(result.status).not.toBe(0);
    expect(result.events.indexOf('crawler:beta:failed')).toBeLessThan(result.events.indexOf('push:active:alpha'));
    expectGatesBeforeEveryPush(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual(['push:active:alpha']);
    expect(result.progress.split('\t')).toEqual([hashWorkset(['alpha', 'beta']), 'alpha', 'active']);
  });

  it('attempts one active checkpoint on SIGTERM during a crawler batch and exits non-zero', () => {
    const result = runWorkflowHarness({ interruptCrawler: 'alpha' });

    expect(result.status).not.toBe(0);
    expect(result.events).toContain('crawler:alpha:interrupted');
    expectGatesBeforeEveryPush(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual(['push:active:-']);
    expect(result.progress.split('\t')).toEqual([hashWorkset(['alpha']), '-', 'active']);
  });

  it('riavvia automaticamente solo la run fallita/cancellata e con un tetto di tentativi', () => {
    expect(recoveryWorkflow).toContain('workflow_run:');
    expect(recoveryWorkflow).toContain('Backfill Expired Jobs From History');
    expect(recoveryWorkflow).toContain("github.event.workflow_run.path == '.github/workflows/backfill-expired-from-history.yml'");
    expect(recoveryWorkflow).toContain("github.event.workflow_run.run_attempt < 3");
    expect(recoveryWorkflow).toContain('reRunWorkflow');
  });

  it('deploys after a successful rerun even when the checkpoint is already on main', () => {
    const deployStart = workflow.indexOf('- name: Record self-driven deploy handoff after validated backfill');
    const deployBlock = workflow.slice(deployStart);

    expect(deployStart).toBeGreaterThanOrEqual(0);
    expect(deployBlock).toContain("steps.backfill.outcome == 'success'");
    expect(deployBlock).toContain("steps.backfill_tests.outcome == 'success'");
    const deployCondition = deployBlock.split('\n').find((line) => line.trimStart().startsWith('if:')) ?? '';
    expect(deployCondition).not.toContain('has_changes');
  });
});
