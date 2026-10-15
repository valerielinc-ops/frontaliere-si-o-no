import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  GCP_COST_MONITOR_CLOUD_SCHEDULE,
  GCP_COST_MONITOR_SLOTS_UTC,
  GCP_COST_MONITOR_WORKFLOW,
  dispatchGcpCostMonitorWorkflow,
} from '../functions/src/gcpCostMonitorDispatch.js';
import { GCP_COST_ISSUE_TITLE } from '../scripts/monitor-gcp-costs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoConfig = async () => ({ pat: 'test-token', owner: 'owner', repo: 'repo' });
const FAILURE = 'monitor-gcp-costs: dispatch da Cloud Scheduler assente o in ritardo';

describe('GCP cost monitor Cloud Scheduler dispatch', () => {
  it('dispatches monitor-gcp-costs.yml on main with no inputs', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await dispatchGcpCostMonitorWorkflow({
      scheduledAt: '2026-10-03T13:23:00Z',
      fetchImpl,
      getRepoConfigImpl: repoConfig,
    });

    expect(result, FAILURE).toEqual({ dispatched: true, scheduledAt: '2026-10-03T13:23:00.000Z', status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/monitor-gcp-costs.yml/dispatches');
    expect(GCP_COST_MONITOR_WORKFLOW).toBe('monitor-gcp-costs.yml');
    expect(init.method).toBe('POST');
    // Exactly `{ ref: 'main' }`: an `inputs.dry_run` here would silence the issue.
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main' });
  });

  it('dispatches on a forced run too, whatever the instant (the monitor is idempotent)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await dispatchGcpCostMonitorWorkflow({
      scheduledAt: '2026-10-03T10:05:17Z',
      fetchImpl,
      getRepoConfigImpl: repoConfig,
    });
    expect(result).toMatchObject({ dispatched: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when GitHub answers non-2xx, so the failed slot shows in the function log', async () => {
    await expect(dispatchGcpCostMonitorWorkflow({
      scheduledAt: '2026-10-03T13:23:00Z',
      fetchImpl: async () => new Response('denied', { status: 403 }),
      getRepoConfigImpl: repoConfig,
    })).rejects.toThrow('gcp_cost_monitor_dispatch_failed:403:denied');
    await expect(dispatchGcpCostMonitorWorkflow({
      scheduledAt: '2026-10-03T13:23:00Z',
      fetchImpl: async () => new Response('boom', { status: 502 }),
      getRepoConfigImpl: repoConfig,
    })).rejects.toThrow('gcp_cost_monitor_dispatch_failed:502:boom');
  });

  it('throws without a token and sends nothing', async () => {
    const fetchImpl = vi.fn();
    await expect(dispatchGcpCostMonitorWorkflow({
      scheduledAt: '2026-10-03T13:23:00Z',
      fetchImpl,
      getRepoConfigImpl: async () => ({ pat: '', owner: 'owner', repo: 'repo' }),
    })).rejects.toThrow('github_pat_not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs every 6 hours on the minute of the native cron', () => {
    expect(GCP_COST_MONITOR_SLOTS_UTC).toEqual(['01:23', '07:23', '13:23', '19:23']);
    const hours = GCP_COST_MONITOR_SLOTS_UTC.map((slot) => Number(slot.slice(0, 2)));
    const minutes = new Set(GCP_COST_MONITOR_SLOTS_UTC.map((slot) => Number(slot.slice(3))));
    expect([...minutes]).toEqual([23]);
    expect(hours.slice(1).map((hour, index) => hour - hours[index])).toEqual([6, 6, 6]);
    expect(GCP_COST_MONITOR_CLOUD_SCHEDULE).toBe(`23 ${hours.join(',')} * * *`);
  });

  it('is registered as a scheduled function in the region of the other dispatchers', () => {
    const functionsIndex = readFileSync(`${root}/functions/index.js`, 'utf8');
    const block = functionsIndex.match(/export const dispatchGcpCostMonitor = onSchedule\([\s\S]*?\n\);/)?.[0] ?? '';
    expect(block, FAILURE).toContain("region: 'europe-west6'");
    expect(block).toContain('schedule: GCP_COST_MONITOR_CLOUD_SCHEDULE');
    expect(block).toContain("timeZone: 'UTC'");
    expect(block).toContain('dispatchGcpCostMonitorWorkflow({ scheduledAt: event.scheduleTime })');
  });

  it('keeps the workflow dispatchable without inputs and its native cron as the safety net', () => {
    const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/${GCP_COST_MONITOR_WORKFLOW}`, 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe('false');
    expect(workflow.on.workflow_dispatch.inputs.dry_run.required).toBe(false);
    expect(workflow.on.schedule).toEqual([{ cron: '23 7 * * *' }]);
    // Overlapping scheduler and cron runs queue instead of racing on the issue.
    expect(workflow.concurrency).toEqual({ group: 'monitor-gcp-costs', 'cancel-in-progress': false });
  });

  it('keeps one fixed issue title, so four runs a day comment the same issue', () => {
    const monitor = readFileSync(`${root}/scripts/monitor-gcp-costs.mjs`, 'utf8');
    expect(GCP_COST_ISSUE_TITLE).not.toMatch(/\d/);
    expect(monitor).toContain('createGithubIssue({ title: GCP_COST_ISSUE_TITLE,');
    expect(monitor).toContain('resolveGithubIssue(GCP_COST_ISSUE_TITLE,');
  });
});
