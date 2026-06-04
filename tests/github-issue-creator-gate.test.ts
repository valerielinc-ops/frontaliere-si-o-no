import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock `gh` invocations. We route by the gh sub-command so a single mock can
// simulate "no open issue", "issue has N prior failure events", etc.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

/** Capture the args of the gh calls so tests can assert on create/edit labels. */
function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

function createCallLabels(): string[] {
  const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'create');
  if (!call) return [];
  const labels: string[] = [];
  for (let i = 0; i < call.length; i++) if (call[i] === '--label') labels.push(call[i + 1]);
  return labels;
}

const ISO = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
});

describe('github-issue-creator crawler-failure consecutive gate', () => {
  it('1st failure → low-priority breadcrumb (no priority:high) + crawler-transient label', async () => {
    // No open issue, no recently-closed issue, no labels exist yet, create succeeds.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]'; // no dup
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/42';
      return '';
    });

    const res = await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2, // caller asks priority:high
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    });

    expect(res?.number).toBe(42);
    const labels = createCallLabels();
    expect(labels).toContain('priority:low');
    expect(labels).toContain('crawler-transient');
    expect(labels).not.toContain('priority:high');
  });

  it('Nth failure on an existing breadcrumb → escalates to caller priority', async () => {
    // An OPEN canonical issue exists with 2 prior in-window failure events
    // (creation + one 🔁 recurrence comment). This run is event #3 → escalate.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { number: 7, title: 'Crawler Failure: Update Nestlé', url: 'u', state: 'OPEN' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          createdAt: ISO(5),
          comments: [{ createdAt: ISO(2), body: '🔁 Recurrence on workflow run.' }],
        });
      }
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
      workflow: 'Update Nestlé',
    });

    // It must have edited the issue to add priority:high and remove crawler-transient.
    const editCalls = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'edit');
    const flat = editCalls.flat();
    expect(flat).toContain('priority:high');
    // remove-label priority:* (low/medium/urgent) on escalation
    expect(flat).toContain('--remove-label');
    expect(flat).toContain('crawler-transient');
  });

  it('non-crawler title is NOT gated (keeps caller priority on 1st run)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/99';
      return '';
    });

    await createGithubIssue({
      title: 'CI Failure: Refresh Job Popularity',
      description: 'boom',
      priority: 2,
      labels: ['Bug'],
    });

    const labels = createCallLabels();
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });

  it('explicit --consecutive-gate negative opts a crawler title OUT of the gate', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5';
      return '';
    });

    await createGithubIssue({
      title: 'Crawler Failure: Update Nestlé',
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
      consecutiveGate: -1, // opt out
    });

    const labels = createCallLabels();
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });
});
