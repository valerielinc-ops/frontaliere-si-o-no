import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/backfill-expired-from-history.yml', import.meta.url),
  'utf8',
);
const recoveryWorkflow = readFileSync(
  new URL('../.github/workflows/backfill-expired-from-history-recovery.yml', import.meta.url),
  'utf8',
);

function resolveResumeState(progressLine: string, worksetHash: string, keys: string) {
  const progressDir = mkdtempSync(join(tmpdir(), 'backfill-resume-'));
  const progressPath = join(progressDir, 'progress.tsv');
  writeFileSync(progressPath, progressLine);

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
    const result = spawnSync('bash', ['-c', script, 'backfill-resume-fixture', progressPath, worksetHash, keys], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
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

  it('resumes an active cursor after assura-ch without skipping the next key, but restarts a complete workset', () => {
    const worksetHash = '496dd3a1288ab71f778b780504338f34d3508526';
    const keys = ['assura-ch', 'atec-personal', 'atena'].join('\n');
    const active = resolveResumeState(`${worksetHash}\tassura-ch\tactive\n`, worksetHash, keys);
    const complete = resolveResumeState(`${worksetHash}\tassura-ch\tcomplete\n`, worksetHash, keys);

    expect(active.status).toBe('active');
    expect(active.cursor).toBe('assura-ch');
    expect(active.remainingKeys).toEqual(['atec-personal', 'atena']);
    expect(active.output).toContain('Resuming after durable crawler checkpoint: assura-ch');

    expect(complete.status).toBe('complete');
    expect(complete.cursor).toBe('');
    expect(complete.remainingKeys).toEqual(['assura-ch', 'atec-personal', 'atena']);
    expect(complete.output).toContain('Previous crawler workset completed; starting a fresh pass.');
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
