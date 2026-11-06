import { describe, expect, it } from 'vitest';
import { latestCompletedVitestConclusion } from '../scripts/ci/lib/vitestCheck.mjs';

const name = 'vitest (unit + integration)';
const head = 'a'.repeat(40);

const run = (id: number, status: string, conclusion: string | null, createdAt: string, completedAt: string | null) => ({
  id,
  head_sha: head,
  name,
  status,
  conclusion,
  created_at: createdAt,
  completed_at: completedAt,
});

describe('FU-2026-10-21-auto-merge-eval — completed vitest selection', () => {
  it('chooses the newest completed verdict, not the first API row', () => {
    const runs = [
      run(1, 'completed', 'failure', '2026-10-23T00:00:00Z', '2026-10-23T00:01:00Z'),
      run(2, 'in_progress', null, '2026-10-23T00:04:00Z', null),
      run(3, 'completed', 'success', '2026-10-23T00:05:00Z', '2026-10-23T00:06:00Z'),
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('keeps the gate waiting when no vitest run has completed', () => {
    expect(latestCompletedVitestConclusion([run(4, 'queued', null, '2026-10-23T00:07:00Z', null)])).toBe('');
    expect(latestCompletedVitestConclusion([])).toBe('');
  });
});
