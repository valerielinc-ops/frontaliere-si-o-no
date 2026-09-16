import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL1TelemetryExport,
  buildUnavailableL1TelemetryExport,
  buildUnavailableL3OutcomeExport,
  buildUnavailableL4OutcomeExport,
  buildUnavailableL5DecisionMomentExport,
  buildL3OutcomeExport,
  buildL4OutcomeLedger,
  buildL5DecisionMomentExport,
  buildL5DecisionMomentQuery,
  buildL7ExperimentLedger,
  buildL7ExperimentLedgerQuery,
  buildL9OutcomeLedger,
  exportL3,
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

  it('emits explicit unavailable L1/L3/L4 placeholders instead of failing before evidence recording', () => {
    expect(buildUnavailableL1TelemetryExport({ generatedAt: NOW.toISOString() })).toMatchObject({
      generatedAt: NOW.toISOString(),
      usefulSessions: null,
      errorFreeUsefulSessions: null,
      independent: false,
      export: { readOnly: true, unavailable: true, mutationsPerformed: false },
    });
    expect(buildUnavailableL3OutcomeExport({ generatedAt: NOW.toISOString() })).toMatchObject({
      generatedAt: NOW.toISOString(),
      eligibleJobSessions: null,
      validHandoffs: null,
      applications: null,
      independent: false,
      export: { handoffIsNotApplication: true, publishedDataUntouched: true, unavailable: true },
    });
    expect(buildUnavailableL4OutcomeExport({ generatedAt: NOW.toISOString() })).toMatchObject({
      generatedAt: NOW.toISOString(),
      eligibleConsentedUsers: null,
      returningUsers7d: null,
      independent: false,
      export: { externalDeliveryUntouched: true, unavailable: true, mutationsPerformed: false },
    });
    expect(buildUnavailableL5DecisionMomentExport({ generatedAt: NOW.toISOString(), reason: 'test outage' })).toMatchObject({
      generatedAt: NOW.toISOString(),
      independent: false,
      export: { readOnly: true, unavailable: true, publishedDataUntouched: true },
      _meta: { reason: 'test outage' },
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

  it('exports L3 from exact settled GA4 event-session counts without inventing applications', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = {
      request: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const body = JSON.parse(String(init.body));
        const eventName = body.dimensionFilter.filter.stringFilter.value;
        return {
          rows: [{ metricValues: [{ value: eventName === 'job_qualified_session' ? '120' : '90' }] }],
        };
      },
    };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l3-export-test-'));
    const outputPath = path.join(outputDir, 'outcomes.json');
    const output = await exportL3({
      now: NOW,
      days: 4,
      outputPath,
      propertyId: 'properties/524485296',
      client: client as any,
    });

    expect(output).toMatchObject({
      generatedAt: NOW.toISOString(),
      independent: true,
      eligibleJobSessions: 120,
      validHandoffs: 90,
      evidence: {
        sourceRefs: ['job-crawler-summaries', 'application-handoff'],
        settledWindow: true,
        eventFilters: {
          eligibleJobSessions: 'job_qualified_session',
          validHandoffs: 'job_apply_handoff',
        },
      },
      export: {
        handoffIsNotApplication: true,
        applicationSubmissionSource: 'not available from site telemetry',
        publishedDataUntouched: true,
        readOnly: true,
      },
    });
    expect(output).not.toHaveProperty('applications');
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(output);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/524485296:runReport');
      const body = JSON.parse(String(call.init.body));
      expect(body).toMatchObject({
        dateRanges: [{ startDate: '2026-09-07', endDate: '2026-09-10' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            stringFilter: { matchType: 'EXACT' },
          },
        },
      });
    }
  });

  it('keeps the L3 builder honest when the source has no submitted-application field', () => {
    expect(buildL3OutcomeExport({
      generatedAt: NOW.toISOString(),
      eligibleJobSessions: 0,
      validHandoffs: 0,
      telemetryWindow: { startDate: '2026-09-07', endDate: '2026-09-10' },
    })).toMatchObject({
      independent: true,
      eligibleJobSessions: 0,
      validHandoffs: 0,
      export: { handoffIsNotApplication: true, publishedDataUntouched: true },
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
    expect(query).toContain("event = 'decision_moment_completed'");
    expect(query).toContain("event = 'decision_moment_next_action'");
    expect(query).toContain('count() AS eligibleDecisionSessions');
    expect(query).toContain('countIf(nextUsefulActions > 0) AS nextUsefulActions');
    expect(query).toContain('GROUP BY properties.$session_id');
    expect(query).toContain('HAVING completedTasks > 0');

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
    expect(() => buildL7ExperimentLedgerQuery({
      start: '2026-09-05T12:00:00.000Z',
      end: NOW.toISOString(),
    })).toThrow('L7 policy is required');

    const query = buildL7ExperimentLedgerQuery({
      start: '2026-09-05T12:00:00.000Z',
      end: NOW.toISOString(),
      policy: L7_POLICY,
    });
    expect(query).toContain("event IN ('experiment_assignment', 'experiment_exposure', 'experiment_outcome', 'experiment_guardrail')");
    expect(query).toContain("properties.loop_id = 'L7'");
    expect(query).toContain("properties.assignment_method = 'stable-sha256'");
    expect(query).toContain('invalidAssignmentRecords');
    expect(query).toContain('invalidOutcomeRecords');
    expect(query).toContain('invalidExpiryRecords');
    expect(query).toContain('completeAssignmentSessions');
    expect(query).toContain('assignmentRecords > 0 AND exposureRecords > 0 AND invalidExposureRecords = 0');
    expect(query).toContain('assignmentRecords > 0 AND outcomeRecords > 0 AND invalidOutcomeRecords = 0');
    expect(query).toContain('assignmentRecords > 0 AND guardrailRecords > 0 AND invalidGuardrailRecords = 0');
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
      completeAssignmentSessions: 250,
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
      completeAssignmentSessions: 250,
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

    const disjointContracts = buildL7ExperimentLedger({
      aggregate: {
        ...completeAggregate,
        completeAssignmentSessions: 249,
        exposureContract: 250,
        outcomeContract: 250,
        guardrailContract: 250,
      },
      generatedAt: NOW,
      telemetryWindow: { start: '2026-09-05T12:00:00.000Z', end: NOW.toISOString() },
      policy: L7_POLICY,
    } as any);
    expect(disjointContracts).toMatchObject({ status: 'unverified', independent: false });

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
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
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
      independent: true,
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
