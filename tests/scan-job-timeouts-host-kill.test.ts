import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// THE OBSERVER for #5773/#5772/#5771.
//
// Those three issues («Deploy: guard di ordinamento CDN #2569 scaduto», locales
// de/fr/en, priority:urgent) are three symptoms of ONE cause. Run 31672320271
// (2026-08-13T06:01:15Z, `Deploy to GitHub Pages`) lost its `build-locale (it)` job
// at 06:19:48Z, INSIDE step 15 «Build (BUILD_LOCALE=it)»: no error, no stack, no exit
// code, and the API still reports that step `in_progress` on a job whose conclusion is
// `failure`. That is a runner HOST-KILL, not an application bug. The IT CDN push
// therefore never happened, and that blocks de/fr/en by design — the #2569 guard
// requires IT published first.
//
// The severe part is not the failure, it is that NOBODY NOTICED:
//   - step 59 «Report failure to GitHub Issues (build)» never ran (left `pending`,
//     downstream of the killed step) — `if: failure()` was never evaluated;
//   - `deploy-publish.yml` is gated on `workflow_run.conclusion == "success"` ⇒ no-op;
//   - this scanner only knew the `cancelled` + timeout-annotation signature, so a
//     `failure` with a frozen step fell through it entirely.
// Measured: 0 issues naming the dead IT leg. Only the 3 downstream symptoms existed.
//
// The real event is not reproducible on demand, so THIS FILE is the observer: it feeds
// the scanner a synthetic run carrying the exact API shape of 31672320271 and demands
// the classification. If the detection is ever removed or narrowed back, these fail.
//
// `gh` is mocked and routed by sub-command, same approach as
// scan-job-timeouts-dedup.test.ts.
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
const apiPaths = () => ghCalls().filter((a) => a[0] === 'api').map((a) => a[1]);

const MINUTES = 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const RUN = {
  id: 31672320271,
  name: 'Deploy to GitHub Pages',
  html_url: 'https://github.com/o/r/actions/runs/31672320271',
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'failure',
  created_at: iso(20 * MINUTES),
};

// Verbatim shape of the real job, trimmed: the step the host died inside is
// `in_progress` with a null conclusion, everything after it is `pending`.
const hostKilledJob = (overrides: Record<string, unknown> = {}) => ({
  name: 'build-locale (it)',
  status: 'completed',
  conclusion: 'failure',
  completed_at: iso(10 * MINUTES),
  check_run_url: 'https://api.github.com/repos/o/r/check-runs/1',
  steps: [
    { number: 5, name: 'Setup Node.js', status: 'completed', conclusion: 'success' },
    { number: 6, name: 'Install dependencies', status: 'completed', conclusion: 'skipped' },
    { number: 15, name: 'Build (BUILD_LOCALE=it)', status: 'in_progress', conclusion: null },
    { number: 20, name: 'Push generated assets to CDN (early)', status: 'pending', conclusion: null },
    { number: 53, name: 'Wait for IT CDN push (cross-shard ordering guard)', status: 'pending', conclusion: null },
    { number: 59, name: 'Report failure to GitHub Issues (build)', status: 'pending', conclusion: null },
  ],
  ...overrides,
});

// An ordinary red build: the failing step is CONCLUDED, nothing is left hanging.
const normallyFailedJob = () => ({
  name: 'vitest (unit + integration)',
  status: 'completed',
  conclusion: 'failure',
  completed_at: iso(10 * MINUTES),
  check_run_url: 'https://api.github.com/repos/o/r/check-runs/2',
  steps: [
    { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
    { number: 7, name: 'Run vitest', status: 'completed', conclusion: 'failure' },
    { number: 8, name: 'Post Checkout', status: 'completed', conclusion: 'success' },
  ],
});

/** Routes the scanner's `gh api` reads; `failureJobs` is what the failed run returns. */
function mockGh(failureJobs: unknown[], { cancelledRuns = [] as unknown[] } = {}) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'api') {
      const path = args[1];
      if (path.includes('actions/runs?status=cancelled')) {
        return JSON.stringify({ workflow_runs: cancelledRuns });
      }
      if (path.includes('actions/runs?status=failure')) {
        return JSON.stringify({ workflow_runs: [RUN] });
      }
      if (path.includes(`actions/runs/${RUN.id}/jobs`)) return JSON.stringify({ jobs: failureJobs });
      if (path.endsWith('/annotations')) return '[]';
      return '{}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return '[]';
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5780';
    return '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
});

afterEach(() => {
  delete process.env.GH_REPO;
  delete process.env.HOST_KILL_SETTLE_MS;
});

describe('detectHostKill — the classification, in isolation', () => {
  it('classifies `failure` + a step frozen `in_progress` as a host-kill', async () => {
    const { detectHostKill } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const kill = detectHostKill(hostKilledJob());

    expect(kill).toBeTruthy();
    // The step the runner died inside — the one diagnostic that makes the issue useful.
    expect(kill.stuck.map((s: { number: number }) => s.number)).toEqual([15]);
    expect(kill.stuck[0].name).toBe('Build (BUILD_LOCALE=it)');
    // …and the blast radius, reporter step included.
    expect(kill.neverRan).toHaveLength(3);
    expect(kill.neverRan.map((s: { number: number }) => s.number)).toContain(59);
  });

  it('does NOT classify an ordinary failure whose steps are all concluded', async () => {
    const { detectHostKill } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(detectHostKill(normallyFailedJob())).toBeNull();
  });

  it('ignores a job that has only just finished (mid-finalisation read)', async () => {
    // A just-failed job can be read back with a step still momentarily `in_progress`.
    // Reporting that would put a false host-kill issue on every ordinary red build;
    // the 75m lookback is 15m wider than the hourly cron, so the next scan still sees it.
    const { detectHostKill } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(detectHostKill(hostKilledJob({ completed_at: iso(5 * 1000) }))).toBeNull();
  });

  it('never fires on a job that is still legitimately running', async () => {
    const { detectHostKill } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(detectHostKill(hostKilledJob({ status: 'in_progress', conclusion: null }))).toBeNull();
  });
});

describe('scan-job-timeouts — a host-killed leg opens an issue instead of vanishing', () => {
  it('opens ONE `CI Failure: <workflow>` issue naming the frozen step', async () => {
    mockGh([hostKilledJob()]);

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    // The whole point of #5773/#5772/#5771: before this, it was 0.
    const created = callsFor('create');
    expect(created).toHaveLength(1);

    const title = created[0][created[0].indexOf('--title') + 1];
    expect(title).toBe('CI Failure: Deploy to GitHub Pages');
    // Must stay on the auto-closing side of close-recovered-failure-issues.mjs's
    // TITLE_RE — a host-kill is transient, and an issue nobody can close is forever.
    expect(title).toMatch(/^(?:Workflow|Crawler|CI) Failure: (.+)$/);

    const body = created[0][created[0].indexOf('--body') + 1];
    expect(body).toContain('build-locale (it)');
    expect(body).toContain('Build (BUILD_LOCALE=it)');
    expect(body).toContain('in_progress');
    expect(body).toContain(RUN.html_url);
    // The reason the workflow said nothing about itself has to be in the issue,
    // otherwise the next reader re-derives it from scratch.
    expect(body).toContain('if: failure()');
  });

  it('opens NOTHING for an ordinary failed run', async () => {
    mockGh([normallyFailedJob()]);

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('comment')).toHaveLength(0);
  });

  it('actually LISTS failed runs — the gap that made the dead leg invisible', async () => {
    // Before this change the scanner only ever asked for `status=cancelled`, so a
    // `failure` with a frozen step could not be seen no matter how it was classified.
    mockGh([hostKilledJob()]);

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(apiPaths().some((p) => p.includes('actions/runs?status=failure'))).toBe(true);
    // …without losing the timeout half.
    expect(apiPaths().some((p) => p.includes('actions/runs?status=cancelled'))).toBe(true);
  });

  it('a host-kill taking out several jobs of one run stays ONE issue', async () => {
    // A dead host takes every job on it. All of them map to the same title, so the
    // in-process memo must hold across the host-kill path too, not just the timeout one.
    mockGh([
      hostKilledJob(),
      hostKilledJob({ name: 'build-locale (de)', check_run_url: 'https://api.github.com/repos/o/r/check-runs/3' }),
    ]);

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(1);
    const comments = callsFor('comment');
    expect(comments).toHaveLength(1);
    expect(comments[0][2]).toBe('5780');
    // The second dead job is deduped, not dropped.
    expect(comments[0][comments[0].indexOf('--body') + 1]).toContain('build-locale (de)');
  });
});
