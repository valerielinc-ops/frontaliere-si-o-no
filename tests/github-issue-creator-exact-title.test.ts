import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

import fs from 'node:fs';
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/information-gain-title-collision.json', import.meta.url), 'utf-8'),
);
const { createGithubIssue, resolveGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

const competingIssues = [
  { number: 72, title: fixture.regressionTitle, url: 'regression-url', state: 'OPEN' },
  { number: 71, title: fixture.opportunityTitle, url: 'opportunity-url', state: 'OPEN' },
];

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((call) => call[0] === 'gh')
    .map((call) => call[1] as string[]);
}

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
  delete process.env.ENABLE_FAILURE_REPORT;
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(competingIssues);
    if (args[0] === 'issue' && args[1] === 'close') return 'closed';
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED' });
    if (args[0] === 'issue' && args[1] === 'create') return 'new-issue-url';
    return '';
  });
});

describe('Information Gain issue identity with a shared 60-character prefix', () => {
  it('updates only the exact opportunity issue when opening its next measurement', async () => {
    const result = await createGithubIssue({
      title: fixture.opportunityTitle,
      description: 'current opportunity measurement',
      labels: ['enhancement', 'seo'],
      exactTitle: true,
    });

    expect(result?.number).toBe(71);
    const comment = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comment?.[2]).toBe('71');
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
  });

  it('resolves only the exact opportunity issue, not the newer below-floor issue', () => {
    const result = resolveGithubIssue(fixture.opportunityTitle, {
      workflow: 'Information Gain Scan',
      exactTitle: true,
    });

    expect(result?.number).toBe(71);
    const close = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'close');
    expect(close?.[2]).toBe('71');
    const comment = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comment?.[2]).toBe('71');
  });
});
