import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VITEST_EXECUTION_JOB_NAME } from '../scripts/ci/lib/constants.mjs';

const execFileSync = vi.fn();
const appendFileSync = vi.fn();

vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

vi.mock('node:fs', () => {
  const mock = { appendFileSync: (...args: unknown[]) => appendFileSync(...args) };
  return { ...mock, default: mock };
});

beforeEach(() => {
  execFileSync.mockReset();
  appendFileSync.mockReset();
  vi.resetModules();
  delete process.env.JOB_STATUS;
  delete process.env.GITHUB_STEP_SUMMARY;
  delete process.env.RUNNER_ID;
  delete process.env.RUNNER_NAME;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('explain-job-verdict — selezione del job corrente', () => {
  it('sceglie il job omonimo partito più di recente e segnala l’ambiguità', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { selectCurrentJob } = await import('../scripts/ci/explain-job-verdict.mjs');
    const selected = selectCurrentJob([
      { id: 10, name: VITEST_EXECUTION_JOB_NAME, started_at: '2026-09-08T10:00:00Z' },
      { id: 11, name: VITEST_EXECUTION_JOB_NAME, started_at: '2026-09-08T10:01:00Z' },
    ]);

    expect(selected?.id).toBe(11);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('2 job omonimi'));
  });

  it('preferisce il job omonimo sul runner corrente', async () => {
    const { selectCurrentJob } = await import('../scripts/ci/explain-job-verdict.mjs');
    const selected = selectCurrentJob([
      { id: 10, name: VITEST_EXECUTION_JOB_NAME, runner_name: 'runner-current', started_at: '2026-09-08T10:00:00Z' },
      { id: 11, name: VITEST_EXECUTION_JOB_NAME, runner_name: 'runner-other', started_at: '2026-09-08T10:01:00Z' },
    ], { runnerName: 'runner-current' });

    expect(selected?.id).toBe(10);
  });
});

describe('explain-job-verdict — ramo verde', () => {
  it('scrive la riga di liveness senza chiamare la jobs API', async () => {
    process.env.JOB_STATUS = 'success';
    process.env.GITHUB_STEP_SUMMARY = '/tmp/summary';
    const { main } = await import('../scripts/ci/explain-job-verdict.mjs');

    main();

    expect(execFileSync).not.toHaveBeenCalled();
    expect(appendFileSync).toHaveBeenCalledWith(
      '/tmp/summary',
      expect.stringContaining('Nessuno step rosso'),
    );
  });
});
