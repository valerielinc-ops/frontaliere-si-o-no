import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { exportL4 } from '../scripts/ci/export-loop-outcomes.mjs';

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

const predicates = {
  evaluateJobAlertConsent: () => ({ allowed: true, reason: 'explicit-alert' }),
  isCrossChannelStop: () => false,
  isJobAlertExcluded: () => false,
};

async function runExport(data: ReturnType<typeof fixture>, directory: string) {
  const calls: Array<Record<string, any>> = [];
  const analytics = {
    request: async () => ({ rows: [{ metricValues: [{ value: '1' }] }] }),
  };
  const output = await exportL4({
    now: NOW,
    outputPath: path.join(directory, 'outcomes.json'),
    client: fakeRestClient(data, calls) as any,
    analyticsClient: analytics as any,
    predicates,
  });
  return { output, calls };
}

function workflowSteps() {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as any;
  const steps = workflow.jobs.audit.steps as Array<Record<string, any>>;
  return {
    workflow,
    scope: steps.find((step) => step.id === 'l4-scope'),
    exporter: steps.find((step) => step.name === 'Export fresh L4 outcomes'),
    audit: steps.find((step) => step.name === 'Audit alert to return'),
    evidence: steps.find((step) => step.name === 'Record canonical L4 evidence'),
    upload: steps.find((step) => step.name === 'Upload L4 observation and actions'),
  };
}

describe('L4: query Firestore', () => {
  it('mantiene il JSON e le query dell\'export con righe fuori finestra escluse', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-export-test-'));
    try {
      const data = fixture();
      const { output, calls } = await runExport(data, directory);

      expect(output).toMatchObject({
        eligibleConsentedUsers: 1,
        deliveredAlerts: 1,
        export: { deliveryRows: 1 },
      });
      expect(calls).toHaveLength(5);

      const byCollection = Object.fromEntries(calls.map((query) => [query.collectionId, query]));
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
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('L4: perimetro del workflow', () => {
  it('salta export, audit ed evidenza quando git non trova i due file decisivi', () => {
    const { scope, exporter, audit, evidence, upload } = workflowSteps();
    expect(scope?.run).toContain('git diff --name-only');
    expect(scope?.run).toContain("scripts/ci/export-loop-outcomes.mjs");
    expect(scope?.run).toContain(".github/workflows/loop-l4-alert-return.yml");
    expect(scope?.run).toContain("echo 'run_export=false'");
    expect(scope?.run).toContain("echo 'run_audit=false'");
    expect(exporter?.if).toContain("steps.l4-scope.outputs.run_export == 'true'");
    expect(audit?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(evidence?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(upload?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
  });

  it('mantiene il percorso live quando il push tocca export o workflow', () => {
    const { scope, exporter, audit, evidence, upload } = workflowSteps();
    expect(scope?.run).toContain("grep -F -x -e 'scripts/ci/export-loop-outcomes.mjs' -e '.github/workflows/loop-l4-alert-return.yml'");
    expect(scope?.run).toContain("echo 'run_export=true'");
    expect(scope?.run).toContain("echo 'run_audit=true'");
    expect(exporter?.if).toContain("steps.l4-scope.outputs.run_export == 'true'");
    expect(audit?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(evidence?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(upload?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
  });

  it('mantiene schedule e dispatch sul percorso live', () => {
    const { workflow, scope } = workflowSteps();
    expect(workflow.on.schedule).toEqual([{ cron: '11 9 * * *' }]);
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        issue: {
          description: 'Create/update one deduplicated issue when alert return evidence is not safe',
          required: false,
          type: 'boolean',
          default: true,
        },
      },
    });
    expect(scope?.run).toContain("if [ \"$EVENT_NAME\" != 'push' ]; then");
    expect(scope?.run).toContain("echo 'run_export=true'");
    expect(scope?.run).toContain("echo 'run_audit=true'");
  });

  it('mantiene pull_request senza export live e con audit dei dati del checkout', () => {
    const { workflow, scope, exporter, audit, evidence, upload } = workflowSteps();
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      'scripts/ci/export-loop-outcomes.mjs',
      '.github/workflows/loop-l4-alert-return.yml',
    ]));
    expect(scope?.run).toContain("if [ \"$EVENT_NAME\" = 'pull_request' ]; then");
    expect(scope?.run).toContain("echo 'run_export=false'");
    expect(scope?.run).toContain("echo 'run_audit=true'");
    expect(exporter?.if).toContain("steps.l4-scope.outputs.run_export == 'true'");
    expect(audit?.run).toContain('outcomes_path=data/alert-outcomes.json');
    expect(audit?.run).toContain('if [ "${{ github.event_name }}" != "pull_request" ]; then outcomes_path=');
    expect(evidence?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(upload?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
  });
});
