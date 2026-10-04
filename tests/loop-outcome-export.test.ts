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
  buildL9OutcomeLedger,
  exportL1,
  exportL3,
  exportL4,
  exportL5,
  fetchL5EventSessions,
  GoogleDataClient,
  L1_GA4_EVENT_CONTRACT,
  L5_DECISION_EVENT_CONTRACT,
  l5GatedDateRange,
} from '../scripts/ci/export-loop-outcomes.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const ROOT = 'projects/test/databases/(default)/documents';
// The fixtures use a fixed September window; the gate date is moved before it
// so these cases exercise the counting, not the transition clamp.
const L5_GATED_BEFORE_FIXTURES = { ...L5_DECISION_EVENT_CONTRACT, nextActionGateEffectiveFrom: '2026-09-01' };
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

  describe('L1 useful sessions from GA4', () => {
    const L1_POLICY = JSON.parse(fs.readFileSync(
      path.resolve('data/loop-fleet/loop-registry.json'),
      'utf8',
    )).loops.find((loop: any) => loop.loopId === 'L1');

    function l1Client({ useful, errors }: { useful: unknown; errors: unknown }) {
      const calls: Array<{ url: string; body: any }> = [];
      const client = {
        request: async (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          calls.push({ url, body });
          return body.dimensionFilter.filter.inListFilter ? errors : useful;
        },
      };
      return { calls, client };
    }

    function inputPath() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l1-export-test-'));
      const input = path.join(dir, 'baseline.json');
      fs.writeFileSync(input, JSON.stringify({ _meta: { issue: 4304 }, oldFact: true }));
      return { dir, input };
    }

    it('counts useful and error sessions from two exact settled GA4 reports', async () => {
      const { calls, client } = l1Client({
        useful: { rows: [{ metricValues: [{ value: '1000' }] }] },
        errors: { rows: [{ metricValues: [{ value: '40' }, { value: '55' }] }] },
      });
      const { dir, input } = inputPath();
      const outputPath = path.join(dir, 'l1.json');
      const output = await exportL1({ inputPath: input, outputPath, now: NOW, client: client as any });

      expect(output).toMatchObject({
        oldFact: true,
        usefulSessions: 1000,
        errorFreeUsefulSessions: 960,
        observedErrorEvents: 55,
        telemetryWindow: { startDate: '2026-09-07', endDate: '2026-09-10', lagDays: 2, source: 'GA4 settled calendar dates' },
        evidence: { errorSessions: 40, errorFreeIsLowerBound: true, sourceRefs: L1_POLICY.outcome.sourceRefs },
        _meta: { issue: 4304, source: 'GA4 Data API, read-only live export' },
      });
      expect(output.evidence.method).toContain('lower bound');
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(output);

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/524485296:runReport');
        expect(call.body.dateRanges).toEqual([{ startDate: '2026-09-07', endDate: '2026-09-10' }]);
        // Native event names only: the property has no free EVENT-scoped slot.
        expect(call.body.dimensions).toBeUndefined();
        expect(JSON.stringify(call.body)).not.toContain('customEvent:');
      }
      const useful = calls.find((call) => call.body.dimensionFilter.filter.stringFilter);
      const errors = calls.find((call) => call.body.dimensionFilter.filter.inListFilter);
      expect(useful?.body).toMatchObject({
        metrics: [{ name: 'sessions' }],
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'page_view', matchType: 'EXACT' } } },
      });
      expect(errors?.body).toMatchObject({
        metrics: [{ name: 'sessions' }, { name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...L1_GA4_EVENT_CONTRACT.errorEvents] } } },
      });
    });

    it('never lets error sessions push the error-free lower bound below zero', async () => {
      const { client } = l1Client({
        useful: { rows: [{ metricValues: [{ value: '30' }] }] },
        errors: { rows: [{ metricValues: [{ value: '45' }, { value: '90' }] }] },
      });
      const { dir, input } = inputPath();
      const output = await exportL1({ inputPath: input, outputPath: path.join(dir, 'l1.json'), now: NOW, client: client as any });
      expect(output).toMatchObject({ usefulSessions: 30, errorFreeUsefulSessions: 0, observedErrorEvents: 90 });
    });

    it('fails the export instead of publishing a thresholded or split GA4 total', async () => {
      const { dir, input } = inputPath();
      const exact = { rows: [{ metricValues: [{ value: '40' }, { value: '55' }] }] };
      const thresholded = l1Client({
        useful: { rows: [{ metricValues: [{ value: '1000' }] }], metadata: { subjectToThresholding: true } },
        errors: exact,
      });
      await expect(exportL1({ inputPath: input, outputPath: path.join(dir, 'a.json'), now: NOW, client: thresholded.client as any }))
        .rejects.toThrow('GA4 L1 report for page_view is incomplete or thresholded');
      const split = l1Client({
        useful: { rows: [{ metricValues: [{ value: '1000' }] }] },
        errors: { rows: [exact.rows[0], exact.rows[0]] },
      });
      await expect(exportL1({ inputPath: input, outputPath: path.join(dir, 'b.json'), now: NOW, client: split.client as any }))
        .rejects.toThrow('GA4 L1 report for error events returned 2 rows');
      // A row that carries fewer metrics than requested is malformed, not zero.
      const truncated = l1Client({
        useful: { rows: [{ metricValues: [{ value: '1000' }] }] },
        errors: { rows: [{ metricValues: [{ value: '40' }] }] },
      });
      await expect(exportL1({ inputPath: input, outputPath: path.join(dir, 'c.json'), now: NOW, client: truncated.client as any }))
        .rejects.toThrow('GA4 L1 report for error events returned 1 metric values, expected 2');
      expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'c.json'))).toBe(false);
    });

    it('labels the unavailable placeholder with the registry source, not PostHog', () => {
      const placeholder = buildUnavailableL1TelemetryExport({ generatedAt: NOW.toISOString() });
      expect(placeholder.export.sourceRefs).toEqual(L1_POLICY.outcome.sourceRefs);
      expect(JSON.stringify(placeholder)).not.toMatch(/posthog/i);
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
      telemetryWindow: { startDate: '2026-09-03', endDate: '2026-09-10', lagDays: 2, source: 'GA4 settled calendar dates' },
    });
    expect(output).toMatchObject({
      independent: true,
      eligibleDecisionSessions: 120,
      nextUsefulActions: 45,
      evidence: {
        sourceRefs: ['decision-surfaces', 'ga4-decision-surface'],
        sessionMetric: 'sessions',
        settledWindow: true,
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

  it('exports L5 counts from exact settled GA4 event-session counts without writing source data', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-export-test-'));
    const output = await exportL5({
      now: NOW,
      days: 8,
      eventContract: L5_GATED_BEFORE_FIXTURES,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: {
        request: async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          const body = JSON.parse(String(init.body));
          const eventName = body.dimensionFilter.filter.stringFilter.value;
          const sessions = eventName === 'decision_moment_completed' ? 120 : 45;
          return { rowCount: 1, rows: [{ metricValues: [{ value: String(sessions) }] }] };
        },
      } as any,
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/524485296:runReport');
      const body = JSON.parse(String(call.init.body));
      expect(body).toMatchObject({
        dateRanges: [{ startDate: '2026-09-03', endDate: '2026-09-10' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT' } } },
      });
      // The property has no free EVENT-scoped slot: the L5 report must be
      // answerable without any dimension, custom or otherwise.
      expect(body.dimensions).toBeUndefined();
      expect(String(call.init.body)).not.toContain('customEvent:');
    }
    expect(output).toMatchObject({
      independent: true,
      eligibleDecisionSessions: 120,
      nextUsefulActions: 45,
      telemetryWindow: { startDate: '2026-09-03', endDate: '2026-09-10', lagDays: 2, source: 'GA4 settled calendar dates' },
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
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-export-test-'));
    const calls: string[] = [];
    const report = (sessions: number) => ({ rowCount: 1, rows: [{ metricValues: [{ value: String(sessions) }] }] });
    const clientFor = (completed: number, nextAction: number) => ({
      request: async (_url: string, init: RequestInit) => {
        const eventName = JSON.parse(String(init.body)).dimensionFilter.filter.stringFilter.value;
        calls.push(eventName);
        return report(eventName === 'decision_moment_completed' ? completed : nextAction);
      },
    });
    const output = await (exportL5 as any)({
      now: NOW,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client: clientFor(1598, 19),
      eventContract: L5_GATED_BEFORE_FIXTURES,
    });

    expect([...calls].sort()).toEqual(['decision_moment_completed', 'decision_moment_next_action']);
    expect(output).toMatchObject({
      loopId: 'L5',
      independent: true,
      eligibleDecisionSessions: 1598,
      nextUsefulActions: 19,
      evidence: {
        sourceRefs: ['decision-surfaces', 'ga4-decision-surface'],
        eventContract: { nextActionGate: 'emitted only after a completion in the same GA4 session' },
      },
    });
    expect(output.evidence.eventContract).not.toHaveProperty('sessionDimension');
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'outcomes.json'), 'utf8'))).toEqual(output);

    // More next-action sessions than completion sessions contradicts the
    // client gate: no outcome file may be written as a measurement.
    const rejectedPath = path.join(outputDir, 'rejected.json');
    await expect((exportL5 as any)({ now: NOW, outputPath: rejectedPath, client: clientFor(1, 2), eventContract: L5_GATED_BEFORE_FIXTURES }))
      .rejects.toThrow('nextUsefulActions greater than eligibleDecisionSessions');
    expect(fs.existsSync(rejectedPath)).toBe(false);
    expect(() => buildL5DecisionMomentExport({
      eligibleDecisionSessions: 1,
      nextUsefulActions: 2,
      generatedAt: NOW,
    })).toThrow('nextUsefulActions greater than eligibleDecisionSessions');
  });

  it('keeps days before the client gate out of the L5 window', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-export-test-'));
    const ranges: Array<{ startDate: string; endDate: string }> = [];
    const client = {
      request: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        ranges.push(body.dateRanges[0]);
        const completed = body.dimensionFilter.filter.stringFilter.value === 'decision_moment_completed';
        return { rowCount: 1, rows: [{ metricValues: [{ value: completed ? '700' : '9' }] }] };
      },
    };
    // Settled window 2026-09-03..2026-09-10, gate live from 09-08: the five
    // ungated days are dropped and the outcome says which window it measured.
    const straddling = { ...L5_DECISION_EVENT_CONTRACT, nextActionGateEffectiveFrom: '2026-09-08' };
    const output = await (exportL5 as any)({
      now: NOW,
      outputPath: path.join(outputDir, 'outcomes.json'),
      client,
      eventContract: straddling,
    });
    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) expect(range).toEqual({ startDate: '2026-09-08', endDate: '2026-09-10' });
    expect(output).toMatchObject({
      independent: true,
      telemetryWindow: { startDate: '2026-09-08', endDate: '2026-09-10' },
      evidence: { eventContract: { nextActionGateEffectiveFrom: '2026-09-08' } },
      _meta: { telemetryWindow: { startDate: '2026-09-08', endDate: '2026-09-10' } },
    });

    // The shipped contract: a window that ends before the gate date has no
    // gated day, so nothing is read and nothing is written as a measurement.
    const before = ranges.length;
    const rejectedPath = path.join(outputDir, 'before-gate.json');
    expect(L5_DECISION_EVENT_CONTRACT.nextActionGateEffectiveFrom > '2026-09-10').toBe(true);
    await expect((exportL5 as any)({ now: NOW, outputPath: rejectedPath, client }))
      .rejects.toThrow(`L5 next-action gate is effective from ${L5_DECISION_EVENT_CONTRACT.nextActionGateEffectiveFrom}`);
    expect(ranges.length).toBe(before);
    expect(fs.existsSync(rejectedPath)).toBe(false);

    const settled = { startDate: '2026-09-03', endDate: '2026-09-10' };
    expect(l5GatedDateRange(settled, '2026-08-01')).toEqual(settled);
    expect(l5GatedDateRange(settled, '2026-09-10')).toEqual({ startDate: '2026-09-10', endDate: '2026-09-10' });
    expect(() => l5GatedDateRange(settled, '2026-09-11')).toThrow('holds no gated day yet');
    expect(() => l5GatedDateRange(settled, undefined)).toThrow('requires nextActionGateEffectiveFrom');
  });

  it('reads an absent L5 event as zero sessions and refuses approximated totals', async () => {
    const range = { eventName: 'decision_moment_next_action', startDate: '2026-09-05', endDate: '2026-09-12' };
    const clientReturning = (payload: unknown) => ({ request: async () => payload });

    await expect(fetchL5EventSessions({ client: clientReturning({}), ...range })).resolves.toBe(0);
    await expect(fetchL5EventSessions({
      client: clientReturning({ rows: [{ metricValues: [{ value: '19' }] }] }),
      ...range,
    })).resolves.toBe(19);
    await expect(fetchL5EventSessions({
      client: clientReturning({ rows: [{ metricValues: [{ value: '19' }] }], metadata: { subjectToThresholding: true } }),
      ...range,
    })).rejects.toThrow('incomplete or thresholded');
    await expect(fetchL5EventSessions({
      client: clientReturning({ rows: [{ metricValues: [{ value: '19' }] }], metadata: { samplingMetadatas: [{}] } }),
      ...range,
    })).rejects.toThrow('incomplete or thresholded');
    await expect(fetchL5EventSessions({
      client: clientReturning({ rows: [{ metricValues: [{ value: '1' }] }, { metricValues: [{ value: '2' }] }] }),
      ...range,
    })).rejects.toThrow('2 rows for a dimensionless total');
    await expect(fetchL5EventSessions({
      client: clientReturning({ rows: [{ metricValues: [{ value: '1.5' }] }] }),
      ...range,
    })).rejects.toThrow('invalid sessions for decision_moment_next_action');
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

  it('keeps paid funnel and attachment metrics inside the attested profile cohort', () => {
    const output = buildL9OutcomeLedger({
      now: NOW,
      profiles: {
        _meta: { generatedAt: NOW.toISOString() },
        profiles: [{ companyKey: 'demo' }],
      },
      publisherRows: [
        row('publishers/in-cohort', { company: { companyKey: 'demo', name: 'Demo AG' } }),
        row('publishers/out-of-cohort', { company: { companyKey: 'other', name: 'Other AG' } }),
      ],
      orderRows: [
        row('orders/in-cohort-order', { publisherUid: 'in-cohort', status: 'active', amountChf: 299, currency: 'CHF' }),
        row('orders/out-of-cohort-order', { publisherUid: 'out-of-cohort', status: 'active', amountChf: 499, currency: 'CHF' }),
      ],
      jobRows: [
        row('publisher_jobs/in-cohort-job', { publisherUid: 'in-cohort', status: 'paid', tier: 'sponsored' }),
        row('publisher_jobs/out-of-cohort-job', { publisherUid: 'out-of-cohort', status: 'paid', tier: 'sponsored' }),
      ],
    });

    expect(output).toMatchObject({
      eligibleEmployerAccounts: 1,
      checkoutStartAccounts: 1,
      paidActivations: 1,
      activeSubscriptions: 1,
      attachedJobs: 1,
      sponsoredProfiles: 1,
      mrrRecognizedChf: 299,
    });
  });
});
