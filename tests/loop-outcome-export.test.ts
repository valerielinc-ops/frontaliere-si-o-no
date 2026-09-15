import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL1TelemetryExport,
  buildL4OutcomeLedger,
  buildL5DecisionMomentExport,
  buildL9OutcomeLedger,
  exportL4,
  exportL5,
  GoogleDataClient,
} from '../scripts/ci/export-loop-outcomes.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const ROOT = 'projects/test/databases/(default)/documents';

function row(path: string, data: Record<string, unknown>) {
  return { name: `${ROOT}/${path}`, data };
}

describe('read-only loop outcome exporters', () => {
  it('parses Firestore runQuery streamed response records', async () => {
    const stream = [
      JSON.stringify({
        document: {
          name: `${ROOT}/job_alert_subscribers/user@example.test`,
          fields: { active: { booleanValue: true } },
        },
      }),
      JSON.stringify({ done: true }),
    ].join('\n');
    const client = new GoogleDataClient({
      serviceAccount: { project_id: 'test', client_email: 'test@example.test', private_key: 'unused' },
      fetchImpl: async () => ({ ok: true, text: async () => stream }),
    });
    (client as any).token = { value: 'test-token', expiresAt: Date.now() + 120_000 };

    await expect(client.runQuery({ collectionId: 'job_alert_subscribers' })).resolves.toEqual([{
      name: `${ROOT}/job_alert_subscribers/user@example.test`,
      data: { active: true },
    }]);
  });

  it('adds fresh L1 session fields without discarding the existing baseline', () => {
    const output = buildL1TelemetryExport({ _meta: { issue: 4304 }, oldFact: true }, {
      usefulSessions: 18595,
      errorFreeUsefulSessions: 7738,
      observedErrorEvents: 28900,
      generatedAt: NOW.toISOString(),
      telemetryWindow: { start: '2026-09-08T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    });
    expect(output).toMatchObject({
      oldFact: true,
      usefulSessions: 18595,
      errorFreeUsefulSessions: 7738,
      _meta: { issue: 4304, generatedAt: NOW.toISOString() },
    });
  });

  it('builds an independent, read-only L5 decision-moment outcome', () => {
    const output = buildL5DecisionMomentExport({
      eligibleDecisionSessions: 120,
      nextUsefulActions: 45,
      generatedAt: NOW.toISOString(),
      telemetryWindow: { start: '2026-09-04T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    });
    expect(output).toMatchObject({
      independent: true,
      eligibleDecisionSessions: 120,
      nextUsefulActions: 45,
      evidence: {
        sourceRefs: ['decision-surfaces', 'posthog'],
        sessionJoin: 'properties.$session_id',
        eventContract: {
          completionEvent: 'decision_moment_completed',
          nextActionEvent: 'decision_moment_next_action',
        },
      },
      export: {
        readOnly: true,
        publishedDataUntouched: true,
        noDarkPatterns: true,
        noUnsupportedTimingPromise: true,
        noInvasivePersonalization: true,
      },
    });
  });

  it('exports L5 counts from a bounded PostHog session join without writing source data', async () => {
    const calls: Array<{ query: string; config: Record<string, string> }> = [];
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-export-test-'));
    const output = await exportL5({
      now: NOW,
      days: 8,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: {
        remoteConfig: async () => ({
          parameters: {
            SERVER_POSTHOG_PERSONAL_API_KEY: { defaultValue: { value: 'test-key' } },
            SERVER_POSTHOG_PROJECT_ID: { defaultValue: { value: '123' } },
            SERVER_POSTHOG_HOST: { defaultValue: { value: 'https://posthog.test' } },
          },
        }),
      } as any,
      posthogRunner: async (query: string, config: Record<string, string>) => {
        calls.push({ query, config });
        return { columns: ['eligibleDecisionSessions', 'nextUsefulActions'], results: [[120, 45]] };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("event = 'decision_moment_completed'");
    expect(calls[0].query).toContain("event = 'decision_moment_next_action'");
    expect(calls[0].query).toContain('GROUP BY properties.$session_id');
    expect(calls[0].query).toContain('2026-09-04T00:00:00.000Z');
    expect(calls[0].query).toContain('2026-09-12T00:00:00.000Z');
    expect(calls[0].config).toMatchObject({ apiKey: 'test-key', projectId: '123', host: 'https://posthog.test' });
    expect(output).toMatchObject({
      independent: true,
      eligibleDecisionSessions: 120,
      nextUsefulActions: 45,
      telemetryWindow: { start: '2026-09-04T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'outcomes.json'), 'utf8'))).toMatchObject({
      independent: true,
      export: { publishedDataUntouched: true },
    });
  });

  it('counts only consented, attributable L4 deliveries and records the guardrails', () => {
    const output = buildL4OutcomeLedger({
      now: NOW,
      alertRows: [row('job_alert_subscribers/user@example.test/alerts/a1', { active: true })],
      jobAlertRoots: [row('job_alert_subscribers/user@example.test', {
        status: 'confirmed',
        last_site_visit_at: '2026-09-12T11:00:00.000Z',
        last_site_visit_uid: 'uid-1',
        last_site_visit_visible: true,
      })],
      newsletterRoots: [row('newsletter_subscribers/user@example.test', { status: 'confirmed' })],
      deliveryRows: [row('job_alert_subscribers/user@example.test/campaign_deliveries/d1', {
        campaign_id: 'a1',
        sent_at: '2026-09-12T09:00:00.000Z',
        scheduled_for: '2026-09-12T08:45:00.000Z',
        send_time_source: 'personal',
        delivered_at: '2026-09-12T09:01:00.000Z',
        opened_at: '2026-09-12T10:00:00.000Z',
        clicked_links: ['https://example.test/job'],
      })],
      predicates: {
        evaluateJobAlertConsent: () => ({ allowed: true, reason: 'explicit-alert' }),
        isCrossChannelStop: () => false,
        isJobAlertExcluded: () => false,
        readReturnVisitStamp: () => ({ atMs: Date.parse('2026-09-12T11:00:00.000Z') }),
        classifyReturnVisit: () => ({ returned: true }),
      },
    });
    expect(output).toMatchObject({
      eligibleConsentedUsers: 1,
      deliveredAlerts: 1,
      openedAlerts: 1,
      clickedAlerts: 1,
      returningUsers7d: 1,
      duplicateSends: 0,
      export: {
        consentChecked: true,
        deduplicationChecked: true,
        quietHoursChecked: true,
        externalDeliveryUntouched: true,
        unattributedDeliveryReasons: {
          missingAlertId: 0,
          missingSentAt: 0,
          noConsentedAlert: 0,
        },
      },
    });
  });

  it('fails closed when an L4 delivery cannot be attributed or scheduled', () => {
    const output = buildL4OutcomeLedger({
      now: NOW,
      alertRows: [row('job_alert_subscribers/user@example.test/alerts/a1', { active: true })],
      jobAlertRoots: [row('job_alert_subscribers/user@example.test', {})],
      newsletterRoots: [row('newsletter_subscribers/user@example.test', {})],
      deliveryRows: [row('job_alert_subscribers/user@example.test/campaign_deliveries/d1', {
        sent_at: '2026-09-12T09:00:00.000Z',
      })],
      predicates: { evaluateJobAlertConsent: () => ({ allowed: true }) },
    });
    expect(output.export).toMatchObject({
      consentChecked: false,
      deduplicationChecked: false,
      quietHoursChecked: false,
      unattributedDeliveries: 1,
      unattributedDeliveryReasons: {
        missingAlertId: 1,
        missingSentAt: 0,
        noConsentedAlert: 0,
      },
    });
  });

  it('attributes a consented historical delivery after the alert is no longer active', () => {
    const output = buildL4OutcomeLedger({
      now: NOW,
      alertRows: [row('job_alert_subscribers/user@example.test/alerts/a1', { active: false })],
      jobAlertRoots: [row('job_alert_subscribers/user@example.test', {})],
      newsletterRoots: [row('newsletter_subscribers/user@example.test', {})],
      deliveryRows: [row('job_alert_subscribers/user@example.test/campaign_deliveries/d1', {
        campaign_id: 'a1',
        sent_at: '2026-09-12T09:00:00.000Z',
        scheduled_for: '2026-09-12T08:45:00.000Z',
        send_time_source: 'personal',
        delivered_at: '2026-09-12T09:01:00.000Z',
      })],
      predicates: {
        evaluateJobAlertConsent: () => ({ allowed: true, reason: 'explicit-alert' }),
        isCrossChannelStop: () => true,
        isJobAlertExcluded: () => true,
      },
    });

    expect(output).toMatchObject({
      eligibleConsentedUsers: 0,
      deliveredAlerts: 1,
      export: {
        consentChecked: true,
        deduplicationChecked: true,
        unattributedDeliveries: 0,
        unattributedDeliveryReasons: {
          missingAlertId: 0,
          missingSentAt: 0,
          noConsentedAlert: 0,
        },
      },
    });
  });

  it('projects the affirmative consent field used by the live backfill predicate', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rows = {
      alerts: [row('job_alert_subscribers/user@example.test/alerts/a1', {
        active: true,
        backfilled_from: 'newsletter_subscribers',
      })],
      jobs: [row('job_alert_subscribers/user@example.test', { status: 'confirmed' })],
      newsletters: [row('newsletter_subscribers/user@example.test', {
        consent_given: true,
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_text: 'Chiedo di ricevere gli avvisi di lavoro quotidiani.',
      })],
      deliveries: [row('job_alert_subscribers/user@example.test/campaign_deliveries/d1', {
        campaign_id: 'a1',
        sent_at: '2026-09-12T09:00:00.000Z',
        scheduled_for: '2026-09-12T08:45:00.000Z',
        send_time_source: 'personal',
        delivered_at: '2026-09-12T09:01:00.000Z',
      })],
      events: [],
    };
    const client = {
      runQuery: async (query: Record<string, unknown>) => {
        calls.push(query);
        const source = query.collectionId === 'alerts' ? rows.alerts
          : query.collectionId === 'job_alert_subscribers' ? rows.jobs
            : query.collectionId === 'newsletter_subscribers' ? rows.newsletters
              : query.collectionId === 'campaign_deliveries' ? rows.deliveries
                : rows.events;
        const fieldPaths = new Set(Array.isArray(query.fieldPaths) ? query.fieldPaths : []);
        return source.map((sourceRow) => ({
          ...sourceRow,
          data: Object.fromEntries(Object.entries(sourceRow.data).filter(([field]) => fieldPaths.has(field))),
        }));
      },
    };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-export-test-'));
    const output = await exportL4({
      now: NOW,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: client as any,
    });

    expect(calls.find((query) => query.collectionId === 'newsletter_subscribers')?.fieldPaths)
      .toContain('consent_given');
    expect(output).toMatchObject({
      eligibleConsentedUsers: 1,
      deliveredAlerts: 1,
      export: {
        consentChecked: true,
        deduplicationChecked: true,
        unattributedDeliveries: 0,
      },
    });
  });

  it('uses publisher/order/job sources for L9 and excludes anonymous funnel events', () => {
    const output = buildL9OutcomeLedger({
      now: NOW,
      profiles: {
        _meta: { generatedAt: '2026-09-12T11:00:00.000Z' },
        profiles: [{ companyKey: 'demo' }],
      },
      publisherRows: [row('publishers/p1', { company: { companyKey: 'demo', name: 'Demo AG' } })],
      orderRows: [row('orders/o1', { publisherUid: 'p1', status: 'active', amountChf: 299, currency: 'CHF' })],
      jobRows: [row('publisher_jobs/j1', { publisherUid: 'p1', status: 'paid', tier: 'sponsored', companyKey: 'demo' })],
      stripeEventRows: [row('stripe_events/e1', { type: 'invoice.paid', processedAt: '2026-09-12T11:00:00.000Z' })],
    });
    expect(output).toMatchObject({
      eligibleEmployerAccounts: 1,
      paidActivations: 1,
      activeSubscriptions: 1,
      attachedJobs: 1,
      renewals: 1,
      sponsoredProfiles: 1,
      mrrRecognizedChf: 299,
      export: {
        accountIdentity: 'publisherUid',
        anonymousFunnelExcluded: true,
        inventoryUntouched: true,
        pricesUntouched: true,
        outreachSent: false,
      },
    });
  });

  it('does not promote a paid inventory job into a paid activation without an active order', () => {
    const output = buildL9OutcomeLedger({
      now: NOW,
      profiles: {
        _meta: { generatedAt: NOW.toISOString() },
        profiles: [{ companyKey: 'demo' }],
      },
      publisherRows: [row('publishers/p1', { company: { companyKey: 'demo', name: 'Demo AG' } })],
      jobRows: [row('publisher_jobs/j1', { publisherUid: 'p1', status: 'paid', tier: 'sponsored', companyKey: 'demo' })],
    });

    expect(output).toMatchObject({
      eligibleEmployerAccounts: 1,
      paidActivations: 0,
      activeSubscriptions: 0,
      attachedJobs: 1,
    });
  });
});
