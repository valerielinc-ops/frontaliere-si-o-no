import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  TRAFFIC_SCHEDULER_WORKFLOW,
  dispatchTrafficScheduler,
  isTrafficCollectionSlot,
} from '../functions/src/trafficSchedulerDispatch.js';
import { latestTrafficCollectionSlotAtOrBefore } from '../functions/src/lib/trafficCollectionCalendar.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('traffic scheduler Cloud dispatch', () => {
  it('preserves the weekday peak and midday slots', () => {
    expect(isTrafficCollectionSlot('2026-09-22T04:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T07:30:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T11:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T11:30:00Z')).toBe(false);
    expect(isTrafficCollectionSlot('2026-09-22T14:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T17:30:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T18:00:00Z')).toBe(false);
  });

  it('preserves the four weekend slots without weekday half-hours', () => {
    expect(isTrafficCollectionSlot('2026-09-20T06:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-20T10:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-20T14:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-20T18:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-20T14:30:00Z')).toBe(false);
  });

  it('finds the latest calendar slot at or before an instant (freshness check, #9658)', () => {
    const at = (iso: string) => latestTrafficCollectionSlotAtOrBefore(iso)?.toISOString();
    expect(at('2026-09-22T11:00:00Z')).toBe('2026-09-22T11:00:00.000Z');
    expect(at('2026-09-22T13:10:50Z')).toBe('2026-09-22T11:00:00.000Z');
    expect(at('2026-09-22T10:59:59Z')).toBe('2026-09-22T07:30:00.000Z');
    expect(at('2026-09-22T03:59:00Z')).toBe('2026-09-21T17:30:00.000Z');
    expect(at('2026-09-21T03:59:00Z')).toBe('2026-09-20T18:00:00.000Z');
    expect(at('2026-09-19T05:59:00Z')).toBe('2026-09-18T17:30:00.000Z');
  });

  it('dispatches the existing workflow on a due slot', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await dispatchTrafficScheduler({
      scheduledAt: '2026-09-22T14:30:00Z',
      fetchImpl,
      getRepoConfigImpl: async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' }),
    });

    expect(result).toMatchObject({ dispatched: true, status: 204 });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/actions/workflows/${TRAFFIC_SCHEDULER_WORKFLOW}/dispatches`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ref: 'main' }) }),
    );
  });

  it('does not read credentials or dispatch outside a collection slot', async () => {
    const fetchImpl = vi.fn();
    const getRepoConfigImpl = vi.fn();
    const result = await dispatchTrafficScheduler({
      scheduledAt: '2026-09-22T11:30:00Z',
      fetchImpl,
      getRepoConfigImpl,
    });

    expect(result).toMatchObject({ dispatched: false, reason: 'not_collection_slot' });
    expect(getRepoConfigImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails loudly when the dispatch API rejects the slot', async () => {
    await expect(dispatchTrafficScheduler({
      scheduledAt: '2026-09-22T14:30:00Z',
      fetchImpl: async () => new Response('denied', { status: 403 }),
      getRepoConfigImpl: async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' }),
    })).rejects.toThrow('traffic_scheduler_dispatch_failed:403:denied');
  });

  it('keeps Cloud Scheduler as the only scheduled clock for the workflow', () => {
    const workflow = readFileSync(`${root}/.github/workflows/traffic-scheduler.yml`, 'utf8');
    const functionsIndex = readFileSync(`${root}/functions/index.js`, 'utf8');
    expect(workflow).not.toMatch(/^\s+schedule:/m);
    expect(functionsIndex).toContain('export const dispatchTrafficCollection = onSchedule(');
    expect(functionsIndex).toContain("schedule: '0,30 * * * *'");
  });
});
