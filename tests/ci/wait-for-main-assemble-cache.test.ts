import { describe, expect, it, vi } from 'vitest';
import { waitForMainAssembleCache } from '../../scripts/ci/wait-for-main-assemble-cache.mjs';

const CACHE_KEY = 'assemble-jobs-Linux-0123456789abcdef_stats';
const BASE_SHA = 'a'.repeat(40);
const MAIN_SEED = {
  head_sha: BASE_SHA,
  head_branch: 'main',
  path: '.github/workflows/hourly-test-assemble-snapshot.yml@refs/heads/main',
  status: 'in_progress',
};

function makeHarness({ runs = [], caches = () => [] } = {}) {
  const outputs = new Map();
  const github = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: vi.fn(async () => ({ data: { workflow_runs: runs } })),
        getActionsCacheList: vi.fn(async () => ({ data: { actions_caches: caches() } })),
      },
    },
  };
  const core = {
    setOutput: vi.fn((name, value) => outputs.set(name, value)),
    info: vi.fn(),
    warning: vi.fn(),
  };
  const context = { repo: { owner: 'example', repo: 'jobs' } };
  return { github, core, context, outputs };
}

describe('waitForMainAssembleCache', () => {
  it('does not wait when no trusted main seed is in flight', async () => {
    const harness = makeHarness();

    const ready = await waitForMainAssembleCache({ ...harness, cacheKey: CACHE_KEY, baseSha: BASE_SHA });

    expect(ready).toBe(false);
    expect(harness.outputs.get('cache_ready')).toBe('false');
    expect(harness.github.rest.actions.getActionsCacheList).not.toHaveBeenCalled();
  });

  it('waits briefly and accepts only the exact cache key from main', async () => {
    let cacheChecks = 0;
    let elapsed = 0;
    const harness = makeHarness({
      runs: [MAIN_SEED],
      caches: () => {
        cacheChecks += 1;
        return cacheChecks === 2
          ? [{ key: `${CACHE_KEY}-different` }, { key: CACHE_KEY }]
          : [];
      },
    });

    const ready = await waitForMainAssembleCache({
      ...harness,
      cacheKey: CACHE_KEY,
      baseSha: BASE_SHA,
      now: () => elapsed,
      sleep: async (milliseconds) => { elapsed += milliseconds; },
    });

    expect(ready).toBe(true);
    expect(harness.outputs.get('cache_ready')).toBe('true');
    expect(harness.github.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'jobs',
      branch: 'main',
      head_sha: BASE_SHA,
      per_page: 100,
    });
    expect(harness.github.rest.actions.getActionsCacheList).toHaveBeenCalledTimes(2);
    expect(harness.github.rest.actions.getActionsCacheList).toHaveBeenLastCalledWith({
      owner: 'example',
      repo: 'jobs',
      ref: 'refs/heads/main',
      key: CACHE_KEY,
      per_page: 100,
    });
  });

  it('continues cold after the bounded wait expires', async () => {
    let elapsed = 0;
    const harness = makeHarness({ runs: [MAIN_SEED] });

    const ready = await waitForMainAssembleCache({
      ...harness,
      cacheKey: CACHE_KEY,
      baseSha: BASE_SHA,
      timeoutMs: 25,
      intervalMs: 10,
      now: () => elapsed,
      sleep: async (milliseconds) => { elapsed += milliseconds; },
    });

    expect(ready).toBe(false);
    expect(harness.outputs.get('cache_ready')).toBe('false');
    expect(elapsed).toBe(25);
    expect(harness.github.rest.actions.getActionsCacheList).toHaveBeenCalledTimes(4);
  });

  it('does not wait for a main run on a commit other than the merge base', async () => {
    const harness = makeHarness({ runs: [{ ...MAIN_SEED, head_sha: 'b'.repeat(40) }] });

    const ready = await waitForMainAssembleCache({ ...harness, cacheKey: CACHE_KEY, baseSha: BASE_SHA });

    expect(ready).toBe(false);
    expect(harness.outputs.get('cache_ready')).toBe('false');
    expect(harness.github.rest.actions.getActionsCacheList).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'HEAD', 'abc123', 'g'.repeat(40)])('does not wait without a valid base SHA (%s)', async (baseSha) => {
    const harness = makeHarness({ runs: [MAIN_SEED] });

    const ready = await waitForMainAssembleCache({ ...harness, cacheKey: CACHE_KEY, baseSha });

    expect(ready).toBe(false);
    expect(harness.outputs.get('cache_ready')).toBe('false');
    expect(harness.github.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
  });
});
