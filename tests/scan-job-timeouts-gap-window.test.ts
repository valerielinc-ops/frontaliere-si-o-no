import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const MINUTE = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const apiPaths = () => execFileSync.mock.calls
  .filter((call) => call[0] === 'gh' && call[1][0] === 'api')
  .map((call) => String(call[1][1]));
const creates = () => execFileSync.mock.calls
  .filter((call) => call[0] === 'gh' && call[1][0] === 'issue' && call[1][1] === 'create');

// Run 36407582573: send-newsletter hit its 360-minute timeout at 16:06Z; the
// previous scan had started at 15:23Z and the next one only came hours later.
const timedOutRun = {
  id: 36407582573,
  name: 'Send Newsletter',
  html_url: 'https://github.com/o/r/actions/runs/36407582573',
  event: 'schedule',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'cancelled',
  created_at: iso(8 * 60 * MINUTE),
  updated_at: iso(4 * 60 * MINUTE),
};
const timeoutJob = {
  name: 'send',
  conclusion: 'cancelled',
  check_run_url: 'https://api.github.com/repos/o/r/check-runs/7',
};

function installGh({ previousScanStartedAt }: { previousScanStartedAt: string | null }) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'api') {
      const path = String(args[1]);
      if (path.includes('/runs?status=success')) {
        return JSON.stringify({
          workflow_runs: previousScanStartedAt ? [{ id: 1, run_started_at: previousScanStartedAt }] : [],
        });
      }
      if (path.includes('actions/runs?status=cancelled')) return JSON.stringify({ workflow_runs: [timedOutRun] });
      if (path.includes('actions/runs?status=failure')) return JSON.stringify({ workflow_runs: [] });
      if (path.includes(`/runs/${timedOutRun.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
      if (path.endsWith('/annotations')) {
        return JSON.stringify([[{ message: 'The job has exceeded the maximum execution time of 6h0m0s' }]]);
      }
      return '{}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return '[]';
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/1';
    return '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  process.env.GITHUB_WORKFLOW_REF = 'o/r/.github/workflows/job-timeout-monitor.yml@refs/heads/main';
  delete process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES;
  delete process.env.TIMEOUT_SCAN_MAX_LOOKBACK_MINUTES;
});

afterEach(() => {
  delete process.env.GH_REPO;
  delete process.env.GITHUB_WORKFLOW_REF;
});

describe('scanLookbackMinutes — the window covers the gap since the previous scan', () => {
  it('reaches back to the previous start plus the overlap, never below the base', async () => {
    const { scanLookbackMinutes } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const nowMs = Date.parse('2026-09-28T19:34:00Z');
    const at = (isoTime: string) => Date.parse(isoTime);
    // 15:23Z -> 19:34Z is 251 minutes: 251 + 15.
    expect(scanLookbackMinutes({ nowMs, previousScanStartedMs: at('2026-09-28T15:23:00Z') }))
      .toEqual({ minutes: 266, neededMinutes: 266, truncated: false });
    // A scan 30 minutes ago keeps the 75-minute base.
    expect(scanLookbackMinutes({ nowMs, previousScanStartedMs: nowMs - 30 * MINUTE }).minutes).toBe(75);
  });

  it('keeps the base window when no previous scan is known', async () => {
    const { scanLookbackMinutes } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(scanLookbackMinutes({ nowMs: Date.now(), previousScanStartedMs: NaN }))
      .toEqual({ minutes: 75, neededMinutes: null, truncated: false });
  });

  it('caps the window and says so', async () => {
    const { scanLookbackMinutes } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const nowMs = Date.now();
    expect(scanLookbackMinutes({ nowMs, previousScanStartedMs: nowMs - 20 * 60 * MINUTE }))
      .toMatchObject({ minutes: 720, truncated: true });
  });

  it('reads the workflow file from GITHUB_WORKFLOW_REF', async () => {
    const { monitorWorkflowFile } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(monitorWorkflowFile({ GITHUB_WORKFLOW_REF: 'a/b/.github/workflows/job-timeout-monitor.yml@refs/heads/main' }))
      .toBe('job-timeout-monitor.yml');
    expect(monitorWorkflowFile({})).toBe('job-timeout-monitor.yml');
  });
});

describe('main — a timeout between two sparse scans is still reported', () => {
  it('reports a run that timed out 4h ago when the previous scan started 5h ago', async () => {
    installGh({ previousScanStartedAt: iso(5 * 60 * MINUTE) });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(apiPaths()).toContain('repos/o/r/actions/workflows/job-timeout-monitor.yml/runs?status=success&per_page=1');
    expect(creates()).toHaveLength(1);
    expect(creates()[0][1].join(' ')).toContain(timedOutRun.html_url);
  });

  it('without a previous scan the fixed window still misses it (the old behaviour)', async () => {
    installGh({ previousScanStartedAt: null });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(creates()).toHaveLength(0);
  });
});
