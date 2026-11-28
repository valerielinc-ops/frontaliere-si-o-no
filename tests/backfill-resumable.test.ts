import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';

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
  // Crawler whose stub exits 3: the script's "slice refused" status.
  refuseCrawler?: string;
  interruptCrawler?: string;
  testGateExit?: number;
  checkpointBatchSize?: number;
  runBudgetSeconds?: number;
  crawlerDelaySeconds?: number;
  // Tracked files committed before the run.
  seedFiles?: Record<string, string>;
  // ES module run by the `assemble-jobs-dataset.mjs` stub, cwd = the fixture.
  assembleModule?: string;
  // Paths read back from the remote `main` once the run is over.
  readFromRemote?: string[];
} = {}) {
  const crawlerKeys = options.crawlerKeys ?? ['alpha'];
  const root = mkdtempSync(join(tmpdir(), 'backfill-workflow-harness-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const eventsPath = join(root, 'events.log');
  const githubOutputPath = join(root, 'github-output');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(eventsPath, '');
  writeFileSync(githubOutputPath, '');

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
    '    if [ "$CRAWLER_KEYS" = "${REFUSE_CRAWLER:-}" ]; then',
    '      printf "%s\\n" "crawler:$CRAWLER_KEYS:refused" >> "$EVENT_LOG"',
    '      exit 3',
    '    fi',
    '    if [ "$CRAWLER_KEYS" = "$FAIL_CRAWLER" ]; then',
    '      printf "%s\\n" "crawler:$CRAWLER_KEYS:failed" >> "$EVENT_LOG"',
    '      exit 23',
    '    fi',
    '    mkdir -p data/jobs/expired/by-crawler',
    '    printf "%s\\n" "$CRAWLER_KEYS" > "data/jobs/expired/by-crawler/$CRAWLER_KEYS.json"',
    '    printf "%s\\n" "crawler:$CRAWLER_KEYS:complete" >> "$EVENT_LOG"',
    '    ;;',
    '  scripts/ci/validate-backfill-checkpoint.mjs)',
    '    printf "%s\\n" validate >> "$EVENT_LOG"',
    '    ;;',
    '  scripts/assemble-jobs-dataset.mjs)',
    '    printf "%s\\n" assemble >> "$EVENT_LOG"',
    '    if [ -n "${ASSEMBLE_MODULE:-}" ]; then "$REAL_NODE" "$ASSEMBLE_MODULE"; fi',
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
    // Same scope contract as the real helper: --slice-only sweeps every
    // dirty slice, --extra-only publishes the named paths and nothing else.
    'if [ "$1" = "--slice-only" ]; then git add -A -- data/jobs/by-crawler data/jobs/expired/by-crawler; fi',
    'git add -- "$progress_path"',
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
    for (const [path, contents] of Object.entries(options.seedFiles ?? {})) {
      writeFileSync(join(repo, path), contents);
    }
    const assembleModulePath = join(root, 'assemble-stub.mjs');
    if (options.assembleModule) writeFileSync(assembleModulePath, options.assembleModule);
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
      REFUSE_CRAWLER: options.refuseCrawler ?? '',
      INTERRUPT_CRAWLER: options.interruptCrawler ?? '',
      TEST_GATE_EXIT: String(options.testGateExit ?? 0),
      BACKFILL_CHECKPOINT_BATCH_SIZE: String(options.checkpointBatchSize ?? 8),
      BACKFILL_RUN_BUDGET_SECONDS: String(options.runBudgetSeconds ?? 3600),
      CRAWLER_DELAY_SECONDS: String(options.crawlerDelaySeconds ?? 0),
      GITHUB_PAT: 'test-pat',
      GITHUB_REPOSITORY: 'owner/repository',
      GITHUB_OUTPUT: githubOutputPath,
      REAL_NODE: process.execPath,
      ASSEMBLE_MODULE: options.assembleModule ? assembleModulePath : '',
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
      timeout: options.assembleModule ? 90000 : 15000,
    });
    const remoteFiles = Object.fromEntries((options.readFromRemote ?? []).map((path) => {
      const shown = runCommand('git', ['--git-dir', remote, 'show', 'main:' + path], { env: setupEnv });
      return [path, shown.status === 0 ? shown.stdout : null] as const;
    }));
    return {
      remoteFiles,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      events: readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean),
      outputs: readFileSync(githubOutputPath, 'utf8').trim().split('\n').filter(Boolean),
      progress: existsSync(join(repo, progressRelativePath))
        ? readFileSync(join(repo, progressRelativePath), 'utf8').trimEnd()
        : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectCheckpointGates(events: string[]) {
  const pushIndexes = events.map((event, index) => event.startsWith('push:') ? index : -1)
    .filter((index) => index >= 0);
  expect(pushIndexes.length).toBeGreaterThan(0);
  let previousPush = -1;
  for (const pushIndex of pushIndexes) {
    const beforePush = events.slice(previousPush + 1, pushIndex);
    const validateIndex = beforePush.indexOf('validate');
    const auditIndex = beforePush.indexOf('audit');
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    const state = events[pushIndex].split(':')[1];
    if (state === 'complete') {
      const assembleIndex = beforePush.indexOf('assemble');
      const testIndex = beforePush.indexOf('test:run test:backfill');
      expect(auditIndex).toBeGreaterThan(testIndex);
      expect(assembleIndex).toBeGreaterThan(validateIndex);
      expect(testIndex).toBeGreaterThan(assembleIndex);
    } else {
      expect(auditIndex).toBe(-1);
      expect(beforePush).not.toContain('assemble');
      expect(beforePush).not.toContain('test:run test:backfill');
    }
    previousPush = pushIndex;
  }
}

function hashText(input: string) {
  const hashDir = mkdtempSync(join(tmpdir(), 'backfill-workset-hash-'));
  try {
    const result = runCommand('git', ['hash-object', '--stdin'], {
      cwd: hashDir,
      env: isolatedEnv(hashDir),
      input,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    rmSync(hashDir, { recursive: true, force: true });
  }
}

function hashWorkset(
  keys: string[],
  {
    maxCommits = '0',
    historySince = 'all',
    resolvedHistorySince = historySince,
  }: { maxCommits?: string; historySince?: string; resolvedHistorySince?: string } = {},
) {
  return hashText([
    'history-backfill-scope-v3',
    `max_commits=${maxCommits}`,
    `history_since_input=${historySince}`,
    `history_since_resolved=${resolvedHistorySince}`,
    'keys:',
    keys.join('\n'),
    '',
  ].join('\n'));
}

function progressLine(
  keys: string[],
  cursor: string,
  status: 'active' | 'complete',
  scope: { maxCommits?: string; historySince?: string; resolvedHistorySince?: string } = {},
) {
  const requestScopeHash = hashText([
    'history-backfill-scope-v3',
    `max_commits=${scope.maxCommits ?? '0'}`,
    `history_since_input=${scope.historySince ?? 'all'}`,
    'keys:',
    keys.join('\n'),
    '',
  ].join('\n'));
  return hashWorkset(keys, scope) + '\t' + cursor + '\t' + status + '\t'
    + requestScopeHash + '\t' + (scope.resolvedHistorySince ?? scope.historySince ?? 'all') + '\n';
}

function resolveResumeState(
  progress: string,
  currentKeys: string[],
  { historySince = 'all', resolvedHistorySince = historySince }:
  { historySince?: string; resolvedHistorySince?: string } = {},
) {
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
      'request_scope_hash="$4"',
      'backfill_scope_version="history-backfill-scope-v3"',
      'backfill_max_commits="0"',
      `backfill_history_input=${JSON.stringify(historySince)}`,
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
      hashWorkset(currentKeys, { historySince, resolvedHistorySince }),
      keys,
      hashText([
        'history-backfill-scope-v3',
        'max_commits=0',
        `history_since_input=${historySince}`,
        'keys:',
        keys,
        '',
      ].join('\n')),
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
    const handoffStart = workflow.indexOf('- name: Record self-driven deploy handoff after validated backfill');
    const block = workflow.slice(backfillStart, handoffStart);

    expect(backfillStart).toBeGreaterThanOrEqual(0);
    expect(handoffStart).toBeGreaterThan(backfillStart);
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
    expect(block).toContain("backfill_scope_version='history-backfill-scope-v3'");
    expect(block).toContain('backfill_max_commits="${MAX_COMMITS:-0}"');
    expect(block).toContain('backfill_history_input="${HISTORY_SINCE:-45 days ago}"');
    expect(block).toContain('history_since_resolved');
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
    expect(block).toContain('node scripts/ci/validate-backfill-checkpoint.mjs');
    expect(block).toContain('node scripts/audit-expired-at-parsable.mjs');
    expect(block).toContain('node scripts/assemble-jobs-dataset.mjs');
    expect(block).toContain('npm run test:backfill');
    expect(block).toContain('checkpoint_status=\'complete\'');
    expect(block).toContain('GITHUB_OUTPUT="$checkpoint_output"');
    expect(block).toContain("commit_scope='--slice-only'");
    expect(block).toContain("^has_changes=true$");
    expect(block).toContain("^has_changes=false$");
    expect(block).toContain('git reset --hard origin/main');
    expect(block).toContain('mapfile -t key_list <<< "$keys"');
    expect(block).toContain('for key in "${batch_keys[@]}"; do');
    expect(block).toContain('CRAWLER_KEYS="$batch_crawler_keys" node scripts/ci/prefetch-history-blobs.mjs');
    expect(block).toContain('batch_size="${#batch_keys[@]}"');
    expect(block).toContain('checkpoint history backfill slices');
    const commitAt = block.indexOf('git-commit-data.sh "$commit_scope"');
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('node scripts/ci/validate-backfill-checkpoint.mjs')).toBeLessThan(commitAt);
    expect(block.indexOf('npm run test:backfill')).toBeLessThan(commitAt);
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
    expect(changed.output).toContain('Backfill scope/workset changed; starting a fresh cursor.');
    expect(changed.output).not.toContain('Resuming after durable crawler checkpoint');

    const changedScope = resolveResumeState(
      progressLine(originalKeys, 'assura-ch', 'active', { historySince: '45 days ago' }),
      originalKeys,
    );
    expect(changedScope.status).toBe('active');
    expect(changedScope.cursor).toBe('');
    expect(changedScope.remainingKeys).toEqual(originalKeys);
    expect(changedScope.output).toContain('Backfill scope/workset changed; starting a fresh cursor.');
    expect(changedScope.output).not.toContain('Resuming after durable crawler checkpoint');

    const stableRelativeScope = resolveResumeState(
      progressLine(originalKeys, 'assura-ch', 'active', {
        historySince: '45 days ago',
        resolvedHistorySince: '2026-10-01T00:00:00Z',
      }),
      originalKeys,
      {
        historySince: '45 days ago',
        resolvedHistorySince: '2026-11-16T00:00:00Z',
      },
    );
    expect(stableRelativeScope.status).toBe('active');
    expect(stableRelativeScope.cursor).toBe('assura-ch');
    expect(stableRelativeScope.remainingKeys).toEqual(['atec-personal', 'atena']);
    expect(stableRelativeScope.output).toContain('Resuming after durable crawler checkpoint: assura-ch');
  });

  it('keeps a failed final test gate non-zero while retaining the raw checkpoint', () => {
    const result = runWorkflowHarness({ testGateExit: 17 });

    expect(result.status).not.toBe(0);
    expect(result.events, 'status=' + result.status + '\n' + result.stdout + result.stderr).toContain('crawler:alpha:complete');
    expect(result.events).toContain('assemble');
    expect(result.events).toContain('test:run test:backfill');
    expect(result.events).toContain('validate');
    expectCheckpointGates(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual(['push:active:alpha']);
    expect(result.progress.split('\t')).toHaveLength(5);
    expect(result.progress.split('\t')[1]).toBe('alpha');
    expect(result.progress.split('\t')[2]).toBe('active');
  });

  it('runs the raw gate before each checkpoint and the full gate only before completion', () => {
    const result = runWorkflowHarness();

    expect(result.status).toBe(0);
    expect(result.events).toContain('crawler:alpha:complete');
    expect(result.events.indexOf('crawler:alpha:complete')).toBeLessThan(result.events.indexOf('push:active:alpha'));
    expectCheckpointGates(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual([
      'push:active:alpha',
      'push:complete:alpha',
    ]);
    expect(new Set(result.events.filter((event) => event.startsWith('push:')).map((event) => event.split(':')[2])))
      .toEqual(new Set(['alpha']));
    expect(result.progress.split('\t')).toEqual([
      hashWorkset(['alpha']),
      'alpha',
      'complete',
      hashText([
        'history-backfill-scope-v3',
        'max_commits=0',
        'history_since_input=all',
        'keys:',
        'alpha',
        '',
      ].join('\n')),
      'all',
    ]);
  });

  // 2026-11-26, commit 1d69ad33b41: the final gate assembled the dataset and
  // the completion commit swept what assembly had rewritten. Ghost
  // reconciliation moves an archive record's routes into the active record of
  // data/jobs.json, which is gitignored, so the routes left tracked data.
  it('never persists a route removal made by the final gate assembly', () => {
    const activePath = 'data/jobs/by-crawler/alpha.json';
    const expiredPath = 'data/jobs/expired/by-crawler/ghost.json';
    const posting = {
      title: 'Elettricista di cantiere',
      company: 'Azienda Fixture SA',
      location: 'Lugano',
      url: 'https://careers.example.invalid/jobs/4711',
    };
    const active = {
      ...posting,
      slug: 'elettricista-corrente',
      slugByLocale: { it: 'elettricista-corrente' },
    };
    const archived = {
      ...posting,
      slug: 'elettricista-corrente',
      // Same Italian slug proves the ghost; the German route and the history
      // are served by this archive record only.
      slugByLocale: { it: 'elettricista-corrente', de: 'elektriker-alt' },
      // More history than the active record can absorb (cap 20).
      previousSlugs: Array.from({ length: 25 }, (_, index) => 'elettricista-storico-' + index),
      expiredAt: '2026-11-01T00:00:00.000Z',
    };
    const archivedRaw = JSON.stringify([archived], null, 2) + '\n';
    const assembleModule = [
      "import fs from 'node:fs';",
      'const { reconcileGhostExpired } = await import('
        + JSON.stringify(new URL('../scripts/assemble-jobs-dataset.mjs', import.meta.url).href) + ');',
      'const active = JSON.parse(fs.readFileSync(' + JSON.stringify(activePath) + ", 'utf8'));",
      'const expired = JSON.parse(fs.readFileSync(' + JSON.stringify(expiredPath) + ", 'utf8'));",
      // As in assembly: `active` only ever reaches the ignored data/jobs.json.
      "const { ghostCount } = reconcileGhostExpired(active, expired, { sliceDir: 'data/jobs/expired/by-crawler' });",
      "if (ghostCount !== 1) { console.error('ghostCount ' + ghostCount); process.exit(98); }",
    ].join('\n');

    const result = runWorkflowHarness({
      seedFiles: {
        [activePath]: JSON.stringify([active]) + '\n',
        [expiredPath]: archivedRaw,
      },
      assembleModule,
      readFromRemote: [activePath, expiredPath],
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.events).toContain('push:complete:alpha');
    const served = new Set<string>(
      Object.values(result.remoteFiles)
        .flatMap((raw) => JSON.parse(raw ?? '[]') as Array<Record<string, unknown>>)
        .flatMap((record) => [...localeRouteKeys(record)] as string[]),
    );
    expect(([...localeRouteKeys(archived)] as string[]).filter((route) => !served.has(route))).toEqual([]);
    expect(result.remoteFiles[expiredPath]).toBe(archivedRaw);
  }, 120000);

  it('keeps the final gate assembly out of the completion commit', () => {
    const at = (needle: string, from = 0) => {
      const index = backfillRun.indexOf(needle, from);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    // Refuse to start on top of unpersisted recoveries, since the gate output
    // is discarded wholesale.
    const guardAt = at('if has_unpersisted_slices; then');
    const assembleAt = at('node scripts/assemble-jobs-dataset.mjs');
    expect(guardAt).toBeLessThan(assembleAt);
    // Discard after the last gate and before the cursor is promoted.
    const restoreAt = at('git restore --source=HEAD --staged --worktree -- data/jobs/by-crawler data/jobs/expired/by-crawler', assembleAt);
    expect(restoreAt).toBeGreaterThan(at('node scripts/audit-expired-at-parsable.mjs'));
    expect(restoreAt).toBeLessThan(at("checkpoint_status='complete'"));
    // Second barrier: the completion commit is scoped to the progress file.
    expect(backfillRun).toMatch(/if \[ "\$checkpoint_status" = 'complete' \]; then[^]*?commit_scope='--extra-only'\n\s*fi/);
    expect(backfillRun).toMatch(
      /git-commit-data\.sh "\$commit_scope" \\\n\s*"\$checkpoint_message" \\\n\s*"\$progress_path"; then/,
    );
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
    expect(result.progress.split('\t')).toEqual(progressLine(['alpha', 'beta'], 'alpha', 'active').trim().split('\t'));
    expect(result.stdout).toContain('queueing the remaining crawler workset');
    expect(result.outputs).toEqual(['continuation_required=true']);
  });

  it('gates final assembly, tests, and deploy handoff on a completed backfill', () => {
    const continued = runWorkflowHarness({
      crawlerKeys: ['alpha', 'beta'],
      checkpointBatchSize: 1,
      runBudgetSeconds: 1,
      crawlerDelaySeconds: 2,
    });
    expect(continued.status).toBe(0);
    expect(continued.stdout).toContain('queueing the remaining crawler workset');
    expect(continued.outputs).toEqual(['continuation_required=true']);

    const completed = runWorkflowHarness();
    expect(completed.outputs).toEqual(['continuation_required=false']);

    const steps = parseYaml(workflow).jobs.backfill.steps as Array<{ name?: string; if?: string }>;
    expect(steps.some((step) => step.name === 'Reassemble dataset (so the test gate has data/jobs.json; not committed)'))
      .toBe(false);
    expect(steps.some((step) => step.name === 'Test gate (bot-direct-to-main — validate before deploy)'))
      .toBe(false);
    const handoff = steps.find((step) => step.name === 'Record self-driven deploy handoff after validated backfill');
    expect(handoff?.if).toContain("steps.backfill.outputs.continuation_required == 'false'");
    expect(handoff?.if).not.toContain('backfill_tests');
  });

  it('checkpoints prior crawler output after a later crawler errors and keeps the run failed', () => {
    const result = runWorkflowHarness({ crawlerKeys: ['alpha', 'beta'], failCrawler: 'beta' });

    expect(result.status).not.toBe(0);
    expect(result.events.indexOf('crawler:beta:failed')).toBeLessThan(result.events.indexOf('push:active:alpha'));
    expectCheckpointGates(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual(['push:active:alpha']);
    expect(result.progress.split('\t')).toHaveLength(5);
    expect(result.progress.split('\t').slice(0, 3)).toEqual([hashWorkset(['alpha', 'beta']), 'alpha', 'active']);
  });

  it('records a refused crawler (exit 3), advances the cursor, finishes green and reports it', () => {
    const result = runWorkflowHarness({ crawlerKeys: ['alpha', 'beta', 'gamma'], refuseCrawler: 'beta' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toContain('crawler:beta:refused');
    // The refusal wrote nothing, and the crawlers after it still ran.
    expect(result.events).not.toContain('crawler:beta:complete');
    expect(result.events).toContain('crawler:gamma:complete');
    expect(result.progress.split('\t').slice(0, 3)).toEqual([hashWorkset(['alpha', 'beta', 'gamma']), 'gamma', 'complete']);
    expect(result.outputs).toContain('refused_crawlers=beta');
    expect(result.outputs).toContain('continuation_required=false');
  });

  it('still fails the run for a non-refusal error code', () => {
    const result = runWorkflowHarness({ crawlerKeys: ['alpha', 'beta'], failCrawler: 'beta' });

    expect(result.status).toBe(23);
    expect(result.outputs.some((line) => line.startsWith('refused_crawlers='))).toBe(false);
  });

  it('attempts one active checkpoint on SIGTERM during a crawler batch and exits non-zero', () => {
    const result = runWorkflowHarness({ interruptCrawler: 'alpha' });

    expect(result.status).not.toBe(0);
    expect(result.events).toContain('crawler:alpha:interrupted');
    expectCheckpointGates(result.events);
    expect(result.events.filter((event) => event.startsWith('push:'))).toEqual(['push:active:-']);
    expect(result.progress.split('\t')).toHaveLength(5);
    expect(result.progress.split('\t').slice(0, 3)).toEqual([hashWorkset(['alpha']), '-', 'active']);
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
    expect(deployBlock).not.toContain('backfill_tests');
    const deployCondition = deployBlock.split('\n').find((line) => line.trimStart().startsWith('if:')) ?? '';
    expect(deployCondition).not.toContain('has_changes');
  });
});
