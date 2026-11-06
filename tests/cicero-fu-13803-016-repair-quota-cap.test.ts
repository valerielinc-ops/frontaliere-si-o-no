import { describe, expect, it } from 'vitest';
import {
  collectRepairQuotaStats,
  repairQuotaDecision,
} from '../scripts/ci/repair-quota-admission.mjs';

describe('repair quota admission cap (#13803 FU-016)', () => {
  it('fails closed when the queued-issue listing reaches its pagination cap', () => {
    const result = collectRepairQuotaStats({
      repo: 'owner/repo',
      runJson: (args: string[]) => {
        if (args[0] === 'issue') return Array.from({ length: 300 }, (_, number) => ({ number }));
        if (args[0] === 'api') return [];
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('300-item cap');
  });

  it('keeps the empty queue fail-safe even when telemetry counts are malformed', () => {
    const decision = repairQuotaDecision({
      repairRuns: 'not-a-number' as unknown as number,
      issueFixRuns: -4,
      queuedIssues: 0,
    });

    expect(decision.admit).toBe(true);
    expect(decision.reason).toBe('issue-fix queue empty');
    expect(decision.repairRuns).toBe(0);
    expect(decision.issueFixRuns).toBe(0);
  });
});
