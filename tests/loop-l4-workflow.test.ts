import { execFileSync } from 'node:child_process';
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

function resolveLocalImport(from: string, specifier: string) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`]) {
    if (fs.existsSync(path.resolve(candidate))) return candidate;
  }
  throw new Error(`Import locale irrisolvibile: ${from} -> ${specifier}`);
}

function relativeImportClosure(entry: string) {
  const localImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    for (const match of source.matchAll(localImport)) {
      const target = resolveLocalImport(file, match[1]);
      if (!seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

function exportPerimeter(scope: Record<string, any>) {
  const value = scope.env?.L4_EXPORT_PERIMETER;
  expect(typeof value).toBe('string');
  return new Set(String(value).split('\n').map((file) => file.trim()).filter(Boolean));
}

function runScopeStep({
  changedPaths,
  fetchExit = 0,
  diffExit = 0,
  diffTreeExit = 0,
}: {
  changedPaths: string[];
  fetchExit?: number;
  diffExit?: number;
  diffTreeExit?: number;
}) {
  const { scope } = workflowSteps();
  expect(scope?.run).toBeTruthy();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-scope-test-'));
  const bin = path.join(directory, 'bin');
  const outputPath = path.join(directory, 'github-output');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  fetch) exit "${GIT_FETCH_EXIT:-0}" ;;',
    '  diff) if [ "${GIT_DIFF_EXIT:-0}" -ne 0 ]; then exit "$GIT_DIFF_EXIT"; fi; printf "%s\\n" "$GIT_CHANGED_PATHS" ;;',
    '  diff-tree) if [ "${GIT_DIFF_TREE_EXIT:-0}" -ne 0 ]; then exit "$GIT_DIFF_TREE_EXIT"; fi; printf "%s\\n" "$GIT_CHANGED_PATHS" ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  try {
    const stdout = execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', scope?.run ?? 'false'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        EVENT_NAME: 'push',
        BEFORE_SHA: 'before-sha',
        AFTER_SHA: 'after-sha',
        GITHUB_OUTPUT: outputPath,
        L4_EXPORT_PERIMETER: scope?.env?.L4_EXPORT_PERIMETER ?? '',
        GIT_CHANGED_PATHS: changedPaths.join('\n'),
        GIT_FETCH_EXIT: String(fetchExit),
        GIT_DIFF_EXIT: String(diffExit),
        GIT_DIFF_TREE_EXIT: String(diffTreeExit),
      },
    });
    const outputs = Object.fromEntries(fs.readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => line.split('=')));
    return { outputs, stdout };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  it('mantiene in un unico elenco il perimetro dell\'export e la sua chiusura locale', () => {
    const { workflow, scope } = workflowSteps();
    const perimeter = exportPerimeter(scope);
    const exporter = 'scripts/ci/export-loop-outcomes.mjs';
    const closure = relativeImportClosure(exporter);
    const expected = new Set([
      ...closure,
      '.github/workflows/loop-l4-alert-return.yml',
      'data/alert-config.json',
      'data/alert-snoozes.json',
    ]);

    expect(perimeter).toEqual(expected);
    for (const file of closure) expect(perimeter.has(file), file).toBe(true);
    for (const file of perimeter) {
      expect(workflow.on.push.paths, `push path ${file}`).toContain(file);
      expect(workflow.on.pull_request.paths, `pull_request path ${file}`).toContain(file);
      const sparse = workflow.jobs.audit.steps.find((step: Record<string, any>) => step.name === 'Checkout alert inputs')?.with?.['sparse-checkout'] ?? '';
      expect(sparse, `sparse path ${file}`).toContain(`/${file}`);
    }
    expect(scope?.run).toContain('L4_EXPORT_PERIMETER');
    expect(scope?.run).not.toContain("grep -F -x -e 'scripts/ci/export-loop-outcomes.mjs'");
  });

  it('mantiene il percorso live solo quando il push tocca il perimetro dell\'export', () => {
    const { exporter, audit, evidence, upload } = workflowSteps();
    const targetPaths = [
      'data/alert-config.json',
      'data/alert-snoozes.json',
      'scripts/lib/ga4-service-account.mjs',
    ];
    for (const changedPath of targetPaths) {
      expect(runScopeStep({ changedPaths: [changedPath] }).outputs, changedPath).toMatchObject({
        run_export: 'true',
        run_audit: 'true',
      });
    }
    expect(runScopeStep({ changedPaths: ['scripts/send-job-alerts.mjs'] }).outputs).toMatchObject({
      run_export: 'false',
      run_audit: 'false',
    });
    expect(exporter?.if).toContain("steps.l4-scope.outputs.run_export == 'true'");
    expect(audit?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(evidence?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
    expect(upload?.if).toContain("steps.l4-scope.outputs.run_audit == 'true'");
  });

  it('sceglie il percorso live prudente se fetch o diff non sono disponibili', () => {
    for (const options of [{ fetchExit: 1 }, { diffExit: 1 }]) {
      const result = runScopeStep({ changedPaths: [], ...options });
      expect(result.outputs).toMatchObject({ run_export: 'true', run_audit: 'true' });
      expect(result.stdout).toContain('::notice::L4 percorso live prudente');
    }
  });

  it('mantiene i gate downstream agganciati alle decisioni dello scope', () => {
    const { scope, exporter, audit, evidence, upload } = workflowSteps();
    expect(scope?.run).toContain('git diff --name-only');
    expect(scope?.run).toContain("echo 'run_export=false'");
    expect(scope?.run).toContain("echo 'run_audit=false'");
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
