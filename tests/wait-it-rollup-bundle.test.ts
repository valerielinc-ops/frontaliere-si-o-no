import { describe, it, expect } from 'vitest';
import {
  BUNDLE_MISSING_AFTER_SUCCESS_POLLS,
  BundleWaitError,
  bundleArtifactName,
  waitForItRollupBundle,
} from '../scripts/ci/wait-it-rollup-bundle.mjs';

const RUN_ID = '46130986291';

type Job = {
  name: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string | null;
  runner_id?: number;
};

const itJob = (attempt: number, conclusion: string | null, extra: Partial<Job> = {}): Job => ({
  name: 'build-locale (it)',
  run_attempt: attempt,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  started_at: `2026-11-28T1${attempt}:00:00Z`,
  completed_at: conclusion ? `2026-11-28T1${attempt}:50:00Z` : null,
  runner_id: attempt,
  ...extra,
});
// "Re-run failed jobs" lists a job it did not run under the new attempt, with
// the times and runner of the execution it copies.
const copyOf = (job: Job, attempt: number): Job => ({ ...job, run_attempt: attempt });

function run({ polls, published, runAttempt, budgetMs }: {
  polls: Array<Job[] | Error>;
  published: number[];
  runAttempt: number;
  budgetMs?: number;
}) {
  let clock = 0;
  let poll = 0;
  const asked: string[] = [];
  const logs: string[] = [];
  const gh = async (args: string[]) => {
    const url = args.at(-1) as string;
    if (url.includes('/jobs?')) {
      expect(url).toContain('filter=all');
      const next = polls[Math.min(poll++, polls.length - 1)];
      if (next instanceof Error) throw next;
      return JSON.stringify({ jobs: next, total_count: next.length });
    }
    const name = decodeURIComponent(url.split('name=')[1]);
    asked.push(name);
    const found = published.some((attempt) => name === bundleArtifactName(RUN_ID, attempt));
    return JSON.stringify({ artifacts: found ? [{ name, expired: false }] : [] });
  };
  const result = waitForItRollupBundle({
    gh,
    repo: 'owner/repo',
    runId: RUN_ID,
    runAttempt: String(runAttempt),
    budgetMs,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    log: (line: string) => logs.push(line),
  });
  return { result, asked, logs, elapsed: () => clock };
}

describe('waitForItRollupBundle', () => {
  it('uses the current attempt while IT builds in it', async () => {
    const { result } = run({ polls: [[itJob(1, null)]], published: [1], runAttempt: 1 });
    await expect(result).resolves.toBe(bundleArtifactName(RUN_ID, 1));
  });

  it('reuses the bundle of the attempt in which a not re-run IT leg really built it', async () => {
    const original = itJob(1, 'success');
    const { result, elapsed } = run({
      polls: [[original, copyOf(original, 2), copyOf(original, 3)]],
      published: [1],
      runAttempt: 3,
    });
    await expect(result).resolves.toBe(bundleArtifactName(RUN_ID, 1));
    expect(elapsed()).toBe(0);
  });

  it('waits for the new bundle when IT is run again, even if only its old entry is listed', async () => {
    const old = itJob(1, 'success');
    const { result, asked } = run({
      polls: [[old], [old, itJob(2, null)]],
      published: [1],
      runAttempt: 2,
      budgetMs: 60_000,
    });
    await expect(result).rejects.toThrow('Timed out');
    expect(asked).not.toContain(bundleArtifactName(RUN_ID, 1));
  });

  it('fails at once when IT failed in this attempt without a bundle', async () => {
    const { result, elapsed } = run({ polls: [[itJob(1, 'failure')]], published: [], runAttempt: 1 });
    await expect(result).rejects.toThrow('build-locale (it) ended as completed:failure');
    expect(elapsed()).toBe(0);
  });

  it('does not wait for the deadline when the bundle of a successful IT leg is gone', async () => {
    const original = itJob(1, 'success');
    const { result, asked } = run({ polls: [[original, copyOf(original, 2)]], published: [], runAttempt: 2 });
    await expect(result).rejects.toThrow('re-run all jobs');
    expect(asked).toHaveLength(BUNDLE_MISSING_AFTER_SUCCESS_POLLS);
  });

  it('keeps waiting through an unreadable poll', async () => {
    const { result, logs } = run({
      polls: [new Error('HTTP 502'), [itJob(1, null)]],
      published: [1],
      runAttempt: 1,
    });
    await expect(result).resolves.toBe(bundleArtifactName(RUN_ID, 1));
    expect(logs.join('\n')).toContain('HTTP 502');
  });

  it('rejects missing inputs', async () => {
    await expect(waitForItRollupBundle({ gh: async () => '', repo: '', runId: RUN_ID, runAttempt: '1' }))
      .rejects.toBeInstanceOf(BundleWaitError);
  });
});
