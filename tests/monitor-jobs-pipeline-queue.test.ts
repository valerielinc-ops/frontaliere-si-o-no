import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// THE OBSERVER for issue #7165 (follow-up #7063, items 3+4 of PR #7035).
//
// PR #7035 put every `jobs-data-pipeline` workflow on `cancel-in-progress: false`
// + `queue: max` so a superseded run WAITS (up to GitHub's 100-run cap) instead of
// being cancelled — but nothing observed whether that assumption holds:
//   (a) if the plan/context degrades silently to the old 1-pending-run limit, a
//       queued run gets CANCELLED despite `cancel-in-progress: false` — exactly
//       the signature `wasCancelledWhileQueued` below detects;
//   (b) if the queue genuinely fills toward 100, runs beyond it vanish with no
//       operational signal — the saturation pre-alarm below.
//
// `gh` is mocked and routed by sub-command, same approach as
// scan-job-timeouts-host-kill.test.ts.
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
const apiPaths = () => ghCalls().filter((a) => a[0] === 'api').map((a) => a[1]);
const callsFor = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);

const MEMBER_WORKFLOW = `name: translate-pending
on:
  schedule:
    - cron: '0 * * * *'

concurrency:
  group: jobs-data-pipeline
  cancel-in-progress: false
  queue: max

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const UNRELATED_WORKFLOW = `name: something-else
concurrency:
  group: something-else
  cancel-in-progress: true

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

let workflowsDir: string;

function writeWorkflow(name: string, body: string) {
  writeFileSync(join(workflowsDir, name), body);
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  workflowsDir = mkdtempSync(join(tmpdir(), 'jobs-pipeline-queue-monitor-'));
  process.env.GH_REPO = 'o/r';
  process.env.WORKFLOWS_DIR = workflowsDir;
});

afterEach(() => {
  delete process.env.GH_REPO;
  delete process.env.WORKFLOWS_DIR;
  delete process.env.QUEUE_SATURATION_WARN_THRESHOLD;
  rmSync(workflowsDir, { recursive: true, force: true });
});

describe('workflowDeclaresGroup — literal concurrency.group scan', () => {
  it('matches a workflow that declares the group at the top level', async () => {
    const { workflowDeclaresGroup } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(workflowDeclaresGroup(MEMBER_WORKFLOW, 'jobs-data-pipeline')).toBe(true);
  });

  it('does not match an unrelated concurrency group', async () => {
    const { workflowDeclaresGroup } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(workflowDeclaresGroup(UNRELATED_WORKFLOW, 'jobs-data-pipeline')).toBe(false);
  });

  it('does not match a job-level concurrency block reusing the name', async () => {
    // Indented under `jobs:`, never a top-level `concurrency:` — must not confuse
    // job-scoped concurrency with the group this monitor watches.
    const nested = 'name: x\njobs:\n  run:\n    concurrency:\n      group: jobs-data-pipeline\n'
      + '    runs-on: ubuntu-latest\n';
    const { workflowDeclaresGroup } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(workflowDeclaresGroup(nested, 'jobs-data-pipeline')).toBe(false);
  });
});

describe('discoverJobsDataPipelineWorkflows', () => {
  it('finds only the workflow(s) that declare the group', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    writeWorkflow('something-else.yml', UNRELATED_WORKFLOW);
    const { discoverJobsDataPipelineWorkflows } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    const found = discoverJobsDataPipelineWorkflows(workflowsDir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('translate-pending.yml');
  });
});

describe('wasCancelledWhileQueued', () => {
  it('classifies a job cancelled before ever starting (never left the queue)', async () => {
    const { wasCancelledWhileQueued } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(wasCancelledWhileQueued({ status: 'completed', conclusion: 'cancelled', started_at: null })).toBe(true);
  });

  it('does not classify a run that started before being cancelled', async () => {
    const { wasCancelledWhileQueued } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(wasCancelledWhileQueued({
      status: 'completed', conclusion: 'cancelled', started_at: '2026-01-01T00:00:00Z',
    })).toBe(false);
  });

  it('does not classify an ordinary failure', async () => {
    const { wasCancelledWhileQueued } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(wasCancelledWhileQueued({ status: 'completed', conclusion: 'failure', started_at: null })).toBe(false);
  });

  it('does not classify a run still in progress', async () => {
    const { wasCancelledWhileQueued } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    expect(wasCancelledWhileQueued({ status: 'in_progress', conclusion: null, started_at: null })).toBe(false);
  });
});

describe('main — cancelled-while-queued alert (queue:max not honoured)', () => {
  it('opens an issue naming the run when a job was cancelled before ever starting', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    const RUN = {
      id: 999,
      html_url: 'https://github.com/o/r/actions/runs/999',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1] as string;
        if (path.includes('runs?status=queued')) return JSON.stringify({ workflow_runs: [] });
        if (path.includes('runs?status=cancelled')) return JSON.stringify({ workflow_runs: [RUN] });
        if (path.includes(`actions/runs/${RUN.id}/jobs`)) {
          return JSON.stringify({
            jobs: [{ name: 'run', status: 'completed', conclusion: 'cancelled', started_at: null }],
          });
        }
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/1';
      return '';
    });

    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();

    const created = callsFor('create');
    expect(created).toHaveLength(1);
    const title = created[0][created[0].indexOf('--title') + 1];
    expect(title).toContain('cancellata mentre era in coda');
    const body = created[0][created[0].indexOf('--body') + 1];
    expect(body).toContain(RUN.html_url);
    expect(body).toContain('translate-pending.yml');
  });

  it('stays quiet when the cancelled run had already started (ordinary cancel, not a queue drop)', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    const RUN = {
      id: 1000,
      html_url: 'https://github.com/o/r/actions/runs/1000',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1] as string;
        if (path.includes('runs?status=queued')) return JSON.stringify({ workflow_runs: [] });
        if (path.includes('runs?status=cancelled')) return JSON.stringify({ workflow_runs: [RUN] });
        if (path.includes(`actions/runs/${RUN.id}/jobs`)) {
          return JSON.stringify({
            jobs: [{
              name: 'run', status: 'completed', conclusion: 'cancelled', started_at: new Date().toISOString(),
            }],
          });
        }
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      return '';
    });

    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(0);
  });

  it('ignores a cancelled run outside the lookback window', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    const OLD_RUN = {
      id: 1001,
      html_url: 'https://github.com/o/r/actions/runs/1001',
      created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
    };
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1] as string;
        if (path.includes('runs?status=queued')) return JSON.stringify({ workflow_runs: [] });
        if (path.includes('runs?status=cancelled')) return JSON.stringify({ workflow_runs: [OLD_RUN] });
        return '{}';
      }
      return '';
    });

    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(0);
    // The stale run must not even trigger a jobs lookup.
    expect(apiPaths().some((p) => p.includes(`actions/runs/${OLD_RUN.id}/jobs`))).toBe(false);
  });
});

describe('main — queue saturation pre-alarm', () => {
  it('opens an alert once the queue depth reaches the configured threshold', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    process.env.QUEUE_SATURATION_WARN_THRESHOLD = '2';
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1] as string;
        if (path.includes('runs?status=queued')) return JSON.stringify({ workflow_runs: [{ id: 1 }, { id: 2 }] });
        if (path.includes('runs?status=cancelled')) return JSON.stringify({ workflow_runs: [] });
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/2';
      return '';
    });

    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();

    const created = callsFor('create');
    expect(created).toHaveLength(1);
    const title = created[0][created[0].indexOf('--title') + 1];
    expect(title).toContain('coda in saturazione (2/100)');
  });

  it('stays quiet below the saturation threshold with no cancelled-while-queued run', async () => {
    writeWorkflow('translate-pending.yml', MEMBER_WORKFLOW);
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1] as string;
        if (path.includes('runs?status=queued')) return JSON.stringify({ workflow_runs: [{ id: 1 }] });
        if (path.includes('runs?status=cancelled')) return JSON.stringify({ workflow_runs: [] });
        return '{}';
      }
      return '';
    });

    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(0);
  });
});

describe('main — no group members', () => {
  it('does nothing (no gh call at all) when no workflow declares the group', async () => {
    const { main } = await import('../scripts/monitor-jobs-pipeline-queue.mjs');
    await main();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
