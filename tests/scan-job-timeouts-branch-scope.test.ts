import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';

// #6036: the recurrence gate in close-recovered-failure-issues.mjs measures
// `gh run list -w <workflow> -b main` — a population that by construction never
// contains a `pull_request` (or any non-`main`) run. scan-job-timeouts.mjs, unlike
// that reconciler, scans runs across every branch on purpose. Before this fix it
// reported ALL of them under the plain `CI Failure: <workflow>` title, so a
// PR-branch timeout could reopen/comment on (and inflate the `🔁` chronic count of)
// an issue thread the recurrence gate reads as "main's health" — evidenced live on
// #5333 (a `typecheck` timeout on `fix/issue-6020`, trigger `pull_request`,
// reopening the `main`-scoped `CI Failure: tests` issue).
//
// `gh` is mocked and routed by sub-command, same approach as
// scan-job-timeouts-dedup.test.ts / scan-job-timeouts-host-kill.test.ts.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

const callsFor = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
});

afterEach(() => {
  delete process.env.GH_REPO;
});

describe('scopedTitle — discriminant FIRST, only for non-main branches', () => {
  it('keeps the plain title for a run on main (the exact population the recurrence gate queries)', async () => {
    const { scopedTitle } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const title = scopedTitle({ name: 'tests', event: 'push', head_branch: 'main' });
    expect(title).toBe('CI Failure: tests');
    expect(TITLE_RE.exec(title)?.[1]).toBe('tests');
  });

  it('folds the trigger into the title, before the workflow name, for a non-main branch', async () => {
    const { scopedTitle } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const title = scopedTitle({ name: 'tests', event: 'pull_request', head_branch: 'fix/issue-6020' });
    expect(title).toBe('CI Failure (pull_request): tests');
    // Discriminant first ⇒ survives the 60-char dedup-prefix cut even for a long name.
    expect(title.indexOf('pull_request')).toBeLessThan(title.indexOf('tests'));
  });

  it('a non-main title no longer matches the recurrence gate TITLE_RE — reconciler skips it entirely', async () => {
    const { scopedTitle } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const title = scopedTitle({ name: 'tests', event: 'pull_request', head_branch: 'fix/issue-6020' });
    expect(TITLE_RE.exec(title)).toBeNull();
  });
});

describe('scan-job-timeouts end-to-end — a PR-branch timeout does not land on the main-scoped issue', () => {
  const PR_RUN = {
    id: 32146352793,
    name: 'tests',
    html_url: 'https://github.com/o/r/actions/runs/32146352793',
    event: 'pull_request',
    head_branch: 'fix/issue-6020',
    created_at: new Date().toISOString(),
  };
  const JOB = {
    name: 'typecheck (tsc --noEmit)',
    conclusion: 'cancelled',
    check_run_url: 'https://api.github.com/repos/o/r/check-runs/1',
  };
  const ANNOTATIONS = [
    { message: 'The job has exceeded the maximum execution time of 15m0s.' },
  ];

  it('reports under a distinct branch-scoped title, never the plain main-scoped one', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1];
        if (path.includes('actions/runs?status=cancelled')) return JSON.stringify({ workflow_runs: [PR_RUN] });
        if (path.includes(`actions/runs/${PR_RUN.id}/jobs`)) return JSON.stringify({ jobs: [JOB] });
        if (path.endsWith('/annotations')) return JSON.stringify(ANNOTATIONS);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/7000';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    const created = callsFor('create')[0];
    expect(created).toBeTruthy();
    const title = created[created.indexOf('--title') + 1];
    expect(title).toBe('CI Failure (pull_request): tests');
    expect(title).not.toBe('CI Failure: tests');
  });
});
