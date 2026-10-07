import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
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
  loopClockSlot,
} from '../functions/src/loopClockDispatch.js';
import {
  LOOP_CLOCK_CORPUS_REPOSITORY,
  LOOP_CLOCK_INPUT,
  LOOP_CLOCK_RUN_MARKER_PREFIX,
  loopClockInputValue,
  loopClockRunMarker,
} from '../functions/src/loopClockTable.js';
import {
  LOOP_CLOCK_DOWN_ISSUE_TITLE,
  assessLoopClockFreshness,
  loopClockRunLimit,
  runLoopClockHealth,
  selectLoopClockRun,
} from '../scripts/ci/loop-clock-health.mjs';

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

  it('keeps the runtime reliability watchdog on the external clock', () => {
    expect(LOOP_CLOCK_ENTRIES).toContainEqual({
      id: 'site-runtime-reliability-watch',
      repo: 'site',
      workflow: 'runtime-reliability-watch.yml',
      everyMinutes: 30,
      introducedAt: '2026-10-08T06:00:00Z',
    });
  });

  it('keeps the hourly revenue monitor on the external clock', () => {
    expect(LOOP_CLOCK_ENTRIES).toContainEqual({
      id: 'site-revenue-signal-monitor',
      repo: 'site',
      workflow: 'revenue-signal-monitor.yml',
      everyMinutes: 60,
      introducedAt: '2026-10-07T16:50:03Z',
    });
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

  it('treats a tick that lands inside a slot as that slot', () => {
    const slot = Date.parse('2026-10-07T00:05:00Z');
    const onGrid = dueLoopClockEntries(new Date(slot)).map((entry) => entry.id);
    for (const lateBySeconds of [1, 59, 61, 150, 299]) {
      const late = dueLoopClockEntries(new Date(slot + lateBySeconds * 1000)).map((entry) => entry.id);
      expect(late).toEqual(onGrid);
    }
    const nextSlot = dueLoopClockEntries(new Date(slot + 300_000)).map((entry) => entry.id);
    const everyTick = LOOP_CLOCK_ENTRIES.filter((entry) => entry.everyMinutes === LOOP_CLOCK_TICK_MINUTES);
    expect(everyTick).toEqual([]);
    expect(nextSlot).not.toEqual(onGrid);
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

  // An undeclared dispatch input is a 422 for the whole dispatch, and a
  // workflow without the run-name marker would look stale to the observer
  // for ever: both are properties of the workflow file, so they are pinned here.
  it('lets every site workflow accept the marker input, name the run after it and take the entry inputs', () => {
    type DispatchInput = { type?: string; required?: boolean; options?: string[] };
    for (const entry of LOOP_CLOCK_ENTRIES.filter((candidate) => candidate.repo === 'site')) {
      const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/${entry.workflow}`, 'utf8')) as {
        'run-name'?: string;
        on?: { workflow_dispatch?: { inputs?: Record<string, DispatchInput> } };
      };
      const declared = workflow.on?.workflow_dispatch?.inputs ?? {};
      expect(declared[LOOP_CLOCK_INPUT], `${entry.workflow} ${LOOP_CLOCK_INPUT}`).toMatchObject({ type: 'string', required: false });

      const runName = String(workflow['run-name'] ?? '');
      expect(runName, entry.workflow).toContain(`${LOOP_CLOCK_RUN_MARKER_PREFIX}{0}]`);
      expect(runName, entry.workflow).toContain(`inputs.${LOOP_CLOCK_INPUT}`);
      expect(runName, entry.workflow).toContain("github.event_name == 'workflow_dispatch'");

      for (const [name, value] of Object.entries((entry as { inputs?: Record<string, string> }).inputs ?? {})) {
        expect(declared[name], `${entry.workflow} input ${name}`).toBeDefined();
        if (declared[name].options) expect(declared[name].options, `${entry.workflow} ${name}`).toContain(value);
      }
    }
  });

  it('builds the marker the run-name carries from the entry id and the slot minute', () => {
    const entry = customEntry('marker-entry');
    const slot = loopClockSlot('2026-10-07T10:52:41Z');
    expect(slot.toISOString()).toBe('2026-10-07T10:50:00.000Z');
    const value = loopClockInputValue(entry, slot);
    expect(value).toBe('marker-entry@2026-10-07T10:50Z');
    expect(`Some workflow ${LOOP_CLOCK_RUN_MARKER_PREFIX}${value}]`).toContain(loopClockRunMarker(entry));
    // An id that is a prefix of another must not match the longer one.
    expect(`${LOOP_CLOCK_RUN_MARKER_PREFIX}marker-entry-two@2026-10-07T10:50Z]`).not.toContain(loopClockRunMarker(entry));
    expect(() => loopClockInputValue({ id: 'Not A Slug' }, slot)).toThrow(TypeError);
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

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ id: entry.id, dispatched: true, status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`https://api.github.com/repos/owner/repo/actions/workflows/${entry.workflow}/dispatches`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(init.body))).toEqual({
      ref: 'main',
      inputs: { [LOOP_CLOCK_INPUT]: loopClockInputValue(entry, loopClockSlot(tick)) },
    });
  });

  it('sends the inputs an entry declares next to the marker and refuses an entry that redefines it', async () => {
    const entry = { ...customEntry('entry-with-inputs'), inputs: { mode: 'failures' } };
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await dispatchLoopClock({
      scheduledAt: tick,
      entries: [entry],
      fetchImpl,
      getRepoConfigImpl: repoConfig,
      getRemoteConfigValueImpl: async () => '',
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).inputs).toEqual({
      mode: 'failures',
      [LOOP_CLOCK_INPUT]: loopClockInputValue(entry, loopClockSlot(tick)),
    });

    const hijack = { ...customEntry('entry-redefining-marker'), inputs: { [LOOP_CLOCK_INPUT]: 'forged' } };
    let refused: unknown;
    try {
      await dispatchLoopClock({ entries: [hijack], fetchImpl, getRepoConfigImpl: repoConfig, getRemoteConfigValueImpl: async () => '' });
    } catch (error) {
      refused = error;
    }
    expect((refused as Error)?.name).toBe('TypeError');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    const issues = Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      created_at: `2026-10-07T0${index}:00:00Z`,
      labels: [],
    }));
    const fetchImpl = vi.fn(async (url: string) => url.includes('/issues?')
      ? new Response(JSON.stringify(issues), { status: 200 })
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

  it('filters the current issue listing instead of trusting search-index labels', async () => {
    const entry = { ...customEntry('condition-current-listing'), condition: 'untriaged-issues' };
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async (url: string) => url.includes('/issues?')
      ? new Response(JSON.stringify([
        { number: 1, pull_request: { url: 'https://example.invalid/pr/1' }, labels: [] },
        { number: 2, created_at: '2026-10-07T00:00:00Z', labels: [{ name: 'agent:triaged' }] },
      ]), { status: 200 })
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
      dispatched: false,
      reason: 'condition_no_untriaged_issues',
    });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/dispatches'))).toBe(false);
  });

  it('dispatches anyway when the current issue listing fails', async () => {
    const entry = { ...customEntry('condition-search-failed'), condition: 'untriaged-issues' };
    const tick = tickForEntries([entry]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/issues?')) throw new Error('listing failed: secret-token');
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

  it('fails the tick when the corpus token is missing, after the site entries were dispatched', async () => {
    const entries = [customEntry('site-with-token'), customEntry('corpus-without-token', 'corpus')];
    const tick = tickForEntries(entries);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
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

    const error = caught as LoopClockDispatchError;
    expect(error?.name).toBe('LoopClockDispatchError');
    expect(error.results.find((result) => result.id === entries[0].id)).toMatchObject({ dispatched: true });
    expect(error.results.find((result) => result.id === entries[1].id)).toMatchObject({
      dispatched: false,
      failed: true,
      reason: 'corpus_token_missing',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a corpus-only tick without its token as a failed dispatch', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('no request may leave without a token'); });
    let caught: unknown;
    try {
      await dispatchLoopClock({
        entries: [{ id: 'corpus-only', repo: 'corpus', workflow: 'x.yml', everyMinutes: 5 }],
        fetchImpl,
        getRemoteConfigValueImpl: async () => '',
      });
    } catch (error) {
      caught = error;
    }
    const error = caught as LoopClockDispatchError;
    expect(error?.name).toBe('LoopClockDispatchError');
    expect(error.results[0].failed).toBe(true);
    expect(error.results[0].reason).toBe('corpus_token_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
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

  const NOW = '2026-10-07T12:00:00Z';
  const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const clockRun = (entry: { id: string }, minutes: number, extra: Record<string, unknown> = {}) => ({
    createdAt: minutesAgo(minutes),
    databaseId: 1000 + minutes,
    url: `https://example.invalid/runs/${1000 + minutes}`,
    event: 'workflow_dispatch',
    headBranch: 'main',
    displayTitle: `Workflow ${LOOP_CLOCK_RUN_MARKER_PREFIX}${loopClockInputValue(entry, minutesAgo(minutes))}]`,
    ...extra,
  });
  const otherRun = (minutes: number, extra: Record<string, unknown> = {}) => ({
    createdAt: minutesAgo(minutes),
    databaseId: 5000 + minutes,
    url: `https://example.invalid/runs/${5000 + minutes}`,
    event: 'workflow_dispatch',
    headBranch: 'main',
    displayTitle: 'Workflow',
    ...extra,
  });
  const observe = (entries: Parameters<typeof runLoopClockHealth>[0]['entries'], runs: unknown[], options = {}) => {
    const createIssueImpl = vi.fn(async () => ({ number: 1 }));
    const resolveIssueImpl = vi.fn(async () => ({ resolved: 0 }));
    const listRunsImpl = vi.fn(async () => runs);
    return runLoopClockHealth({
      now: NOW,
      entries,
      repository: 'owner/site',
      listRunsImpl,
      untriagedIssuesImpl: async () => ({ count: 3, oldestCreatedAt: minutesAgo(600) }),
      createIssueImpl,
      resolveIssueImpl,
      ...options,
    }).then((report) => ({ report, createIssueImpl, resolveIssueImpl, listRunsImpl }));
  };

  it('counts only a workflow_dispatch on main that carries the marker of the entry', () => {
    const entry = { ...customEntry('picked'), everyMinutes: 30 };
    const sibling = { ...customEntry('picked-sibling'), everyMinutes: 30 };
    const wanted = clockRun(entry, 40);
    const runs = [
      otherRun(1),
      otherRun(2, { event: 'schedule' }),
      otherRun(3, { event: 'issues', displayTitle: 'An issue title' }),
      clockRun(sibling, 4),
      clockRun(entry, 5, { headBranch: 'some-branch' }),
      clockRun(entry, 6, { event: 'schedule' }),
      clockRun(entry, 7, { createdAt: 'not-a-date' }),
      clockRun(entry, 90),
      wanted,
    ];
    expect(selectLoopClockRun(runs, entry)).toBe(wanted);
    expect(selectLoopClockRun([otherRun(1)], entry)).toBeNull();
    expect(selectLoopClockRun(undefined as unknown as unknown[], entry)).toBeNull();
  });

  it('declares an entry stale when only non-clock runs are recent', async () => {
    const entry = { ...customEntry('clock-dead'), everyMinutes: 30 };
    const { report, createIssueImpl, resolveIssueImpl } = await observe([entry], [
      otherRun(1),
      otherRun(2, { event: 'issues', displayTitle: 'An issue title' }),
      otherRun(3, { event: 'schedule' }),
      clockRun(entry, 200),
    ]);
    expect(report.results[0]).toMatchObject({ id: entry.id, state: 'stale', reason: 'run_older_than_threshold' });
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    expect(resolveIssueImpl).not.toHaveBeenCalled();
  });

  // One fault, one issue: with every entry silent the clock itself is down.
  it('raises a single issue when no entry at all has a dispatch inside its threshold', async () => {
    const entries = [
      { ...customEntry('down-a'), everyMinutes: 15 },
      { ...customEntry('down-b'), everyMinutes: 60 },
      { ...customEntry('down-c', 'corpus'), everyMinutes: 240 },
    ];
    const [a, b, c] = entries;
    const { report, createIssueImpl, resolveIssueImpl } = await observe(entries, [
      otherRun(1),
      clockRun(a, 300),
      clockRun(b, 400),
      clockRun(c, 2000),
    ]);
    expect(report.clockDown).toBe(true);
    expect(report.results.map((result) => result.state)).toEqual(['stale', 'stale', 'stale']);
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    const issue = (createIssueImpl.mock.calls[0] as unknown as [{ title: string; description: string }])[0];
    expect(issue.title).toBe(LOOP_CLOCK_DOWN_ISSUE_TITLE);
    for (const entry of entries) expect(issue.description).toContain(`\`${entry.id}\``);
    expect(issue.description).toContain(minutesAgo(300));
    expect(resolveIssueImpl).not.toHaveBeenCalled();

    // One entry alive again: the clock works, the silent ones are their own fault.
    const partial = await observe(entries, [clockRun(a, 5), clockRun(b, 400), clockRun(c, 2000)]);
    expect(partial.report.clockDown).toBe(false);
    expect(partial.createIssueImpl.mock.calls.map((call) => (call as unknown as [{ title: string }])[0].title)).toEqual([
      `Loop clock stale: ${b.id}`,
      `Loop clock stale: ${c.id}`,
    ]);
    expect(partial.resolveIssueImpl.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      `Loop clock stale: ${a.id}`,
      LOOP_CLOCK_DOWN_ISSUE_TITLE,
    ]);
  });

  it('raises one issue, not one per entry, for a clock that never dispatched anything', async () => {
    const entries = [
      { ...customEntry('never-a'), everyMinutes: 30 },
      { ...customEntry('never-b', 'corpus'), everyMinutes: 60 },
    ];
    const { report, createIssueImpl, resolveIssueImpl } = await observe(entries, [otherRun(1), otherRun(2, { event: 'schedule' })]);
    expect(report.clockSeenSince).toBeNull();
    expect(report.results.map((result) => [result.id, result.state, result.reason])).toEqual([
      ['never-a', 'stale', 'clock_never_dispatched'],
      ['never-b', 'stale', 'clock_never_dispatched'],
    ]);
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    const issue = (createIssueImpl.mock.calls[0] as unknown as [{ title: string; description: string }])[0];
    expect(issue.title).toBe(LOOP_CLOCK_DOWN_ISSUE_TITLE);
    expect(issue.description).toContain('never-a');
    expect(issue.description).toContain(`never-b\` → ${LOOP_CLOCK_CORPUS_REPOSITORY}`);
    expect(resolveIssueImpl).not.toHaveBeenCalled();
  });

  it('does not date the clock from a marker that names no table entry', async () => {
    const entry = { ...customEntry('dated-entry'), everyMinutes: 30 };
    const probe = clockRun({ id: 'hand-made-probe' }, 400);
    const { report, createIssueImpl } = await observe([entry], [probe, otherRun(1)]);
    expect(report.clockSeenSince).toBeNull();
    expect(report.results[0]).toMatchObject({ state: 'stale', reason: 'clock_never_dispatched' });
    expect((createIssueImpl.mock.calls[0] as unknown as [{ title: string }])[0].title).toBe(LOOP_CLOCK_DOWN_ISSUE_TITLE);
  });

  // First hours after a deploy: the clock is alive, but an entry every 240
  // minutes has not had its first slot yet. Reporting it would open issues
  // that close by themselves a few hours later.
  it('gives no verdict on an entry whose first slot the young clock cannot have reached', async () => {
    const fast = { ...customEntry('young-fast'), everyMinutes: 15 };
    const slow = { ...customEntry('young-slow'), everyMinutes: 240 };
    const runsOf = (workflow: string) => (workflow === fast.workflow ? [clockRun(fast, 20), clockRun(fast, 5)] : [otherRun(3)]);
    const young = await observe([fast, slow], [], {
      listRunsImpl: vi.fn(async (_repository: string, workflow: string) => runsOf(workflow)),
    });
    expect(young.report.clockSeenSince).toBe(minutesAgo(20));
    expect(young.report.results.find((result) => result.id === fast.id)).toMatchObject({ state: 'healthy' });
    expect(young.report.results.find((result) => result.id === slow.id)).toMatchObject({
      state: 'too_early',
      reason: 'clock_younger_than_threshold',
    });
    expect(young.createIssueImpl).not.toHaveBeenCalled();

    // Same entry once the clock has been dispatching for longer than its threshold.
    const old = await observe([fast, slow], [], {
      listRunsImpl: vi.fn(async (_repository: string, workflow: string) => (
        workflow === fast.workflow ? [clockRun(fast, 800), clockRun(fast, 5)] : [otherRun(3)]
      )),
    });
    expect(old.report.results.find((result) => result.id === slow.id)).toMatchObject({
      state: 'stale',
      reason: 'no_marked_run_observed',
    });
    expect(old.createIssueImpl).toHaveBeenCalledTimes(1);
    expect((old.createIssueImpl.mock.calls[0] as unknown as [{ title: string }])[0].title).toBe(`Loop clock stale: ${slow.id}`);
  });

  it('gives a newly introduced entry its own warm-up window after the clock is established', async () => {
    const established = { ...customEntry('established'), everyMinutes: 15 };
    const newcomer = {
      ...customEntry('newcomer'),
      everyMinutes: 60,
      introducedAt: minutesAgo(30),
    };
    const runsOf = (workflow: string) => (
      workflow === established.workflow
        ? [clockRun(established, 400), clockRun(established, 5)]
        : [otherRun(1)]
    );
    const young = await observe([established, newcomer], [], {
      listRunsImpl: vi.fn(async (_repository: string, workflow: string) => runsOf(workflow)),
    });

    expect(young.report.results.find((result) => result.id === established.id)).toMatchObject({ state: 'healthy' });
    expect(young.report.results.find((result) => result.id === newcomer.id)).toMatchObject({
      state: 'too_early',
      reason: 'entry_younger_than_threshold',
    });
    expect(young.createIssueImpl).not.toHaveBeenCalled();

    const old = await observe([established, { ...newcomer, introducedAt: minutesAgo(200) }], [], {
      listRunsImpl: vi.fn(async (_repository: string, workflow: string) => runsOf(workflow)),
    });
    expect(old.report.results.find((result) => result.id === newcomer.id)).toMatchObject({
      state: 'stale',
      reason: 'no_marked_run_observed',
    });
    expect(old.createIssueImpl).toHaveBeenCalledTimes(1);
    expect((old.createIssueImpl.mock.calls[0] as unknown as [{ title: string }])[0].title).toBe(`Loop clock stale: ${newcomer.id}`);
  });

  it('keeps an entry healthy on its own marked dispatch and resolves its issue', async () => {
    const entry = { ...customEntry('clock-alive'), everyMinutes: 30 };
    const { report, createIssueImpl, resolveIssueImpl } = await observe([entry], [otherRun(1), clockRun(entry, 35)]);
    expect(report.results[0]).toMatchObject({ id: entry.id, state: 'healthy' });
    expect(report.errors).toBe(0);
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(resolveIssueImpl.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      `Loop clock stale: ${entry.id}`,
      LOOP_CLOCK_DOWN_ISSUE_TITLE,
    ]);
  });

  it('judges two entries of one workflow separately and reads that workflow once', async () => {
    const pending = { id: 'shared-pending', repo: 'site' as const, workflow: 'shared.yml', everyMinutes: 10 };
    const sweep = { id: 'shared-sweep', repo: 'site' as const, workflow: 'shared.yml', everyMinutes: 240 };
    const { report, listRunsImpl } = await observe([pending, sweep], [clockRun(pending, 5), clockRun(sweep, 900)]);
    expect(report.results.find((result) => result.id === pending.id)).toMatchObject({ state: 'healthy' });
    expect(report.results.find((result) => result.id === sweep.id)).toMatchObject({ state: 'stale' });
    expect(listRunsImpl).toHaveBeenCalledTimes(1);
    expect(listRunsImpl.mock.calls[0]).toEqual(['owner/site', 'shared.yml', loopClockRunLimit([pending, sweep]), 720]);
    // 720-minute window: 72 pending + 3 sweep dispatches, plus room for manual ones.
    expect(loopClockRunLimit([pending, sweep])).toBe(72 + 3 + 50);
    // Every workflow is read as far back as the widest threshold of the table.
    expect(loopClockRunLimit([pending], 720)).toBe(72 + 50);
  });

  it('observes the corpus entries on the corpus repository', async () => {
    const site = { ...customEntry('site-alive'), everyMinutes: 30 };
    const corpus = { ...customEntry('corpus-silent', 'corpus'), everyMinutes: 60 };
    const listRunsImpl = vi.fn(async (repository: string) => (
      repository === LOOP_CLOCK_CORPUS_REPOSITORY ? [otherRun(1)] : [clockRun(site, 500), clockRun(site, 10)]
    ));
    const { report, createIssueImpl } = await observe([site, corpus], [], { listRunsImpl });
    expect(listRunsImpl.mock.calls.map((call) => call[0])).toEqual(['owner/site', LOOP_CLOCK_CORPUS_REPOSITORY]);
    expect(report.results.find((result) => result.id === site.id)).toMatchObject({ state: 'healthy' });
    expect(report.results.find((result) => result.id === corpus.id)).toMatchObject({ state: 'stale' });
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    const issue = (createIssueImpl.mock.calls[0] as unknown as [{ title: string; description: string }])[0];
    expect(issue.title).toBe(`Loop clock stale: ${corpus.id}`);
    expect(issue.description).toContain(LOOP_CLOCK_CORPUS_REPOSITORY);
  });

  it('gives no verdict when the page read ends inside the threshold window', async () => {
    const entry = { ...customEntry('window-truncated'), everyMinutes: 30 };
    const limit = loopClockRunLimit([entry]);
    const fullPage = Array.from({ length: limit }, (_, index) => otherRun(index + 1));
    const { report, createIssueImpl, resolveIssueImpl } = await observe([entry], fullPage);
    expect(report.results[0]).toMatchObject({ id: entry.id, state: 'inconclusive', reason: 'run_window_truncated' });
    expect(report.errors).toBe(1);
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(resolveIssueImpl).not.toHaveBeenCalled();
  });

  it('does not expect a conditional entry while its condition is false', async () => {
    const entry = { ...customEntry('conditional-idle'), everyMinutes: 10, condition: 'untriaged-issues' };
    const { report, createIssueImpl, resolveIssueImpl, listRunsImpl } = await observe([entry], [], {
      untriagedIssuesImpl: async () => ({ count: 0, oldestCreatedAt: null }),
    });
    expect(report.results[0]).toMatchObject({ id: entry.id, state: 'not_due' });
    expect(listRunsImpl).not.toHaveBeenCalled();
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(resolveIssueImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a conditional entry inconclusive when the oldest issue date is unreadable', async () => {
    const entry = { ...customEntry('conditional-unknown-date'), everyMinutes: 10, condition: 'untriaged-issues' };
    const { report, createIssueImpl, resolveIssueImpl, listRunsImpl } = await observe([entry], [], {
      untriagedIssuesImpl: async () => ({ count: 1, oldestCreatedAt: null }),
    });
    expect(report.results[0]).toMatchObject({
      id: entry.id,
      state: 'inconclusive',
      reason: 'condition_oldest_created_at_missing',
    });
    expect(report.errors).toBe(1);
    expect(listRunsImpl).not.toHaveBeenCalled();
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(resolveIssueImpl).not.toHaveBeenCalled();
  });

  // The dispatcher checks the condition on its own tick: an issue opened a
  // minute before the observer runs has not met one yet.
  it('owes a conditional dispatch only once an untriaged issue has waited a whole threshold', async () => {
    const entry = { ...customEntry('conditional-owed'), everyMinutes: 10, condition: 'untriaged-issues' };
    const steady = { ...customEntry('conditional-steady'), everyMinutes: 30 };
    const runs = [clockRun(steady, 900), clockRun(steady, 10), clockRun(entry, 400)];

    const fresh = await observe([entry, steady], runs, {
      untriagedIssuesImpl: async () => ({ count: 1, oldestCreatedAt: minutesAgo(4) }),
    });
    expect(fresh.report.results.find((result) => result.id === entry.id)).toMatchObject({
      state: 'too_early',
      reason: 'untriaged_issues_newer_than_threshold',
    });
    expect(fresh.createIssueImpl).not.toHaveBeenCalled();

    const waiting = await observe([entry, steady], runs, {
      untriagedIssuesImpl: async () => ({ count: 1, oldestCreatedAt: minutesAgo(61) }),
    });
    expect(waiting.report.results.find((result) => result.id === entry.id)).toMatchObject({ state: 'stale' });
    expect(waiting.createIssueImpl).toHaveBeenCalledTimes(1);

    const unreadable = await observe([entry, steady], runs, {
      untriagedIssuesImpl: async () => { throw new Error('search unavailable'); },
    });
    expect(unreadable.report.results.find((result) => result.id === entry.id)).toMatchObject({
      state: 'inconclusive',
      reason: 'condition_lookup_failed',
    });
    expect(unreadable.report.errors).toBe(1);
    expect(unreadable.createIssueImpl).not.toHaveBeenCalled();
  });

  it('runs as a second step of the existing heartbeat workflow', () => {
    const workflow = readFileSync(`${root}/.github/workflows/orchestrator-heartbeat.yml`, 'utf8');
    const observer = readFileSync(`${root}/scripts/ci/loop-clock-health.mjs`, 'utf8');
    expect(workflow).toContain('node scripts/ci/loop-clock-health.mjs');
    expect(workflow).toContain('if: always()');
    expect(observer).toContain('createGithubIssue');
    expect(observer).toContain('resolveGithubIssue');
  });

  // The heartbeat job checks out a hand-written list of files, not the
  // repository: an import added to one of its scripts and not to that list is
  // an ERR_MODULE_NOT_FOUND on the runner, on every run, behind green tests.
  it('checks out every file the heartbeat scripts import, transitively', () => {
    const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/orchestrator-heartbeat.yml`, 'utf8')) as {
      jobs: Record<string, { steps: Array<{ uses?: string; run?: string; with?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs.heartbeat.steps;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const checkedOut = new Set(String(checkout?.with?.['sparse-checkout'] ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
    const entrypoints = steps.flatMap((step) => [...String(step.run ?? '').matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)/g)].map((match) => match[1]));
    expect(entrypoints).toEqual(expect.arrayContaining(['scripts/ci/orchestrator-heartbeat.mjs', 'scripts/ci/loop-clock-health.mjs']));

    const closure = new Set<string>();
    const queue = [...entrypoints];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (closure.has(file)) continue;
      closure.add(file);
      const source = readFileSync(`${root}/${file}`, 'utf8');
      for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        queue.push(posix.normalize(posix.join(posix.dirname(file), match[1])));
      }
    }
    expect([...closure].filter((file) => !checkedOut.has(file)).sort()).toEqual([]);
  });
});
