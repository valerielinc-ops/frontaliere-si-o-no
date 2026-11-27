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

  it('omits legacy L8 outcomes, diagnostics and durable records from fleet status', () => {
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
  });

  it('audits L9 PR inventory with a missing runner-local outcome export', () => {
    const source = workflowSource('loop-l9-employer-activation');
    const { on, jobs } = YAML.parse(source);
    const steps = jobs.audit.steps as Step[];
    const checkout = steps.find(step => step.name === 'Checkout employer inputs');
    const credentials = steps.find(step => step.name === 'Prepare read-only Firebase credentials');
    const exportStep = steps.find(step => step.name === 'Export fresh L9 outcomes');
    const audit = steps.find(step => step.name === 'Audit employer activation');

    expect(source).not.toContain('data/employer-funnel-outcomes.json');
    expect(on.push.paths).toContain('data/employer-profiles.json');
    expect(on.pull_request.paths).toContain('data/employer-profiles.json');
    expect(checkout?.with?.['sparse-checkout']?.split('\n')).toContain('/data/employer-profiles.json');
    expect(credentials?.if).toBe("github.event_name != 'pull_request'");
    expect(exportStep?.if).toBe("github.event_name != 'pull_request'");
    expect(exportStep?.run).toContain('--out "$RUNNER_TEMP/employer-funnel-outcomes.json"');
    expect(audit?.if).toBeUndefined();
    expect(audit?.run).toContain('--profiles data/employer-profiles.json --outcomes "$RUNNER_TEMP/employer-funnel-outcomes.json"');
    expect(audit?.run).toContain('.quality == "unmeasurable" and .outcomeLedgerMissing == true and .profileInventoryComplete == true');
  });
});
