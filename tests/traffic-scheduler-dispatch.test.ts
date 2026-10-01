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
  it('uses eight weekday slots that fit the provider quota budget', () => {
    expect(isTrafficCollectionSlot('2026-09-22T04:00:00Z')).toBe(false);
    expect(isTrafficCollectionSlot('2026-09-22T05:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T07:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T07:30:00Z')).toBe(false);
    expect(isTrafficCollectionSlot('2026-09-22T11:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T11:30:00Z')).toBe(false);
    expect(isTrafficCollectionSlot('2026-09-22T14:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T17:00:00Z')).toBe(true);
    expect(isTrafficCollectionSlot('2026-09-22T17:30:00Z')).toBe(false);
    expect(isTrafficCollectionSlot('2026-09-22T18:00:00Z')).toBe(false);

    const weekdaySlots = [];
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 30]) {
        const iso = `2026-09-22T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
        if (isTrafficCollectionSlot(iso)) weekdaySlots.push(`${hour}:${minute}`);
      }
    }
    expect(weekdaySlots).toEqual(['5:0', '6:0', '7:0', '11:0', '14:0', '15:0', '16:0', '17:0']);
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
    expect(at('2026-09-22T10:59:59Z')).toBe('2026-09-22T07:00:00.000Z');
    expect(at('2026-09-22T03:59:00Z')).toBe('2026-09-21T17:00:00.000Z');
    expect(at('2026-09-21T03:59:00Z')).toBe('2026-09-20T18:00:00.000Z');
    expect(at('2026-09-19T05:59:00Z')).toBe('2026-09-18T17:00:00.000Z');
  });

  it('dispatches the existing workflow on a due slot', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await dispatchTrafficScheduler({
      scheduledAt: '2026-09-22T14:00:00Z',
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
      scheduledAt: '2026-09-22T14:00:00Z',
      fetchImpl: async () => new Response('denied', { status: 403 }),
      getRepoConfigImpl: async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' }),
    })).rejects.toThrow('traffic_scheduler_dispatch_failed:403:denied');
  });

  it('keeps Cloud Scheduler as the only scheduled clock for the workflow', () => {
    const workflow = readFileSync(`${root}/.github/workflows/traffic-scheduler.yml`, 'utf8');
    const functionsIndex = readFileSync(`${root}/functions/index.js`, 'utf8');
    expect(workflow).not.toMatch(/^\s+schedule:/m);
    expect(functionsIndex).toContain('export const dispatchTrafficCollection = onSchedule(');
    expect(functionsIndex).toContain("schedule: '0 * * * *'");
  });

  it('leaves bounded tail time after the full traffic collection pass', () => {
    const workflow = readFileSync(`${root}/.github/workflows/traffic-scheduler.yml`, 'utf8');
    const timeout = Number(/jobs:\s+collect:[\s\S]*?timeout-minutes:\s*(\d+)/u.exec(workflow)?.[1]);
    expect(timeout).toBeGreaterThanOrEqual(15);
  });

  it('uses a complete blobless checkout for the non-thin history push', () => {
    const workflow = readFileSync(`${root}/.github/workflows/traffic-scheduler.yml`, 'utf8');
    const checkout = workflow.match(/- name: Checkout[\s\S]*?- name: Setup Node\.js/u)?.[0] ?? '';

    expect(checkout).toContain('fetch-depth: 0');
    expect(checkout).toContain('filter: blob:none');
  });
});
