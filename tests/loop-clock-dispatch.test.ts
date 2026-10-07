import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  LOOP_CLOCK_CLOUD_SCHEDULE,
  LOOP_CLOCK_ENTRIES,
  LOOP_CLOCK_TICK_MINUTES,
  LoopClockDispatchError,
  dispatchLoopClock,
  dueLoopClockEntries,
} from '../functions/src/loopClockDispatch.js';
import { assessLoopClockFreshness } from '../scripts/ci/loop-clock-health.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoConfig = async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' });

function tickForEntries(entries: readonly { id: string }[]) {
  const start = Date.parse('2026-10-07T00:00:00Z');
  for (let step = 0; step <= 24 * 60 / LOOP_CLOCK_TICK_MINUTES; step += 1) {
    const tick = new Date(start + step * LOOP_CLOCK_TICK_MINUTES * 60_000);
    const due = dueLoopClockEntries(tick, entries);
    if (due.length === entries.length) return tick;
  }
  throw new Error('nessun tick comune trovato');
}

function customEntry(id: string, repo: 'site' | 'corpus' = 'site') {
  return { id, repo, workflow: `${id}.yml`, everyMinutes: LOOP_CLOCK_TICK_MINUTES };
}

describe('loop clock table and cadence', () => {
  it('keeps a frozen table with unique ids and cadences on the scheduler grid', () => {
    expect(Object.isFrozen(LOOP_CLOCK_ENTRIES)).toBe(true);
    expect(LOOP_CLOCK_ENTRIES.every((entry) => Object.isFrozen(entry))).toBe(true);
    const ids = LOOP_CLOCK_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LOOP_CLOCK_ENTRIES.every((entry) => entry.everyMinutes % LOOP_CLOCK_TICK_MINUTES === 0)).toBe(true);
  });

  it('aligns every entry to a tick and visits the whole table over its longest period', () => {
    const observed = new Set<string>();
    const longestCadence = Math.max(...LOOP_CLOCK_ENTRIES.map((entry) => entry.everyMinutes));
    const start = Date.parse('2026-10-07T00:00:00Z');
    for (let step = 0; step <= longestCadence / LOOP_CLOCK_TICK_MINUTES; step += 1) {
      const tick = new Date(start + step * LOOP_CLOCK_TICK_MINUTES * 60_000);
      for (const entry of dueLoopClockEntries(tick)) observed.add(entry.id);
    }
    expect([...observed].sort()).toEqual(LOOP_CLOCK_ENTRIES.map((entry) => entry.id).sort());
    expect(LOOP_CLOCK_CLOUD_SCHEDULE).toBe('*/5 * * * *');
  });

  it('points every site entry to a dispatchable workflow without required inputs', () => {
    for (const entry of LOOP_CLOCK_ENTRIES.filter((candidate) => candidate.repo === 'site')) {
      const workflowPath = `${root}/.github/workflows/${entry.workflow}`;
      expect(existsSync(workflowPath), entry.workflow).toBe(true);
      const workflow = YAML.parse(readFileSync(workflowPath, 'utf8')) as {
        on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
      };
      const trigger = workflow.on?.workflow_dispatch;
      expect(trigger, `${entry.workflow} workflow_dispatch`).toBeDefined();
      const inputs = Object.values(trigger?.inputs ?? {});
      expect(inputs.some((input) => input.required === true), entry.workflow).toBe(false);
    }
  });
});

describe('loop clock dispatch', () => {
  it('dispatches all due entries with the main ref and GitHub API headers', async () => {
    const entry = customEntry('dispatch-success');
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const report = await dispatchLoopClock({
      scheduledAt: tick,
      entries: [entry],
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async () => '',
    });

    expect(report.results).toEqual([
      expect.objectContaining({ id: entry.id, dispatched: true, status: 204 }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/actions/workflows/${entry.workflow}/dispatches`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'main' }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('continues after one failed dispatch and fails only after all due entries settle', async () => {
    const entries = [customEntry('failure-first'), customEntry('failure-second')];
    const tick = tickForEntries(entries);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('secret-token denied', { status: 403 })
        : new Response(null, { status: 204 });
    });

    let caught: unknown;
    try {
      await dispatchLoopClock({
        scheduledAt: tick,
        entries,
        fetchImpl,
        getRepoConfigImpl: repoConfig,
        getRemoteConfigValueImpl: async () => '',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LoopClockDispatchError);
    const error = caught as LoopClockDispatchError;
    expect(fetchImpl).toHaveBeenCalledTimes(entries.length);
    expect(error.results.find((result) => result.id === entries[0].id)).toMatchObject({ failed: true });
    expect(error.results.find((result) => result.id === entries[1].id)).toMatchObject({ dispatched: true });
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });

  it.each([
    { count: 0, expected: 'condition_no_untriaged_issues', dispatches: false },
    { count: 2, expected: 'condition_untriaged_issues', dispatches: true },
  ])('applies the untriaged condition for $count pending issue(s)', async ({ count, expected, dispatches }) => {
    const entry = { ...customEntry(`condition-${count}`), condition: 'untriaged-issues' };
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async (url: string) => url.includes('/search/issues')
      ? new Response(JSON.stringify({ total_count: count }), { status: 200 })
      : new Response(null, { status: 204 }));
    const report = await dispatchLoopClock({
      scheduledAt: tick,
      entries: [entry],
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async () => '',
    });

    expect(report.results[0]).toMatchObject({
      id: entry.id,
      ...(dispatches ? { condition: expected } : { reason: expected }),
    });
    expect(report.results[0].dispatched).toBe(dispatches);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/dispatches'))).toBe(dispatches);
  });

  it('dispatches anyway when the untriaged search fails', async () => {
    const entry = { ...customEntry('condition-search-failed'), condition: 'untriaged-issues' };
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/issues')) throw new Error('search failed: secret-token');
      return new Response(null, { status: 204 });
    });
    const report = await dispatchLoopClock({
      scheduledAt: tick,
      entries: [entry],
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async () => '',
    });

    expect(report.results[0]).toMatchObject({ dispatched: true, condition: 'condition_lookup_failed' });
    expect(JSON.stringify(report)).not.toContain('secret-token');
  });

  it('skips corpus entries without its Remote Config token while dispatching site entries', async () => {
    const entries = [customEntry('site-with-token'), customEntry('corpus-without-token', 'corpus')];
    const tick = tickForEntries(entries);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const report = await dispatchLoopClock({
      scheduledAt: tick,
      entries,
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async (key: string) => key === 'GITHUB_PAT_NANAKO' ? '' : '',
    });

    expect(report.results.find((result) => result.id === entries[0].id)).toMatchObject({ dispatched: true });
    expect(report.results.find((result) => result.id === entries[1].id)).toMatchObject({
      dispatched: false,
      reason: 'corpus_token_missing',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours a single-id and wildcard Remote Config switch', async () => {
    const entries = [customEntry('disabled-one'), customEntry('enabled-two')];
    const tick = tickForEntries(entries);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const oneDisabled = await dispatchLoopClock({
      scheduledAt: tick,
      entries,
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async (key: string) => key === 'LOOP_CLOCK_DISABLED' ? entries[0].id : '',
    });
    expect(oneDisabled.results.find((result) => result.id === entries[0].id)).toMatchObject({ reason: 'disabled' });
    expect(oneDisabled.results.find((result) => result.id === entries[1].id)).toMatchObject({ dispatched: true });

    fetchImpl.mockClear();
    const wildcard = await dispatchLoopClock({
      scheduledAt: tick,
      entries,
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async (key: string) => key === 'LOOP_CLOCK_DISABLED' ? '*' : '',
    });
    expect(wildcard.results.every((result) => result.reason === 'disabled')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('loop clock observer', () => {
  it('uses the three-cadence threshold with a sixty-minute floor', () => {
    expect(assessLoopClockFreshness({
      now: '2026-10-07T03:01:00Z',
      lastRunAt: '2026-10-07T00:00:00Z',
      everyMinutes: 30,
    })).toMatchObject({ stale: true, thresholdMinutes: 90 });
    expect(assessLoopClockFreshness({
      now: '2026-10-07T01:01:00Z',
      lastRunAt: '2026-10-07T00:00:00Z',
      everyMinutes: 10,
    })).toMatchObject({ stale: true, thresholdMinutes: 60 });
  });

  it('runs as a second step of the existing heartbeat workflow', () => {
    const workflow = readFileSync(`${root}/.github/workflows/orchestrator-heartbeat.yml`, 'utf8');
    const observer = readFileSync(`${root}/scripts/ci/loop-clock-health.mjs`, 'utf8');
    expect(workflow).toContain('node scripts/ci/loop-clock-health.mjs');
    expect(workflow).toContain('if: always()');
    expect(observer).toContain('createGithubIssue');
    expect(observer).toContain('resolveGithubIssue');
  });
});
