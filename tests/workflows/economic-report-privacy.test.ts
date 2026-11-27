import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildStatusRows } from '../../scripts/ci/loop-fleet-status.mjs';

type Step = { name: string; run?: string; uses?: string; if?: string; with?: { path?: string; 'sparse-checkout'?: string } };

const amount = '987654.321';
const diagnostic = 'SYNTHETIC_PRIVATE_DIAGNOSTIC';
const experiment = 'synthetic-private-experiment';
const retiredWorkflows = ['revenue-monitor', 'funnel-metrics-snapshot', 'adsense-format-ab-report'];
const publicMonitorWorkflows = ['adsense-hourly-monitor', 'revenue-signal-monitor', 'rpm-canary', 'user-value-canary', 'analytics', 'monitor-gcp-costs'];

function workflowSource(workflow: string): string {
  return readFileSync(`.github/workflows/${workflow}.yml`, 'utf8');
}

function assertPrivate(publicText: string) {
  for (const marker of [amount, diagnostic, experiment]) expect(publicText).not.toContain(marker);
  expect(publicText).not.toMatch(/--(?:body|description)-file/);
}

describe('economic history migration', () => {
  it.each(retiredWorkflows)('%s cannot collect or publish economic data publicly', (workflow) => {
    const source = workflowSource(workflow);
    const document = YAML.parse(source);

    expect(document.on).toEqual({ workflow_dispatch: {} });
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(document.jobs)).toEqual(['retired']);
    expect(document.jobs.retired.steps).toHaveLength(1);
    expect(document.jobs.retired.steps[0].run).toContain('private operator report');
    expect(source).not.toMatch(/schedule:|contents:\s*write|issues:\s*write|secrets\.|actions\/checkout/);
    expect(source).not.toMatch(/data\/(?:revenue-monitor|funnel-metrics|adsense-format-ab)-history/);
  });

  it.each(publicMonitorWorkflows)('%s keeps financial output out of public summaries and artifacts', (workflow) => {
    const source = workflowSource(workflow);
    const document = YAML.parse(source);
    const steps = Object.values(document.jobs).flatMap((job: { steps?: Step[] }) => job.steps ?? []);

    expect(source).toContain('withheld from the public run');
    expect(source).not.toMatch(/cat\s+(?:adsense-hourly|revenue-signals|rpm-canary-result|user-value-canary-result)/);
    expect(steps.some(step => step.uses?.includes('upload-artifact'))).toBe(false);
    if (workflow === 'analytics') {
      expect(source).toContain('RUNNER_TEMP/analytics-report.log');
      expect(source).toContain('RUNNER_TEMP/landing-value-report.log');
      expect(source).not.toContain('job-application-funnel.json\n            reports/landing-value-by-template.json');
    }
    if (workflow === 'monitor-gcp-costs') {
      expect(source).toContain('RUNNER_TEMP/gcp-cost-monitor.log');
    }
  });

  it('builds status-only AdSense and user-value issues from metric-bearing input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-monitor-'));
    try {
      const input = join(dir, 'private-result.json');
      writeFileSync(input, JSON.stringify({
        timestamp: 'SYNTHETIC_PRIVATE_TIMESTAMP', amount, experiment,
        current: { earnings: amount, revenue: amount, arpu: amount, activeUsers: amount },
        baseline: { earnings: amount, revenue: amount, arpu: amount },
        ratio: amount, reasons: [diagnostic], rows: [{ date: 'SYNTHETIC_PRIVATE_DATE', earnings: amount }],
      }));

      for (const script of ['build-rpm-canary-issue-body.mjs', 'build-user-value-canary-issue-body.mjs']) {
        const body = execFileSync(process.execPath, [`scripts/${script}`, input], {
          encoding: 'utf8', env: { RUN_URL: 'https://example.test/run/123' },
        });
        assertPrivate(body);
        expect(body).toContain('withheld from this public issue');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes only a status artifact for the private L8 loop', () => {
    const source = workflowSource('loop-l8-revenue-attribution');
    const document = YAML.parse(source);
    const steps = document.jobs.status.steps as Step[];
    const statusStep = steps.find(step => step.name === 'Write status-only L8 artifact');
    const uploads = steps.filter(step => step.uses?.includes('upload-artifact'));

    expect(document.on.schedule).toBeDefined();
    expect(document.on.push).toBeUndefined();
    expect(document.on.pull_request).toBeUndefined();
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(source).not.toMatch(/FIREBASE_SERVICE_ACCOUNT_JSON|GH_TOKEN|issues:\s*write|secrets\./);
    expect(source).not.toMatch(/data\/(?:revenue-monitor-history|revenue-authorized-export)/);
    expect(uploads.map(step => step.with?.path)).toEqual([
      '${{ runner.temp }}/l8-public/loop-fleet-evidence.json',
    ]);
    expect(statusStep?.run).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), 'l8-status-'));
    try {
      const summary = join(dir, 'summary');
      writeFileSync(summary, '');
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', statusStep!.run!], {
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: dir,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      const artifactPath = join(dir, 'l8-public', 'loop-fleet-evidence.json');
      const artifactText = readFileSync(artifactPath, 'utf8');
      const artifact = JSON.parse(artifactText);
      assertPrivate(artifactText);
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        loopId: 'L8',
        run: { runId: '123', runAttempt: '2', sha: 'a'.repeat(40) },
        auditStatus: 'skipped',
        validationStatus: 'skipped',
        runnerEvidenceStatus: 'skipped',
        privateEvidence: true,
        evidenceComplete: false,
        quality: 'unmeasurable',
        outcome: { status: 'unmeasurable', independent: false },
      });
      assertPrivate(readFileSync(summary, 'utf8'));

      const registry = JSON.parse(readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
      const [l8] = buildStatusRows(registry, {
        L8: { run: { databaseId: '123', headSha: 'a'.repeat(40), conclusion: 'success' } },
      }, { L8: { evidence: artifact } }).filter((row: { loopId: string }) => row.loopId === 'L8');
      assertPrivate(JSON.stringify(l8));
      expect(l8.outcome).toMatchObject({ status: 'unmeasurable', independent: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits private L8 and L9 outcomes, diagnostics and durable records from fleet status', () => {
    const registry = JSON.parse(readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
    const privateEvidence = {
      outcome: { status: 'observed', independent: true, numerator: Number(amount), reason: diagnostic },
      quality: 'observed',
      outcomePolicyCompliant: true,
      lifecycleCompliant: true,
    };
    const [l8] = buildStatusRows(registry, {}, { L8: {
      evidence: privateEvidence, canonicalHealth: privateEvidence, canonicalError: diagnostic,
    } }).filter((row: { loopId: string }) => row.loopId === 'L8');
    assertPrivate(JSON.stringify(l8));
    expect(l8.outcome).toMatchObject({ status: 'unmeasurable', independent: false });
    expect(l8.missingOutcome).toContain('private');

    const [l9] = buildStatusRows(registry, {
      L9: { run: { databaseId: '456', headSha: 'b'.repeat(40), conclusion: 'success' } },
    }, { L9: {
      evidence: privateEvidence,
      canonicalHealth: privateEvidence,
      canonicalLifecycle: { available: true, candidateIds: [diagnostic], sla: { nextDeadlineAt: diagnostic } },
      canonicalError: diagnostic,
    } }).filter((row: { loopId: string }) => row.loopId === 'L9');
    assertPrivate(JSON.stringify(l9));
    expect(l9.outcome).toMatchObject({ status: 'unmeasurable', independent: false });
    expect(l9.missingOutcome).toContain('private');
  });

  it('keeps public L9 measurement status-only', () => {
    const source = workflowSource('loop-l9-employer-activation');
    const { on, permissions, jobs } = YAML.parse(source);

    expect(on.schedule).toEqual([{ cron: '13 12 * * 1' }]);
    expect(on.push).toEqual({
      branches: ['main'],
      paths: ['.github/workflows/loop-l9-employer-activation.yml'],
    });
    expect(on.workflow_dispatch).toEqual({});
    expect(on.workflow_run).toBeUndefined();
    expect(permissions).toEqual({ contents: 'read' });
    expect(Object.keys(jobs)).toEqual(['status']);
    expect(jobs.status.steps).toHaveLength(1);
    expect(jobs.status.steps[0].run).toContain('GITHUB_STEP_SUMMARY');
    expect(jobs.status.steps[0].run).toContain('measurement is withheld');
    expect(source).not.toMatch(/actions\/checkout|secrets\.|issues:\s*write|upload-artifact|export-loop-outcomes|loop-l9-employer-activation\.mjs|data\/employer-profiles\.json/);
  });
});
