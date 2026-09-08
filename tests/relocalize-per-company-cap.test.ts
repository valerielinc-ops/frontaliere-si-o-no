import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('JOBS_CASCADE_PER_COMPANY_BUDGET_MS', '');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cascade per-company time budget', () => {
  it('caps each invocation at 15 minutes without exceeding the deadline', async () => {
    const { cascadeCompanyTimeBudgetMs } = await import('../scripts/relocalize-pending-jobs.mjs');
    const deadlineMs = 250 * 60 * 1000;

    expect(cascadeCompanyTimeBudgetMs(10 * 60 * 1000, { deadlineMs })).toBe(15 * 60 * 1000);
    expect(cascadeCompanyTimeBudgetMs(245 * 60 * 1000, { deadlineMs })).toBe(5 * 60 * 1000);
    expect(cascadeCompanyTimeBudgetMs(251 * 60 * 1000, { deadlineMs })).toBe(1);
  });
});
