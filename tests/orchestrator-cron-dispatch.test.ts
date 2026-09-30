import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  CLAIM_LEASE_MS,
  ORCHESTRATOR_CLOUD_SCHEDULE,
  ORCHESTRATOR_SLOTS_UTC,
  ORCHESTRATOR_TRIGGER_SOURCE,
  ORCHESTRATOR_WORKFLOW,
  dispatchOrchestrator,
  isOrchestratorSlot,
  schedulerRunMarker,
} from '../functions/src/orchestratorCronDispatch.js';
import { DEFAULT_SCHEDULE_SLOTS, SCHEDULER_RUN_MARKER_PREFIX } from '../scripts/ci/orchestrator-heartbeat.mjs';
import { normalizeOrchestratorSlot } from '../functions/src/lib/orchestratorSlot.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoConfig = async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' });

/** Same contract as the Firestore store: transactional acquire + lease. */
function memoryClaimStore() {
  const docs = new Map<string, { status: string; leaseUntilMs: number; attempts: number }>();
  return {
    docs,
    async acquire(key: string, nowMs: number) {
      const doc = docs.get(key);
      if (!doc) {
        docs.set(key, { status: 'pending', leaseUntilMs: nowMs + CLAIM_LEASE_MS, attempts: 1 });
        return 'acquired';
      }
      if (doc.status === 'dispatched') return 'dispatched';
      if (doc.leaseUntilMs > nowMs) return 'in_flight';
      doc.leaseUntilMs = nowMs + CLAIM_LEASE_MS;
      doc.attempts += 1;
      return 'reacquired';
    },
    async markDispatched(key: string) {
      const doc = docs.get(key);
      if (doc) doc.status = 'dispatched';
    },
  };
}

/**
 * A fake GitHub: the dispatch POST creates a run named by the workflow's
 * run-name rule; `loseResponse` makes it accept the dispatch and then fail
 * the request, the case a Cloud Scheduler retry must not replay.
 */
function fakeGithub({ loseResponse = false } = {}) {
  const runs: Array<{ id: number; display_title: string }> = [];
  let posts = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      posts += 1;
      const body = JSON.parse(String(init.body));
      const marked = body.inputs?.trigger_source === 'cloud-scheduler';
      runs.push({
        id: 1000 + posts,
        display_title: marked
          ? `Orchestrate Job Crawlers [cloud-scheduler ${body.inputs.scheduled_slot}]`
          : 'Orchestrate Job Crawlers',
      });
      if (loseResponse && posts === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { status: 200 });
  });
  return { fetchImpl, runs, posts: () => posts };
}

describe('crawler orchestrator Cloud Scheduler dispatch', () => {
  it('keeps the two nominal UTC slots and refuses any other instant', () => {
    expect(isOrchestratorSlot('2026-09-28T09:00:00Z')).toBe(true);
    expect(isOrchestratorSlot('2026-09-28T21:00:00Z')).toBe(true);
    // A Cloud Console "force run" carries the current time: no extra wave.
    expect(isOrchestratorSlot('2026-09-28T09:01:00Z')).toBe(false);
    expect(isOrchestratorSlot('2026-09-28T13:00:00Z')).toBe(false);
  });

  it('normalizes Cloud Scheduler delivery seconds before claiming and marking a slot', async () => {
    const rawSlot = '2026-09-28T09:00:03.022Z';
    const normalizedSlot = normalizeOrchestratorSlot(rawSlot);
    expect(normalizedSlot.toISOString()).toBe('2026-09-28T09:00:00.000Z');
    expect(isOrchestratorSlot(rawSlot)).toBe(true);

    const github = fakeGithub();
    const claimStore = memoryClaimStore();
    const result = await dispatchOrchestrator({
      scheduledAt: rawSlot,
      fetchImpl: github.fetchImpl,
      getRepoConfigImpl: repoConfig,
      claimStore,
    });

    expect(result).toMatchObject({ dispatched: true, scheduledAt: '2026-09-28T09:00:00.000Z' });
    expect(github.runs[0].display_title).toContain(schedulerRunMarker('2026-09-28T09:00:00.000Z'));
    expect(claimStore.docs.get(`${ORCHESTRATOR_WORKFLOW}_2026-09-28T09:00:00.000Z`)?.status)
      .toBe('dispatched');
  });

  it('derives the Cloud Scheduler expression from the slots the heartbeat watches', () => {
    expect(ORCHESTRATOR_SLOTS_UTC).toEqual(DEFAULT_SCHEDULE_SLOTS);
    const hours = ORCHESTRATOR_SLOTS_UTC.map((slot) => Number(slot.slice(0, 2)));
    expect(ORCHESTRATOR_SLOTS_UTC.every((slot) => slot.endsWith(':00'))).toBe(true);
    expect(ORCHESTRATOR_CLOUD_SCHEDULE).toBe(`0 ${hours.join(',')} * * *`);
  });

  it('dispatches the default wave on main, marked with its slot', async () => {
    const github = fakeGithub();
    const claimStore = memoryClaimStore();
    const result = await dispatchOrchestrator({
      scheduledAt: '2026-09-28T21:00:00Z',
      fetchImpl: github.fetchImpl,
      getRepoConfigImpl: repoConfig,
      claimStore,
    });
    expect(result).toMatchObject({ dispatched: true, status: 204 });
    expect(github.fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/actions/workflows/${ORCHESTRATOR_WORKFLOW}/dispatches`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          inputs: { trigger_source: ORCHESTRATOR_TRIGGER_SOURCE, scheduled_slot: '2026-09-28T21:00:00.000Z' },
        }),
      }),
    );
    expect(github.runs[0].display_title).toContain(schedulerRunMarker('2026-09-28T21:00:00.000Z'));
    expect(claimStore.docs.get(`${ORCHESTRATOR_WORKFLOW}_2026-09-28T21:00:00.000Z`)?.status).toBe('dispatched');
  });

  it('reads no credential and dispatches nothing outside a slot', async () => {
    const fetchImpl = vi.fn();
    const getRepoConfigImpl = vi.fn();
    const claimStore = { acquire: vi.fn(), markDispatched: vi.fn() };
    const result = await dispatchOrchestrator({ scheduledAt: '2026-09-28T09:30:00Z', fetchImpl, getRepoConfigImpl, claimStore });
    expect(result).toMatchObject({ dispatched: false, reason: 'not_orchestrator_slot' });
    expect(claimStore.acquire).not.toHaveBeenCalled();
    expect(getRepoConfigImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the dispatch is rejected, so Cloud Scheduler retries the slot', async () => {
    await expect(dispatchOrchestrator({
      scheduledAt: '2026-09-28T09:00:00Z',
      fetchImpl: async () => new Response('denied', { status: 403 }),
      getRepoConfigImpl: repoConfig,
      claimStore: memoryClaimStore(),
    })).rejects.toThrow('orchestrator_dispatch_failed:403:denied');
    await expect(dispatchOrchestrator({
      scheduledAt: '2026-09-28T09:00:00Z',
      fetchImpl: vi.fn(),
      getRepoConfigImpl: async () => ({ pat: '', owner: 'owner', repo: 'repo' }),
      claimStore: memoryClaimStore(),
    })).rejects.toThrow('github_pat_not_configured');
  });

  it('a retry after an accepted dispatch whose response was lost sends no second POST', async () => {
    const github = fakeGithub({ loseResponse: true });
    const claimStore = memoryClaimStore();
    const t0 = Date.parse('2026-09-28T09:00:01Z');
    const call = (nowMs: number) => dispatchOrchestrator({
      scheduledAt: '2026-09-28T09:00:00Z',
      fetchImpl: github.fetchImpl,
      getRepoConfigImpl: repoConfig,
      claimStore,
      now: () => nowMs,
    });
    await expect(call(t0)).rejects.toThrow('fetch failed');
    // Cloud Scheduler retries after minBackoffSeconds (60 s > the 45 s lease).
    const retry = await call(t0 + 60_000);
    expect(retry).toMatchObject({ dispatched: false, reason: 'duplicate', runId: 1001 });
    expect(github.posts()).toBe(1);
    // Any later replay short-circuits on the confirmed claim.
    expect(await call(t0 + 120_000)).toMatchObject({ dispatched: false, reason: 'duplicate' });
    expect(github.posts()).toBe(1);
  });

  it('a retry after a real failure dispatches once, and a concurrent delivery waits on the lease', async () => {
    const claimStore = memoryClaimStore();
    const t0 = Date.parse('2026-09-28T21:00:02Z');
    await expect(dispatchOrchestrator({
      scheduledAt: '2026-09-28T21:00:00Z',
      fetchImpl: async () => new Response('boom', { status: 502 }),
      getRepoConfigImpl: repoConfig,
      claimStore,
      now: () => t0,
    })).rejects.toThrow('orchestrator_dispatch_failed:502:boom');
    const github = fakeGithub();
    const concurrent = await dispatchOrchestrator({
      scheduledAt: '2026-09-28T21:00:00Z',
      fetchImpl: github.fetchImpl,
      getRepoConfigImpl: repoConfig,
      claimStore,
      now: () => t0 + 1_000,
    });
    expect(concurrent).toMatchObject({ dispatched: false, reason: 'in_flight' });
    expect(github.fetchImpl).not.toHaveBeenCalled();
    const retry = await dispatchOrchestrator({
      scheduledAt: '2026-09-28T21:00:00Z',
      fetchImpl: github.fetchImpl,
      getRepoConfigImpl: repoConfig,
      claimStore,
      now: () => t0 + 60_000,
    });
    expect(retry).toMatchObject({ dispatched: true });
    expect(github.posts()).toBe(1);
  });

  it('shares one marker between dispatcher, workflow run-name and heartbeat', () => {
    expect(schedulerRunMarker('2026-09-28T09:00:00.000Z').startsWith(SCHEDULER_RUN_MARKER_PREFIX)).toBe(true);
    const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/${ORCHESTRATOR_WORKFLOW}`, 'utf8'));
    expect(workflow['run-name']).toContain(`inputs.trigger_source == '${ORCHESTRATOR_TRIGGER_SOURCE}'`);
    expect(workflow['run-name']).toContain("inputs.dry_run != 'true'");
    expect(workflow['run-name']).toContain(`${SCHEDULER_RUN_MARKER_PREFIX}{0}]`);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(['trigger_source', 'scheduled_slot']),
    );
  });

  it('keeps Cloud Scheduler as the only clock, so no wave is dispatched twice', () => {
    const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/${ORCHESTRATOR_WORKFLOW}`, 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const functionsIndex = readFileSync(`${root}/functions/index.js`, 'utf8');
    expect(functionsIndex).toContain('export const dispatchCrawlerOrchestrator = onSchedule(');
    expect(functionsIndex).toContain('schedule: ORCHESTRATOR_CLOUD_SCHEDULE,');
    expect(functionsIndex).toContain("timeZone: 'UTC',");
    // A retry must arrive after the lease of the attempt it replaces.
    const backoff = Number(functionsIndex.match(/dispatchCrawlerOrchestrator[\s\S]*?minBackoffSeconds: (\d+)/)?.[1]);
    expect(backoff * 1000).toBeGreaterThan(CLAIM_LEASE_MS);
  });
});
