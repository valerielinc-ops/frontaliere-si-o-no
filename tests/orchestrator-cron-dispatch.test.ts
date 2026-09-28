import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  ORCHESTRATOR_CLOUD_SCHEDULE,
  ORCHESTRATOR_SLOTS_UTC,
  ORCHESTRATOR_WORKFLOW,
  dispatchOrchestrator,
  isOrchestratorSlot,
} from '../functions/src/orchestratorCronDispatch.js';
import { DEFAULT_SCHEDULE_SLOTS } from '../scripts/ci/orchestrator-heartbeat.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoConfig = async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' });

describe('crawler orchestrator Cloud Scheduler dispatch', () => {
  it('keeps the two nominal UTC slots and refuses any other instant', () => {
    expect(isOrchestratorSlot('2026-09-28T09:00:00Z')).toBe(true);
    expect(isOrchestratorSlot('2026-09-28T21:00:00Z')).toBe(true);
    // A Cloud Console "force run" carries the current time: no extra wave.
    expect(isOrchestratorSlot('2026-09-28T09:01:00Z')).toBe(false);
    expect(isOrchestratorSlot('2026-09-28T13:00:00Z')).toBe(false);
  });

  it('derives the Cloud Scheduler expression from the slots the heartbeat watches', () => {
    expect(ORCHESTRATOR_SLOTS_UTC).toEqual(DEFAULT_SCHEDULE_SLOTS);
    const hours = ORCHESTRATOR_SLOTS_UTC.map((slot) => Number(slot.slice(0, 2)));
    expect(ORCHESTRATOR_SLOTS_UTC.every((slot) => slot.endsWith(':00'))).toBe(true);
    expect(ORCHESTRATOR_CLOUD_SCHEDULE).toBe(`0 ${hours.join(',')} * * *`);
  });

  it('dispatches the workflow on main with its default inputs', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await dispatchOrchestrator({
      scheduledAt: '2026-09-28T21:00:00Z',
      fetchImpl,
      getRepoConfigImpl: repoConfig,
    });
    expect(result).toMatchObject({ dispatched: true, status: 204 });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/actions/workflows/${ORCHESTRATOR_WORKFLOW}/dispatches`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ref: 'main' }) }),
    );
  });

  it('reads no credential and dispatches nothing outside a slot', async () => {
    const fetchImpl = vi.fn();
    const getRepoConfigImpl = vi.fn();
    const result = await dispatchOrchestrator({ scheduledAt: '2026-09-28T09:30:00Z', fetchImpl, getRepoConfigImpl });
    expect(result).toMatchObject({ dispatched: false, reason: 'not_orchestrator_slot' });
    expect(getRepoConfigImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the dispatch is rejected, so Cloud Scheduler retries the slot', async () => {
    await expect(dispatchOrchestrator({
      scheduledAt: '2026-09-28T09:00:00Z',
      fetchImpl: async () => new Response('denied', { status: 403 }),
      getRepoConfigImpl: repoConfig,
    })).rejects.toThrow('orchestrator_dispatch_failed:403:denied');
    await expect(dispatchOrchestrator({
      scheduledAt: '2026-09-28T09:00:00Z',
      fetchImpl: vi.fn(),
      getRepoConfigImpl: async () => ({ pat: '', owner: 'owner', repo: 'repo' }),
    })).rejects.toThrow('github_pat_not_configured');
  });

  it('keeps Cloud Scheduler as the only clock, so no wave is dispatched twice', () => {
    const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/${ORCHESTRATOR_WORKFLOW}`, 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const functionsIndex = readFileSync(`${root}/functions/index.js`, 'utf8');
    expect(functionsIndex).toContain('export const dispatchCrawlerOrchestrator = onSchedule(');
    expect(functionsIndex).toContain('schedule: ORCHESTRATOR_CLOUD_SCHEDULE,');
    expect(functionsIndex).toContain("timeZone: 'UTC',");
  });
});
