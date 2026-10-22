import { describe, expect, it } from 'vitest';
import { aggregateJobAlertSubjectReport } from '../scripts/lib/job-alert-subject-ab-data.mjs';

describe('job-alert subject A/B aggregation', () => {
  it('matches open/click signals by message id and keeps Cloudflare out of primary rates', () => {
    const now = Date.now();
    const deliveries = [
      {
        email: 'a@example.com',
        alertId: 'alert-a',
        provider: 'maileroo',
        messageId: 'message-control',
        sentAt: now,
        variant: 'control',
        inExperiment: true,
      },
      {
        email: 'b@example.com',
        alertId: 'alert-b',
        provider: 'maileroo',
        messageId: 'message-match',
        sentAt: now,
        variant: 'match',
        inExperiment: true,
      },
      {
        email: 'c@example.com',
        alertId: 'alert-c',
        provider: 'cloudflare',
        messageId: 'message-cloudflare',
        sentAt: now,
        variant: 'match',
        inExperiment: true,
      },
      {
        email: 'd@example.com',
        alertId: 'alert-d',
        provider: 'mailtrap',
        messageId: 'message-mailtrap',
        sentAt: now,
        variant: 'novita',
        inExperiment: true,
      },
      {
        email: 'e@example.com',
        alertId: 'alert-e',
        provider: 'maileroo',
        messageId: 'message-holdback',
        sentAt: now,
        variant: 'control',
        inExperiment: false,
      },
    ];
    const events = [
      { event_type: 'open', message_id: 'message-control' },
      { event_type: 'click', message_id: 'message-control' },
      { event_type: 'open', message_id: 'message-match' },
    ];

    const report = aggregateJobAlertSubjectReport(deliveries, events);

    expect(report.totalSends).toBe(3);
    expect(report.trackedSends).toBe(2);
    expect(report.trackedOpens).toBe(2);
    expect(report.trackedClicks).toBe(1);
    expect(report.byVariant.control).toMatchObject({
      sends: 1,
      opens: 1,
      clicks: 1,
      trackedOpenRate: 100,
      trackedClickRate: 100,
      trackedCtor: 100,
    });
    expect(report.byVariant.match).toMatchObject({
      sends: 2,
      trackedSends: 1,
      trackedOpens: 1,
      trackedOpenRate: 100,
      trackedClickRate: 0,
    });
    expect(report.byVariant.novita.sends).toBe(0);
    expect(report.matchedEvents).toBe(3);
  });

  it('supports a legacy event without message id when alert and recipient identify one send', () => {
    const sentAt = Date.now();
    const report = aggregateJobAlertSubjectReport([
      {
        email: 'legacy@example.com',
        alertId: 'legacy-alert',
        provider: 'maileroo',
        messageId: null,
        sentAt,
        variant: 'scoperta',
        inExperiment: true,
      },
    ], [
      {
        event_type: 'open',
        email: 'legacy@example.com',
        alert_id: 'legacy-alert',
        occurred_at: new Date(sentAt + 1000).toISOString(),
      },
    ]);

    expect(report.byVariant.scoperta.opens).toBe(1);
    expect(report.byVariant.scoperta.trackedOpenRate).toBe(100);
  });

  it('assigns a legacy event to only the closest preceding delivery', () => {
    const report = aggregateJobAlertSubjectReport([
      {
        email: 'legacy@example.com',
        alertId: 'same-alert',
        provider: 'maileroo',
        messageId: null,
        sentAt: 1000,
        variant: 'control',
        inExperiment: true,
      },
      {
        email: 'legacy@example.com',
        alertId: 'same-alert',
        provider: 'maileroo',
        messageId: null,
        sentAt: 2000,
        variant: 'match',
        inExperiment: true,
      },
    ], [
      {
        event_type: 'open',
        email: 'legacy@example.com',
        alert_id: 'same-alert',
        occurred_at: new Date(2000).toISOString(),
      },
    ]);

    expect(report.byVariant.control.opens).toBe(0);
    expect(report.byVariant.match.opens).toBe(1);
  });
});
