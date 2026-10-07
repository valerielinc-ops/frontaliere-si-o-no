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

function installIssueLists(open: unknown[], closed: unknown[] = []) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      const stateAt = args.indexOf('--state');
      return JSON.stringify(stateAt >= 0 && args[stateAt + 1] === 'closed' ? closed : open);
    }
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/999';
    if (args[0] === 'issue' && args[1] === 'reopen') return 'reopened';
    if (args[0] === 'issue' && args[1] === 'close') return 'closed';
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED' });
    return '';
  });
}

describe('Information Gain issue identity with a shared 60-character prefix', () => {
  it('does not treat a short title as the prefix of a newer longer sibling', async () => {
    const title = 'Workflow Failure: Generate Blog Article';
    const exact = { number: 249, title, url: 'exact-url', state: 'OPEN' };
    const sibling = { number: 2272, title: `${title} (canton-nw)`, url: 'sibling-url', state: 'OPEN' };
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([sibling, exact]);
      return '';
    });

    const result = await createGithubIssue({
      title,
      description: 'current workflow failure',
      labels: ['bug'],
    });

    expect(result?.number).toBe(249);
    const comment = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comment?.[2]).toBe('249');
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
  });

  it('opens a new exact-title issue when only the longer sibling is open', async () => {
    const title = 'Workflow Failure: Generate Blog Article';
    const sibling = { number: 2272, title: `${title} (canton-nw)`, url: 'sibling-url', state: 'OPEN' };
    installIssueLists([sibling]);

    const result = await createGithubIssue({ title, description: 'current workflow failure', labels: ['bug'] });

    expect(result?.number).toBe(999);
    const created = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'create');
    expect(created?.[created?.indexOf('--title') + 1]).toBe(title);
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'comment')).toBe(false);
  });

  it('--resolve leaves a longer sibling open for a short title', () => {
    const title = 'Workflow Failure: Generate Blog Article';
    const sibling = { number: 2272, title: `${title} (canton-nw)`, url: 'sibling-url', state: 'OPEN' };
    installIssueLists([sibling]);

    const result = resolveGithubIssue(title, { workflow: 'Generate Blog Article' });

    expect(result).toBeNull();
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'close')).toBe(false);
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'comment')).toBe(false);
  });

  it('does not reopen a recently closed longer sibling for a short title', async () => {
    const title = 'Workflow Failure: Generate Blog Article';
    const sibling = {
      number: 2272,
      title: `${title} (canton-nw)`,
      url: 'sibling-url',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      labels: [{ name: 'bug' }],
    };
    installIssueLists([], [sibling]);

    const result = await createGithubIssue({ title, description: 'current workflow failure', labels: ['bug'] });

    expect(result?.number).toBe(999);
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'reopen')).toBe(false);
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'comment')).toBe(false);
  });

  it('keeps prefix matching for a truncated title and exactTitle still narrows it', async () => {
    installIssueLists(competingIssues);

    const prefixResult = await createGithubIssue({
      title: fixture.opportunityTitle,
      description: 'current opportunity measurement',
      labels: ['enhancement', 'seo'],
    });
    expect(prefixResult?.number).toBe(72);

    execFileSync.mockReset();
    installIssueLists(competingIssues);
    const exactResult = await createGithubIssue({
      title: fixture.opportunityTitle,
      description: 'current opportunity measurement',
      labels: ['enhancement', 'seo'],
      exactTitle: true,
    });
    expect(exactResult?.number).toBe(71);
  });

  it('keeps prefix matching and legacy-title migration for a dedupKey family', async () => {
    const title = 'Duplicate crawler companies: 0 groups';
    const legacy = {
      number: 81,
      title: 'Duplicate crawler companies: 17 groups',
      url: 'legacy-url',
      state: 'OPEN',
    };
    installIssueLists([legacy]);

    const result = await createGithubIssue({
      title,
      description: 'cold-start probe',
      labels: ['bug'],
      dedupKey: 'Duplicate crawler companies:',
    });

    expect(result?.number).toBe(81);
    const edit = ghCalls().find((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(edit).toContain('--title');
    expect(edit).toContain(title);
    expect(ghCalls().some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
    expect(ghCalls().find((args) => args[0] === 'issue' && args[1] === 'comment')?.[2]).toBe('81');
  });

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
