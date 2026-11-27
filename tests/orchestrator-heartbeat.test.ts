import { describe, expect, it } from 'vitest';
import {
  API_ISSUE_TITLE,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_SCHEDULE_SLOTS,
  JOB_ALERT_API_ISSUE_TITLE,
  JOB_ALERT_MISSING_ISSUE_TITLE,
  JOB_ALERT_SCHEDULE_SLOTS,
  MISSING_ISSUE_TITLE,
  classifyHeartbeat,
  classifyJobAlertHeartbeat,
  fetchScheduledRuns,
  latestDueSlot,
  parseScheduleSlot,
  runAllHeartbeats,
  runJobAlertHeartbeat,
  runHeartbeat,
} from '../scripts/ci/orchestrator-heartbeat.mjs';
import { normalizeOrchestratorSlot } from '../functions/src/lib/orchestratorSlot.js';
import { JOB_ALERT_PRIMARY_INTRODUCED_AT } from '../functions/src/jobAlertSchedule.js';

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

  it('does not page inside the grace window', () => {
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T10:30:00Z'),
      runs: [],
    });
    expect(report.state).toBe('within_grace');
    expect(report.alert).toBe(false);
    expect(report.graceMinutes).toBe(DEFAULT_GRACE_MINUTES);
  });

  it('pages two hours after the slot now that Cloud Scheduler owns the clock', () => {
    // 600 minutes absorbed the ~4 h GitHub cron delay (issue 9541); the cron
    // is gone, so a slot still empty at 11:00 is a real hole.
    expect(DEFAULT_GRACE_MINUTES).toBe(120);
    expect(classifyHeartbeat({ now: new Date('2026-09-22T10:59:59Z'), runs: [] }).state).toBe('within_grace');
    expect(classifyHeartbeat({ now: new Date('2026-09-22T11:00:01Z'), runs: [] }).state).toBe('missing');
  });

  it('pages only after a due slot has no scheduled run', () => {
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T19:01:00Z'),
      runs: [],
    });
    expect(report.state).toBe('missing');
    expect(report.alert).toBe(true);
    expect(report.reason).toBe('no_scheduled_run_for_due_slot');
    expect(report.expectedSlot.label).toBe('09:00');
  });

  it('accepts a running or completed run of the slot, never a wrong workflow/event', () => {
    const now = new Date('2026-09-14T19:01:00Z');
    expect(classifyHeartbeat({ now, runs: [run('2026-09-14T10:15:00Z', { status: 'in_progress' })] }).state)
      .toBe('running');
    expect(classifyHeartbeat({ now, runs: [run('2026-09-14T10:15:00Z')] }).state).toBe('observed');
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T10:15:00Z', { path: '.github/workflows/other.yml' })],
    }).state).toBe('missing');
    // Cloud Scheduler dispatches the slot as a MARKED workflow_dispatch; an
    // unmarked manual or dry-run dispatch does not prove the wave ran.
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T09:00:04Z', {
        event: 'workflow_dispatch',
        display_title: 'Orchestrate Job Crawlers [cloud-scheduler 2026-09-14T09:00:00.000Z]',
      })],
    }).state).toBe('observed');
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T09:00:04Z', { event: 'workflow_dispatch', display_title: 'Orchestrate Job Crawlers' })],
    }).state).toBe('missing');
    expect(classifyHeartbeat({
      now,
      runs: [run('2026-09-14T10:15:00Z', { event: 'push' })],
    }).state).toBe('missing');
  });

  it('shares the minute-normalized scheduler marker with the dispatcher', () => {
    const slot = normalizeOrchestratorSlot('2026-09-14T09:00:03.022Z').toISOString();
    const report = classifyHeartbeat({
      now: new Date('2026-09-14T19:01:00Z'),
      runs: [run('2026-09-14T09:00:04Z', {
        event: 'workflow_dispatch',
        display_title: `Orchestrate Job Crawlers [cloud-scheduler ${slot}]`,
      })],
    });
    expect(slot).toBe('2026-09-14T09:00:00.000Z');
    expect(report.state).toBe('observed');
  });

  it('checks the job-alert primary independently and ignores its 12:07 fallback cron', () => {
    const now = new Date('2026-11-28T11:01:00Z');
    expect(classifyJobAlertHeartbeat({
      now,
      runs: [run('2026-11-28T05:00:04Z', {
        path: '.github/workflows/send-job-alerts.yml',
        event: 'workflow_dispatch',
        display_title: 'Send Job Alert Emails [cloud-scheduler 2026-11-28T05:00:00.000Z]',
      })],
    }).state).toBe('observed');
    expect(classifyJobAlertHeartbeat({
      now: new Date('2026-11-28T13:01:00Z'),
      runs: [run('2026-11-28T12:07:04Z', {
        path: '.github/workflows/send-job-alerts.yml',
        event: 'schedule',
      })],
    }).state).toBe('missing');
    expect(classifyJobAlertHeartbeat({
      now,
      runs: [run('2026-11-28T05:00:04Z', {
        path: '.github/workflows/send-job-alerts.yml',
        event: 'workflow_dispatch',
        display_title: 'Send Job Alert Emails',
      })],
    }).state).toBe('missing');
  });

  it('does not alert for a job-alert slot before the declared introduction', () => {
    const report = classifyJobAlertHeartbeat({
      now: new Date('2026-11-27T11:01:00Z'),
      runs: [],
    });
    expect(JOB_ALERT_PRIMARY_INTRODUCED_AT).toBe('2026-11-28T05:00:00Z');
    expect(report).toMatchObject({
      state: 'not_yet_introduced',
      alert: false,
      reason: 'slot_before_introduction',
    });
  });

  it('alerts after the first introduced slot has passed its grace window', () => {
    const report = classifyJobAlertHeartbeat({
      now: new Date('2026-11-28T07:01:00Z'),
      runs: [],
    });
    expect(report).toMatchObject({
      state: 'missing',
      alert: true,
      reason: 'no_scheduled_run_for_due_slot',
    });
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

  it('fetches the job-alert workflow and can report both watches together', async () => {
    const fetchImpl = async (endpoint: string) => {
      const isJobAlerts = endpoint.includes('send-job-alerts.yml');
      const runs = isJobAlerts
        ? [run('2026-11-28T05:00:04Z', {
          path: '.github/workflows/send-job-alerts.yml',
          event: 'workflow_dispatch',
          display_title: 'Send Job Alert Emails [cloud-scheduler 2026-11-28T05:00:00.000Z]',
        })]
        : [run('2026-11-28T09:00:04Z', {
          event: 'workflow_dispatch',
          display_title: 'Orchestrate Job Crawlers [cloud-scheduler 2026-11-28T09:00:00.000Z]',
        })];
      return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { status: 200 });
    };
    const jobReport = await runJobAlertHeartbeat({
      now: new Date('2026-11-28T11:01:00Z'),
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl,
    });
    expect(jobReport.state).toBe('observed');
    expect(jobReport.api?.endpoint).toContain('/actions/workflows/send-job-alerts.yml/runs');

    const all = await runAllHeartbeats({
      now: new Date('2026-11-28T11:01:00Z'),
      apiUrl: 'https://api.github.com',
      repository: 'owner/repo',
      token: 'test-token',
      fetchImpl,
    });
    expect(all.alert).toBe(false);
    expect(all.orchestrator.state).toBe('observed');
    expect(all.jobAlerts.state).toBe('observed');
  });

  it('keeps stable issue identities in the reporting contract', () => {
    expect(MISSING_ISSUE_TITLE).toBe('Orchestrator heartbeat: scheduled run missing');
    expect(API_ISSUE_TITLE).toBe('Orchestrator heartbeat: Actions API unavailable');
    expect(DEFAULT_SCHEDULE_SLOTS).toEqual(['09:00', '21:00']);
    expect(JOB_ALERT_SCHEDULE_SLOTS).toEqual(['05:00']);
    expect(JOB_ALERT_MISSING_ISSUE_TITLE).toBe('Job alert heartbeat: primary scheduled run missing');
    expect(JOB_ALERT_API_ISSUE_TITLE).toBe('Job alert heartbeat: Actions API unavailable');
  });
});
