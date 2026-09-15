import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL1TelemetryExport,
  buildL4OutcomeLedger,
  buildL5DecisionMomentExport,
  buildL5DecisionMomentQuery,
  buildL7ExperimentLedger,
  buildL7ExperimentLedgerQuery,
  buildL9OutcomeLedger,
  exportL4,
  exportL5,
  exportL7,
  GoogleDataClient,
} from '../scripts/ci/export-loop-outcomes.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const ROOT = 'projects/test/databases/(default)/documents';
const L7_POLICY = JSON.parse(fs.readFileSync(
  path.resolve('data/loop-fleet/loop-registry.json'),
  'utf8',
)).loops.find((loop: any) => loop.loopId === 'L7');

function postHogClient() {
  return {
    remoteConfig: async () => ({
      parameters: {
        SERVER_POSTHOG_PERSONAL_API_KEY: { defaultValue: { value: 'test-key' } },
        SERVER_POSTHOG_PROJECT_ID: { defaultValue: { value: 'test-project' } },
      },
    }),
  };
}

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

  it('exports the L5 completed-task to next-useful-action contract', async () => {
    const query = buildL5DecisionMomentQuery({
      start: '2026-09-05T12:00:00.000Z',
      end: NOW.toISOString(),
    });
    expect(query).toContain("properties.step = 'simulation_complete'");
    expect(query).toContain("properties.step = 'compare'");
    expect(query).toContain("properties.cta_id LIKE 'calculator%'");
    expect(query).toContain('minIf(timestamp');
    expect(query).toContain('maxIf(timestamp');
    expect(query).toContain('nextUsefulAt > completedAt');
    expect(query).toContain('GROUP BY $session_id');

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-export-test-'));
    const calls: string[] = [];
    const output = await (exportL5 as any)({
      now: NOW,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: postHogClient() as any,
      posthogRunner: async (query: string, config: any) => {
        calls.push(query);
        expect(config).toMatchObject({ apiKey: 'test-key', projectId: 'test-project' });
        return { columns: ['eligibleDecisionSessions', 'nextUsefulActions'], results: [[123, 7]] };
      },
    });

    expect(calls).toHaveLength(1);
    expect(output).toMatchObject({
      loopId: 'L5',
      independent: true,
      eligibleDecisionSessions: 123,
      nextUsefulActions: 7,
      evidence: {
        sourceRefs: ['decision-surfaces', 'posthog'],
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'outcomes.json'), 'utf8'))).toEqual(output);
    expect(() => buildL5DecisionMomentExport({
      eligibleDecisionSessions: 1,
      nextUsefulActions: 2,
      generatedAt: NOW,
    })).toThrow('nextUsefulActions greater than eligibleDecisionSessions');
  });

  it('keeps the L7 ledger fail-closed when canonical experiment evidence is absent or unsafe', async () => {
    const query = buildL7ExperimentLedgerQuery({
      start: '2026-09-05T12:00:00.000Z',
      end: NOW.toISOString(),
    });
    expect(query).toContain("event IN ('experiment_assignment', 'experiment_exposure', 'experiment_outcome', 'experiment_guardrail')");
    expect(query).toContain("properties.loop_id = 'L7'");
    expect(query).toContain("properties.assignment_method = 'stable-sha256'");
    expect(query).toContain('invalidAssignmentRecords');
    expect(query).toContain('invalidOutcomeRecords');
    expect(query).toContain('invalidExpiryRecords');
    expect(query).toContain('toDateTime(if(match(properties.expires_at');
    expect(query).toContain('match(properties.expires_at');
    expect(query).toContain('addHours(timestamp, 168)');

    const twelveHourQuery = buildL7ExperimentLedgerQuery({
      start: '2026-09-05T12:00:00.000Z',
      end: NOW.toISOString(),
      policy: { ...L7_POLICY, lifecycle: { ...L7_POLICY.lifecycle, candidateTtlHours: 12 } },
    } as any);
    expect(twelveHourQuery).toContain('addHours(timestamp, 12)');

    const completeAggregate = {
      sourceEventCount: 1200,
      eligibleCohort: 250,
      assignments: 250,
      exposures: 250,
      primaryOutcomes: 40,
      guardrailBreaches: 0,
      persistentAssignments: 250,
      contaminatedAssignments: 0,
      assignmentContract: 250,
      exposureContract: 250,
      outcomeContract: 250,
      guardrailContract: 250,
      contaminationContract: 250,
      expiryContract: 250,
      firstSeenAt: '2026-09-05T12:00:00.000Z',
      lastSeenAt: NOW.toISOString(),
    };
    const complete = buildL7ExperimentLedger({
      aggregate: completeAggregate,
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(complete).toMatchObject({
      loopId: 'L7',
      status: 'observed',
      independent: true,
      sourceEventCount: 1200,
      eligibleCohort: 250,
      assignments: 250,
      exposures: 250,
      primaryOutcomes: 40,
      assignmentLedger: { persistent: true, method: 'stable-sha256', key: 'experiment-session-id' },
      contaminationPolicy: { controlled: true },
      evidence: { status: 'verified', sourceRefs: ['experiment-assignment-exposure-outcome'] },
    });

    const missing = buildL7ExperimentLedger({
      aggregate: { sourceEventCount: 0 },
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(missing).toMatchObject({
      status: 'missing',
      independent: false,
      eligibleCohort: null,
      assignments: null,
      primaryOutcomes: null,
      evidence: { status: 'missing' },
      reason: 'no canonical L7 experiment ledger events were observed; allocation remains disabled',
    });

    const breached = buildL7ExperimentLedger({
      aggregate: { ...completeAggregate, guardrailBreaches: 1 },
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(breached).toMatchObject({ status: 'unverified', independent: false, evidence: { status: 'unverified' } });

    const maskedInvalidRecord = buildL7ExperimentLedger({
      aggregate: { ...completeAggregate, exposureContract: 249 },
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(maskedInvalidRecord).toMatchObject({ status: 'unverified', independent: false });

    const expiredAssignment = buildL7ExperimentLedger({
      aggregate: { ...completeAggregate, expiryContract: 249 },
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(expiredAssignment).toMatchObject({ status: 'unverified', independent: false });

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-export-test-'));
    const output = await (exportL7 as any)({
      now: NOW,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: postHogClient() as any,
      policy: L7_POLICY,
      posthogRunner: async () => ({
        columns: Object.keys(completeAggregate),
        results: [Object.values(completeAggregate)],
      }),
    });
    expect(output).toMatchObject({ loopId: 'L7', status: 'observed', independent: true });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'outcomes.json'), 'utf8'))).toEqual(output);
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
