import { describe, expect, it, vi } from 'vitest';
import { ISSUE_TITLE, main as runSourceLiveness } from '../scripts/check-source-liveness.mjs';

// Siblings of the weekly logo audit (issue 6504): monitors that open a stable
// issue when the measure is red but never closed it when the measure came back
// green, leaving the issue open after the condition had cleared.

const silentLogger = { log: () => {} };

describe('check-source-liveness closes its outage issue on a live source', () => {
  const alive = async () => ({ alive: true, reason: 'ok', windowDays: 7, floor: 50 });
  const dead = async () => ({ alive: false, reason: 'dead', windowDays: 7, floor: 50, deadDays: [] });

  it('resolves ISSUE_TITLE when the source is measured alive', async () => {
    const createIssueImpl = vi.fn();
    const resolveIssueImpl = vi.fn();
    const out = await runSourceLiveness({ argv: [], checkImpl: alive, createIssueImpl, resolveIssueImpl, logger: silentLogger });
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(resolveIssueImpl).toHaveBeenCalledWith(ISSUE_TITLE, { workflow: 'Source Liveness' });
    expect(out.resolved).toBe(true);
  });

  it('does not resolve on --dry-run, and opens (never resolves) on a dead source', async () => {
    const resolveIssueImpl = vi.fn();
    await runSourceLiveness({ argv: ['--dry-run'], checkImpl: alive, createIssueImpl: vi.fn(), resolveIssueImpl, logger: silentLogger });
    expect(resolveIssueImpl).not.toHaveBeenCalled();

    const createIssueImpl = vi.fn();
    await runSourceLiveness({ argv: [], checkImpl: dead, createIssueImpl, resolveIssueImpl, logger: silentLogger });
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    expect(createIssueImpl.mock.calls[0][0].title).toBe(ISSUE_TITLE);
    expect(resolveIssueImpl).not.toHaveBeenCalled();
  });
});
