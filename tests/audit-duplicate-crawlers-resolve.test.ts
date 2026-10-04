import { describe, expect, it, vi } from 'vitest';
import {
  COVERAGE_GAP_ISSUE_KEY,
  DUPLICATE_ISSUE_KEY,
  STALE_SNAPSHOT_ISSUE_KEY,
  reportFindingIssues,
} from '../scripts/audit-duplicate-crawler-companies.mjs';

// Sibling of the weekly logo audit (issue 6504): each finding family opened or
// updated its issue while it had findings, but a family at 0 was never closed.

const duplicate = { keys: ['keeper', 'witness'] as [string, string], shared: ['https://jobs.example/1'], onlyA: [], onlyB: [] };
const gap = { key: 'keeper', twin: 'witness', missing: ['https://jobs.example/2'] };
const stale = {
  key: 'witness',
  twin: 'keeper',
  assembledAtMs: Date.now() - 72 * 60 * 60 * 1000,
  ageMs: 72 * 60 * 60 * 1000,
  maskedMissing: ['https://jobs.example/3'],
};

describe('audit-duplicate-crawler-companies reportFindingIssues', () => {
  it('closes every family that the audit measures at 0', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn(() => null);

    const outcome = await reportFindingIssues(
      { duplicates: [], gaps: [], staleSnapshots: [] },
      { createIssue, resolveIssue, runUrl: 'https://github.com/o/r/actions/runs/7' },
    );

    expect(createIssue).not.toHaveBeenCalled();
    expect(resolveIssue.mock.calls.map(([key]) => key)).toEqual([
      DUPLICATE_ISSUE_KEY,
      COVERAGE_GAP_ISSUE_KEY,
      STALE_SNAPSHOT_ISSUE_KEY,
    ]);
    for (const [, ctx] of resolveIssue.mock.calls) {
      expect(ctx).toEqual({ workflow: 'audit-duplicate-crawlers', runUrl: 'https://github.com/o/r/actions/runs/7' });
    }
    expect(outcome).toEqual({ 'duplicate-identity': 'resolved', 'coverage-gap': 'resolved', 'snapshot-stale': 'resolved' });
  });

  it('reports the families with findings and resolves only the clean ones', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn(() => null);

    await reportFindingIssues({ duplicates: [duplicate], gaps: [], staleSnapshots: [] }, { createIssue, resolveIssue });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0].dedupKey).toBe(DUPLICATE_ISSUE_KEY);
    expect(resolveIssue.mock.calls.map(([key]) => key)).toEqual([COVERAGE_GAP_ISSUE_KEY, STALE_SNAPSHOT_ISSUE_KEY]);
  });

  it('leaves the coverage-gap issue alone while a stale witness masks the comparison', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn(() => null);

    const outcome = await reportFindingIssues(
      { duplicates: [], gaps: [], staleSnapshots: [stale] },
      { createIssue, resolveIssue },
    );

    expect(resolveIssue.mock.calls.map(([key]) => key)).toEqual([DUPLICATE_ISSUE_KEY]);
    expect(createIssue.mock.calls.map(([args]) => args.dedupKey)).toEqual([STALE_SNAPSHOT_ISSUE_KEY]);
    expect(outcome['coverage-gap']).toBe('unchanged');
  });

  it('still reports gaps when they exist', async () => {
    const createIssue = vi.fn();
    const resolveIssue = vi.fn(() => null);

    await reportFindingIssues({ duplicates: [], gaps: [gap], staleSnapshots: [] }, { createIssue, resolveIssue });

    expect(createIssue.mock.calls.map(([args]) => args.dedupKey)).toEqual([COVERAGE_GAP_ISSUE_KEY]);
  });
});
