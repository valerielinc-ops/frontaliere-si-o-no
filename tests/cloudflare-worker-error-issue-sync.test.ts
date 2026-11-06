import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_URL,
  DRY_RUN_COMMAND,
  alertEntries,
  buildIssueBody,
  statusFromIssue,
  titleFor,
  workerReconcile,
} from '../scripts/cloudflare-worker-error-issue-sync.mjs';
import { decideMonitorIssue } from '../scripts/lib/monitor-issue-reconcile.mjs';

const measurement = {
  worker: 'frontaliere-locale-router',
  accountTag: 'account',
  window: {
    hours: 23,
    from: '2026-10-12T08:00:00.000Z',
    to: '2026-10-13T07:00:00.000Z',
  },
  complete: true,
  statuses: [
    {
      status: 'scriptThrewException',
      requests: 199,
      errors: 199,
      errorRate: 1,
      rows: 41,
      complete: true,
      latestAt: '2026-10-13T06:37:48.000Z',
    },
    { status: 'exceededResources', requests: 0, errors: 0, errorRate: 0, rows: 0, complete: true },
    { status: 'internalError', requests: 0, errors: 0, errorRate: 0, rows: 0, complete: true },
  ],
};

describe('Cloudflare Worker error issue reporter', () => {
  it('uses a stable status-specific title and actionable monitor sheet', () => {
    const entry = measurement.statuses[0];
    const body = buildIssueBody(entry, measurement.window.hours);

    expect(titleFor(entry)).toBe('Cloudflare Worker error: frontaliere-locale-router / scriptThrewException');
    expect(body).toContain('199');
    expect(body).toContain(DASHBOARD_URL);
    expect(body).toContain('## Scheda');
    expect(body).toContain(DRY_RUN_COMMAND);
    expect(body).toContain('one complete monitor window');
    expect(body).toContain('atteso=0 in una finestra completa');
    expect(statusFromIssue({ title: titleFor(entry) })).toBe('scriptThrewException');
  });

  it('closes after the first complete clean measurement', () => {
    const clean = {
      ...measurement,
      statuses: measurement.statuses.map((item) => ({ ...item, requests: 0, errors: 0, errorRate: 0 })),
    };
    const reconcile = workerReconcile(clean);
    const issue = { title: titleFor(clean.statuses[0]), state: 'OPEN', labels: [] };
    const verdict = reconcile.verdictFor(issue);

    expect(reconcile.confirmations).toBe(1);
    expect(decideMonitorIssue({
      issue,
      comments: [],
      events: [],
      verdict,
      family: reconcile.family,
      confirmations: reconcile.confirmations,
    })).toMatchObject({ action: 'close' });
  });

  it('does not declare a clean verdict while any error remains', () => {
    const reconcile = workerReconcile(measurement);
    const verdict = reconcile.verdictFor({ title: titleFor(measurement.statuses[0]) });

    expect(verdict).toMatchObject({ complete: true, clean: false });
    expect(verdict.evidence).toContain('scriptThrewException=199');
  });

  it('requires a complete zero series before a clean verdict', () => {
    const clean = {
      ...measurement,
      statuses: measurement.statuses.map((item) => ({ ...item, requests: 0, errors: 0, errorRate: 0 })),
    };
    const incomplete = { ...clean, complete: false };
    const cleanVerdict = workerReconcile(clean).verdictFor({ title: titleFor(clean.statuses[0]) });
    const incompleteVerdict = workerReconcile(incomplete).verdictFor({ title: titleFor(clean.statuses[0]) });

    expect(cleanVerdict).toMatchObject({ complete: true, clean: true });
    expect(incompleteVerdict.complete).toBe(false);
  });

  it('reports a nonzero capped series while keeping it ineligible for clean closure', () => {
    const incomplete = {
      ...measurement,
      complete: false,
      statuses: measurement.statuses.map((item) => ({ ...item, errors: 0, requests: 0, errorRate: 0 })),
    };
    incomplete.statuses[0] = {
      ...incomplete.statuses[0],
      errors: 3,
      requests: 3,
      complete: false,
    };

    expect(alertEntries(incomplete, 1)).toEqual([
      expect.objectContaining({
        status: 'scriptThrewException',
        errors: 3,
        complete: false,
        worker: 'frontaliere-locale-router',
      }),
    ]);
    expect(workerReconcile(incomplete).verdictFor({ title: titleFor(incomplete.statuses[0]) })).toMatchObject({
      clean: false,
      complete: false,
    });
  });
});
