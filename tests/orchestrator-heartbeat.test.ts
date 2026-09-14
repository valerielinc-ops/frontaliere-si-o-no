import { describe, expect, it } from 'vitest';
import {
  API_ISSUE_TITLE,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_SCHEDULE_SLOTS,
  MISSING_ISSUE_TITLE,
  classifyHeartbeat,
  fetchScheduledRuns,
  latestDueSlot,
  parseScheduleSlot,
  runHeartbeat,
} from '../scripts/ci/orchestrator-heartbeat.mjs';

const run = (createdAt: string, overrides: Record<string, unknown> = {}) => ({
  id: 123,
  path: '.github/workflows/orchestrate-crawlers.yml',
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  created_at: createdAt,
  run_started_at: createdAt,
  html_url: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123',
  name: 'Orchestrate Job Crawlers',
  ...overrides,
});

describe('orchestrator heartbeat', () => {
  it('parses and orders the two UTC slots', () => {
    expect(parseScheduleSlot('09:00')).toEqual({ hour: 9, minute: 0, label: '09:00' });
    expect(latestDueSlot(new Date('2026-09-14T10:00:00Z'))).toMatchObject({
      slot: '09:00',
      at: new Date('2026-09-14T09:00:00.000Z'),
      nextAt: new Date('2026-09-14T21:00:00.000Z'),
    });
    expect(latestDueSlot(new Date('2026-09-14T08:59:59Z'))).toMatchObject({
      slot: '21:00',
      at: new Date('2026-09-13T21:00:00.000Z'),
    });
  });

  it('does not page inside the measured cron grace window', () => {
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T10:30:00Z'),
      runs: [],
    });
    expect(report.state).toBe('within_grace');
    expect(report.alert).toBe(false);
    expect(report.graceMinutes).toBe(DEFAULT_GRACE_MINUTES);
  });

  it('pages only after a due slot has no scheduled run', () => {
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T12:01:00Z'),
      runs: [],
    });
    expect(report.state).toBe('missing');
    expect(report.alert).toBe(true);
    expect(report.reason).toBe('no_scheduled_run_for_due_slot');
    expect(report.expectedSlot.label).toBe('09:00');
  });

  it('accepts a running or completed run but never a wrong workflow/event', () => {
    const now = new Date('2026-09-14T12:01:00Z');
    expect(classifyHeartbeat({ now, runs: [run('2026-09-14T10:15:00Z', { status: 'in_progress' })] }).state)
      .toBe('running');
    expect(classifyHeartbeat({ now, runs: [run('2026-09-14T10:15:00Z')] }).state).toBe('observed');
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T10:15:00Z', { path: '.github/workflows/other.yml' })],
    }).state).toBe('missing');
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T10:15:00Z', { event: 'workflow_dispatch' })],
    }).state).toBe('missing');
  });

  it('ignores a run from the next slot when checking the current one', () => {
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T23:00:00Z'),
      runs: [run('2026-09-14T22:00:00Z')],
    });
    expect(report.expectedSlot.label).toBe('21:00');
    expect(report.state).toBe('observed');
  });

  it('fails closed when the Actions response is not a valid collection', async () => {
    const response = new Response(JSON.stringify({ message: 'rate limited' }), { status: 200 });
    await expect(fetchScheduledRuns({
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl: async () => response,
    })).rejects.toThrow('actions_response_missing_workflow_runs');
    const report = await runHeartbeat({
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 200 }),
    });
    expect(report).toMatchObject({ state: 'inconclusive', alert: true, reason: 'actions_api_unavailable' });
  });

  it('keeps stable issue identities in the reporting contract', () => {
    expect(MISSING_ISSUE_TITLE).toBe('Orchestrator heartbeat: scheduled run missing');
    expect(API_ISSUE_TITLE).toBe('Orchestrator heartbeat: Actions API unavailable');
    expect(DEFAULT_SCHEDULE_SLOTS).toEqual(['09:00', '21:00']);
  });
});
