import { describe, expect, it, vi } from 'vitest';

import {
  MAX_AGE_DAYS,
  STABLE_ISSUE_TITLE,
  buildIssueBody,
  evaluateFreshness,
  runFreshnessCheck,
} from '../scripts/ci/check-employer-insights-freshness.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-03T10:30:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

describe('employer insights freshness verdict', () => {
  it('is fresh up to the threshold and stale beyond it', () => {
    expect(evaluateFreshness({ latestUpdatedAt: daysAgo(1), now }).stale).toBe(false);
    expect(evaluateFreshness({ latestUpdatedAt: daysAgo(MAX_AGE_DAYS), now }).stale).toBe(false);
    const stale = evaluateFreshness({ latestUpdatedAt: daysAgo(MAX_AGE_DAYS + 0.5), now });
    expect(stale).toMatchObject({ stale: true, measurable: true, maxAgeDays: MAX_AGE_DAYS });
    expect(stale.ageDays).toBeGreaterThan(MAX_AGE_DAYS);
  });

  it('reads a Firestore Timestamp as well as an ISO string', () => {
    const timestamp = { toDate: () => daysAgo(12) };
    expect(evaluateFreshness({ latestUpdatedAt: timestamp, now }).ageDays).toBe(12);
    expect(evaluateFreshness({ latestUpdatedAt: daysAgo(12).toISOString(), now }).ageDays).toBe(12);
  });

  it('fails closed when the age cannot be measured', () => {
    for (const latestUpdatedAt of [null, undefined, 'not-a-date', { toDate: () => new Date(Number.NaN) }]) {
      expect(evaluateFreshness({ latestUpdatedAt, now })).toMatchObject({ stale: true, measurable: false, ageDays: null });
    }
    expect(evaluateFreshness({ latestUpdatedAt: new Date(now.getTime() + DAY_MS), now }))
      .toMatchObject({ stale: true, measurable: false });
    // A runner clock a few seconds behind the server timestamp is not the future.
    expect(evaluateFreshness({ latestUpdatedAt: new Date(now.getTime() + 30_000), now }))
      .toMatchObject({ stale: false, ageDays: 0 });
  });

  it('refuses a threshold that would silence the alarm', () => {
    expect(() => evaluateFreshness({ latestUpdatedAt: daysAgo(1), now, maxAgeDays: 0 })).toThrow(/maxAgeDays/);
    expect(() => evaluateFreshness({ latestUpdatedAt: daysAgo(1), now, maxAgeDays: Number.NaN })).toThrow(/maxAgeDays/);
  });
});

describe('employer insights freshness issue lifecycle', () => {
  const impls = () => ({
    createIssueImpl: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ number: 1, persisted: true })),
    resolveIssueImpl: vi.fn(async () => null),
    reportingDisabled: false,
  });

  it('opens the stable-title issue when the last write is stale', async () => {
    const io = impls();
    const result = await runFreshnessCheck({
      now,
      runUrl: 'https://example.test/run/1',
      readLatestUpdatedAtImpl: async () => daysAgo(12),
      ...io,
    });
    expect(result.action).toBe('issue-opened');
    expect(io.resolveIssueImpl).not.toHaveBeenCalled();
    expect(io.createIssueImpl).toHaveBeenCalledTimes(1);
    const [{ title, description }] = io.createIssueImpl.mock.calls[0] as unknown as [{ title: string; description: string }];
    expect(title).toBe(STABLE_ISSUE_TITLE);
    expect(description).toContain('https://example.test/run/1');
    expect(description).toContain('## Scheda');
  });

  it('opens the issue when no root carries a readable write time', async () => {
    const io = impls();
    const result = await runFreshnessCheck({ now, readLatestUpdatedAtImpl: async () => null, ...io });
    expect(result.action).toBe('issue-opened');
    expect(io.createIssueImpl).toHaveBeenCalledTimes(1);
  });

  it('fails when the stale alarm was not persisted', async () => {
    // createGithubIssue does not throw: it returns null when `gh issue create`
    // fails and `persisted: false` when the duplicate lookup is unreliable.
    for (const unpersisted of [null, { persisted: false, lookupFailed: true }, {}]) {
      const io = impls();
      io.createIssueImpl.mockResolvedValueOnce(unpersisted);
      await expect(runFreshnessCheck({ now, readLatestUpdatedAtImpl: async () => daysAgo(12), ...io }))
        .rejects.toThrow(/non risulta persistita/);
      expect(io.resolveIssueImpl).not.toHaveBeenCalled();
    }
  });

  it('neither opens nor closes when reporting is switched off on purpose', async () => {
    for (const latest of [daysAgo(12), daysAgo(0.1)]) {
      const io = impls();
      const result = await runFreshnessCheck({ now, readLatestUpdatedAtImpl: async () => latest, ...io, reportingDisabled: true });
      expect(result.action).toBe('reporting-disabled');
      expect(io.createIssueImpl).not.toHaveBeenCalled();
      expect(io.resolveIssueImpl).not.toHaveBeenCalled();
    }
  });

  it('closes the issue on a fresh reading and never opens one', async () => {
    const io = impls();
    const result = await runFreshnessCheck({ now, readLatestUpdatedAtImpl: async () => daysAgo(0.1), ...io });
    expect(result.action).toBe('resolved-if-open');
    expect(io.createIssueImpl).not.toHaveBeenCalled();
    expect(io.resolveIssueImpl).toHaveBeenCalledWith(expect.objectContaining({ title: STABLE_ISSUE_TITLE }));
  });

  it('does not close anything when the read fails', async () => {
    const io = impls();
    await expect(runFreshnessCheck({
      now,
      readLatestUpdatedAtImpl: async () => { throw new Error('firestore unavailable'); },
      ...io,
    })).rejects.toThrow(/firestore unavailable/);
    expect(io.createIssueImpl).not.toHaveBeenCalled();
    expect(io.resolveIssueImpl).not.toHaveBeenCalled();
  });

  it('measures without side effects in dry-run', async () => {
    const io = impls();
    const result = await runFreshnessCheck({ now, dryRun: true, readLatestUpdatedAtImpl: async () => daysAgo(12), ...io });
    expect(result).toMatchObject({ action: 'dry-run', verdict: { stale: true } });
    expect(io.createIssueImpl).not.toHaveBeenCalled();
    expect(io.resolveIssueImpl).not.toHaveBeenCalled();
  });

  it('keeps the title stable: no measurement inside it', () => {
    expect(STABLE_ISSUE_TITLE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const first = buildIssueBody(evaluateFreshness({ latestUpdatedAt: daysAgo(4), now }));
    const second = buildIssueBody(evaluateFreshness({ latestUpdatedAt: daysAgo(12), now }));
    expect(first).not.toBe(second);
    expect(first).toContain(STABLE_ISSUE_TITLE);
    expect(second).toContain(STABLE_ISSUE_TITLE);
  });
});
