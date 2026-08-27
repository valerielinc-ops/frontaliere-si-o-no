/**
 * pr-review-loop.yml's "Resolve PR from tests run" step can't import
 * scripts/ci/lib/vitestCheck.mjs (it deliberately runs BEFORE checkout, so
 * no repo files are on disk yet — see the step's own comment) and instead
 * inlines an equivalent jq filter. This test proves the two stay in sync:
 * same fixtures through `latestCompletedRunByName` (the JS source of truth,
 * also used by auto-merge-eval.mjs) and through the exact jq filter the
 * workflow runs, same verdict.
 *
 * Root cause this closes: `github.event.workflow_run.conclusion` is the
 * ROLLUP of the whole tests.yml run. An unrelated job (`collision`, whose
 * job-level lock is shared globally with a scheduled scan and has
 * `cancel-in-progress: false`) getting dropped by that lock's queue-of-1
 * drags the WHOLE run to `cancelled` even when `vitest (unit + integration)`
 * itself is `success` — measured 2026-08-25 on ~1/3 of PRs open at the time.
 * Before this fix pr-review-loop.yml trusted that rollup and never reviewed
 * those PRs until stale-pr-rescuer.yml's 2h safety net intervened.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { latestCompletedRunByName } from '../scripts/ci/lib/vitestCheck.mjs';

const VITEST_NAME = 'vitest (unit + integration)';

// Byte-for-byte the filter in .github/workflows/pr-review-loop.yml's
// "Resolve PR from tests run" step — keep both in sync if either changes.
const JQ_FILTER = `
  [.check_runs[] | select(.name == "${VITEST_NAME}" and .status == "completed" and .completed_at != null)]
  | sort_by(.completed_at) | last | .conclusion // ""
`;

function jqConclusion(checkRuns: unknown[]): string {
  const input = JSON.stringify({ check_runs: checkRuns });
  return execFileSync('jq', ['-r', JQ_FILTER], { input, encoding: 'utf8' }).trim();
}

function jsConclusion(checkRuns: any[]): string {
  const last = latestCompletedRunByName(checkRuns, VITEST_NAME);
  return last ? last.conclusion || '' : '';
}

describe('pr-review-loop.yml resolve step — jq filter mirrors vitestCheck.mjs', () => {
  const cases: Array<{ label: string; checkRuns: any[] }> = [
    {
      label: 'single completed success',
      checkRuns: [{ name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T12:00:00Z', conclusion: 'success' }],
    },
    {
      label: 'out-of-order duplicates on the same SHA — latest completed_at wins, not [0]',
      checkRuns: [
        { name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T12:00:00Z', conclusion: 'success' },
        { name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T10:00:00Z', conclusion: 'failure' },
      ],
    },
    {
      label: 'a fresh in-progress run alongside an older completed one — ignores the in-progress row',
      checkRuns: [
        { name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T10:00:00Z', conclusion: 'failure' },
        { name: VITEST_NAME, status: 'in_progress', completed_at: null, conclusion: null },
      ],
    },
    {
      label: 'other check-runs on the same commit are ignored (contract, a shard-named run)',
      checkRuns: [
        { name: 'contract', status: 'completed', completed_at: '2026-08-25T11:00:00Z', conclusion: 'success' },
        { name: `${VITEST_NAME} shard 1/4`, status: 'completed', completed_at: '2026-08-25T09:00:00Z', conclusion: 'cancelled' },
        { name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T12:00:00Z', conclusion: 'success' },
      ],
    },
    {
      label: 'no vitest check-run at all',
      checkRuns: [{ name: 'contract', status: 'completed', completed_at: '2026-08-25T11:00:00Z', conclusion: 'success' }],
    },
    {
      label: 'empty check-runs array',
      checkRuns: [],
    },
    {
      label: 'the real-world case this PR fixes: vitest success, overall run cancelled (unrelated collision job)',
      checkRuns: [
        { name: 'collision', status: 'completed', completed_at: '2026-08-25T09:30:00Z', conclusion: 'cancelled' },
        { name: 'contract', status: 'completed', completed_at: '2026-08-25T09:35:00Z', conclusion: 'success' },
        { name: 'typecheck (tsc --noEmit)', status: 'completed', completed_at: '2026-08-25T09:40:00Z', conclusion: 'success' },
        { name: VITEST_NAME, status: 'completed', completed_at: '2026-08-25T09:55:00Z', conclusion: 'success' },
      ],
    },
  ];

  for (const { label, checkRuns } of cases) {
    it(`agree on: ${label}`, () => {
      expect(jqConclusion(checkRuns)).toBe(jsConclusion(checkRuns));
    });
  }

  it('the real-world case resolves to success (proves this fixture would now pass the gate)', () => {
    const realWorld = cases.find((c) => c.label.startsWith('the real-world case'))!;
    expect(jqConclusion(realWorld.checkRuns)).toBe('success');
  });
});
