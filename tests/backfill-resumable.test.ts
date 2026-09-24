import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/backfill-expired-from-history.yml', import.meta.url),
  'utf8',
);

const gate = "steps.side_effect_gate.outputs.allow_side_effect == 'true' && steps.side_effect_gate.outputs.effective_dry_run != 'true'";

describe('backfill-expired-from-history.yml — durable checkpoints', () => {
  it('processes one crawler at a time and checkpoints partial batches', () => {
    const backfillStart = workflow.indexOf('- name: Recover dropped jobs and repair active firstSeenAt metadata (checkpointed batches)');
    const reassembleStart = workflow.indexOf('- name: Reassemble dataset');
    const block = workflow.slice(backfillStart, reassembleStart);

    expect(backfillStart).toBeGreaterThanOrEqual(0);
    expect(reassembleStart).toBeGreaterThan(backfillStart);
    expect(block).toContain(`if: ${gate}`);
    expect(block).toContain('BACKFILL_CHECKPOINT_BATCH_SIZE');
    expect(block).toContain('CRAWLER_KEYS="$key" node scripts/backfill-expired-from-history.mjs');
    expect(block).toContain('trap on_exit EXIT');
    expect(block).toContain('has_dirty_slices');
    expect(block).toContain("git status --porcelain -- data/jobs/by-crawler data/jobs/expired/by-crawler | grep -q '.'");
    expect(block).not.toContain('rg -q');
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
    expect(block).toContain('for key in "${key_list[@]}"; do');
    expect(block).toContain('checkpoint history backfill slices');
    expect(block.indexOf('npm run test:backfill')).toBeLessThan(block.indexOf('git-commit-data.sh --slice-only'));
  });

  it('deploys after a successful rerun even when the checkpoint is already on main', () => {
    const deployStart = workflow.indexOf('- name: Trigger deploy after validated backfill');
    const deployBlock = workflow.slice(deployStart);

    expect(deployStart).toBeGreaterThanOrEqual(0);
    expect(deployBlock).toContain("steps.backfill.outcome == 'success'");
    expect(deployBlock).toContain("steps.backfill_tests.outcome == 'success'");
    const deployCondition = deployBlock.split('\n').find((line) => line.trimStart().startsWith('if:')) ?? '';
    expect(deployCondition).not.toContain('has_changes');
  });
});
