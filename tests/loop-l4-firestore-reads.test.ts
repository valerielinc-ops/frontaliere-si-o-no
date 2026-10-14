import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { exportL4 } from '../scripts/ci/export-loop-outcomes.mjs';
import {
  differingKeys,
  measuredFirestoreClient,
  withoutGenerationDates,
} from '../scripts/measure-loop-l4-reads.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const ROOT = 'projects/test/databases/(default)/documents';
const WORKFLOW_PATH = path.resolve('.github/workflows/loop-l4-alert-return.yml');

function row(documentPath: string, data: Record<string, unknown>) {
  return { name: `${ROOT}/${documentPath}`, data };
}

function fixture() {
  return {
    alerts: [
      row('job_alert_subscribers/user@example.com/alerts/active', { active: true }),
      // Questo alert inattivo mantiene attribuibile una consegna storica.
      row('job_alert_subscribers/user@example.com/alerts/inactive', { active: false }),
    ],
    job_alert_subscribers: [
      row('job_alert_subscribers/user@example.com', { status: 'confirmed' }),
    ],
    newsletter_subscribers: [
      row('newsletter_subscribers/user@example.com', { status: 'confirmed' }),
    ],
    campaign_deliveries: [
      row('job_alert_subscribers/user@example.com/campaign_deliveries/inactive', {
        campaign_id: 'inactive',
        sent_at: '2026-09-03T09:00:00.000Z',
        consent_checked: true,
        consent_allowed: true,
        consent_basis: 'explicit-alert',
        consent_checked_at: '2026-09-03T08:59:00.000Z',
        outcome_contract_version: 1,
        scheduled_for: '2026-09-03T08:45:00.000Z',
        send_time_source: 'personal',
        delivered_at: '2026-09-03T09:01:00.000Z',
      }),
      // La finestra REST deve escludere questo documento.
      row('job_alert_subscribers/user@example.com/campaign_deliveries/old', {
        campaign_id: 'inactive',
        sent_at: '2026-09-01T09:00:00.000Z',
        consent_checked: true,
        consent_allowed: true,
        consent_basis: 'explicit-alert',
        consent_checked_at: '2026-09-01T08:59:00.000Z',
        outcome_contract_version: 1,
        delivered_at: '2026-09-01T09:01:00.000Z',
      }),
    ],
    events: [
      // `send` non e' una evidence class L4, ma il ledger usa comunque gli
      // eventi con message_id per proteggere il join per finestra.
      row('job_alert_subscribers/user@example.com/events/send', {
        event_type: 'send',
        message_id: 'message-send',
        provider: 'maileroo',
        timestamp: '2026-09-04T09:00:00.000Z',
      }),
      row('job_alert_subscribers/user@example.com/events/old', {
        event_type: 'send',
        message_id: 'message-old',
        provider: 'maileroo',
        timestamp: '2026-09-01T09:00:00.000Z',
      }),
    ],
  };
}

function timestampFilter(query: Record<string, any>) {
  const filter = query.where?.fieldFilter;
  return filter
    ? { field: filter.field.fieldPath, value: filter.value.timestampValue }
    : null;
}

function fakeRestClient(data: ReturnType<typeof fixture>, calls: Array<Record<string, any>>) {
  return {
    async runQuery(query: Record<string, any>) {
      calls.push(query);
      const source = data[query.collectionId as keyof typeof data] || [];
      const filter = timestampFilter(query);
      const inWindow = filter
        ? source.filter((item) => {
          const start = Date.parse(filter.value);
          const value = Date.parse(String(item.data?.[filter.field] || ''));
          return Number.isFinite(value) && value >= start;
        })
        : source;
      const selected = new Set(query.fieldPaths || []);
      return inWindow.map((item) => ({
        ...item,
        data: Object.fromEntries(Object.entries(item.data).filter(([field]) => selected.has(field))),
      }));
    },
  };
}

async function baselineExporter() {
  const sha = execFileSync('git', ['rev-parse', 'origin/main']).toString().trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-baseline-test-'));
  const archive = execFileSync('git', [
    'archive',
    sha,
    'scripts/ci/export-loop-outcomes.mjs',
    'scripts/lib/ga4-service-account.mjs',
    'scripts/lib/analytics-settled-window.mjs',
  ], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  const modulePath = path.join(directory, 'scripts/ci/export-loop-outcomes.mjs');
  const module = await import(`${pathToFileURL(modulePath).href}?test=${sha}`);
  return { module, directory };
}

const predicates = {
  evaluateJobAlertConsent: () => ({ allowed: true, reason: 'explicit-alert' }),
  isCrossChannelStop: () => false,
  isJobAlertExcluded: () => false,
};

async function runExport(module: typeof import('../scripts/ci/export-loop-outcomes.mjs'), data: ReturnType<typeof fixture>, directory: string) {
  const calls: Array<Record<string, any>> = [];
  const analytics = {
    request: async () => ({ rows: [{ metricValues: [{ value: '1' }] }] }),
  };
  const output = await module.exportL4({
    now: NOW,
    outputPath: path.join(directory, 'outcomes.json'),
    client: fakeRestClient(data, calls) as any,
    analyticsClient: analytics as any,
    predicates,
  });
  return { output, calls };
}

describe('L4: query Firestore e equivalenza baseline', () => {
  it('mantiene il JSON con inattivi, tipi evento non probatori e righe fuori finestra', async () => {
    const baseline = await baselineExporter();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-head-test-'));
    try {
      const data = fixture();
      const before = await runExport(baseline.module, data, baseline.directory);
      const after = await runExport({ exportL4 } as any, data, directory);

      expect(withoutGenerationDates(after.output)).toEqual(withoutGenerationDates(before.output));
      expect(after.output).toMatchObject({
        eligibleConsentedUsers: 1,
        deliveredAlerts: 1,
        export: { deliveryRows: 1 },
      });
      expect(before.calls).toHaveLength(5);

      const byCollection = Object.fromEntries(after.calls.map((query) => [query.collectionId, query]));
      expect(byCollection.alerts.where).toBeUndefined();
      expect(byCollection.job_alert_subscribers.where).toBeUndefined();
      expect(byCollection.newsletter_subscribers.where).toBeUndefined();
      expect(timestampFilter(byCollection.campaign_deliveries)).toEqual({
        field: 'sent_at',
        value: '2026-09-02T12:00:00.000Z',
      });
      expect(timestampFilter(byCollection.events)).toEqual({
        field: 'timestamp',
        value: '2026-09-02T12:00:00.000Z',
      });
      expect(byCollection.events.fieldPaths).toEqual(expect.arrayContaining([
        'event_type', 'eventType', 'message_id', 'messageId', 'timestamp',
      ]));
      expect(after.calls).toHaveLength(5);
      expect(differingKeys(withoutGenerationDates(before.output), withoutGenerationDates(after.output))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(baseline.directory, { recursive: true, force: true });
    }
  });
});

describe('L4: misura delle query REST', () => {
  it('conta chiamate, documenti e tempo senza esporre le righe', async () => {
    const measured = measuredFirestoreClient({
      runQuery: async () => [{ name: 'one' }, { name: 'two' }],
    });
    await measured.client.runQuery({ collectionId: 'events' });
    expect(measured.stats.events).toMatchObject({ firestore_calls: 1, docs_read: 2 });
    expect(Object.keys(measured.stats)).toEqual([
      'alerts', 'job_alert_subscribers', 'newsletter_subscribers', 'campaign_deliveries', 'events',
    ]);
  });
});

describe('L4: push senza modifica all\'export', () => {
  it('salta export, audit ed evidenza quando git non trova i due file decisivi', () => {
    const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as any;
    const steps = workflow.jobs.audit.steps as Array<Record<string, any>>;
    const scope = steps.find((step) => step.id === 'l4-scope');
    const exporter = steps.find((step) => step.name === 'Export fresh L4 outcomes');
    const audit = steps.find((step) => step.name === 'Audit alert to return');
    const evidence = steps.find((step) => step.name === 'Record canonical L4 evidence');
    expect(scope?.run).toContain('git diff --name-only');
    expect(scope?.run).toContain("scripts/ci/export-loop-outcomes.mjs");
    expect(scope?.run).toContain(".github/workflows/loop-l4-alert-return.yml");
    expect(scope?.run).toContain("echo 'run_export=false'");
    expect(scope?.run).toContain("echo 'run_audit=false'");
    expect(exporter?.if).toContain("steps.l4-scope.outputs.run_export == 'true'");
    expect(audit?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(evidence?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
  });
});
