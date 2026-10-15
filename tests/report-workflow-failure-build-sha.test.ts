import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createGithubIssueSpy } = vi.hoisted(() => ({
  createGithubIssueSpy: vi.fn(async () => ({ number: 1, title: 't', url: 'u' })),
}));

vi.mock('../scripts/lib/github-issue-creator.mjs', () => ({
  createGithubIssue: createGithubIssueSpy,
  resolveGithubIssue: vi.fn(async () => null),
}));

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, default: actual, execFileSync: vi.fn(() => '') };
});

describe('report-workflow-failure build SHA propagation', () => {
  const envNames = ['BUILD_SHA', 'FAILURE_TITLE', 'CLOSED_BY', 'WORKFLOW_NAME'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of envNames) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.FAILURE_TITLE = 'CI Failure: Publish to GitHub Pages (deploy + validate)';
    process.env.CLOSED_BY = 'close-recovered-failure-issues';
    process.env.WORKFLOW_NAME = 'Publish to GitHub Pages (deploy + validate)';
    createGithubIssueSpy.mockClear();
  });

  afterEach(() => {
    for (const name of envNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('passes the validated build SHA to the stale-build guard', async () => {
    const buildSha = 'c805ca21e675192daf1de536ff9f7e754534288f';
    process.env.BUILD_SHA = buildSha;
    const { reportMode } = await import('../scripts/ci/report-workflow-failure.mjs');

    await reportMode({ dryRun: false });

    expect(createGithubIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ buildSha }));
  });

  it('keeps the fail-safe null when the caller has no build SHA', async () => {
    const { reportMode } = await import('../scripts/ci/report-workflow-failure.mjs');

    await reportMode({ dryRun: false });

    expect(createGithubIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ buildSha: null }));
  });
});
