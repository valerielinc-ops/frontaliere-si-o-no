import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';
import { buildFailureBody } from '../scripts/ci/report-workflow-failure.mjs';
import { failureSignature } from '../scripts/ci/lib/failure-signature.mjs';

const root = new URL('..', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const parse = (file: string) => YAML.parse(read(file));

function reporterSteps(job: any) {
  return (job?.steps ?? []).filter((step: any) => step?.uses === './.github/actions/report-failure');
}

describe('workflow failure reporting stays coupled to the central scanner contract', () => {
  it('persists the canonical job/step signature for the central scanner', () => {
    const jobs = {
      total_count: 1,
      jobs: [{
        name: 'live-data gates (post-merge)',
        conclusion: 'failure',
        steps: [{ name: 'vitest run (solo i test su dati vivi)', conclusion: 'failure' }],
      }],
    };
    const signature = failureSignature(jobs);
    const body = buildFailureBody({
      repo: 'o/r', runId: '1', workflowName: 'live-data gates', jobName: 'live-data gates',
      failedStep: { name: 'vitest run (solo i test su dati vivi)' },
      repro: { commands: [], paths: [] },
      failureSignature: signature,
    });

    expect(body).toContain(`<!-- failure-signature: ${signature} -->`);
  });

  it.each(['deploy-publish', 'issue-fix'])('%s checks out the complete reporter import graph', (workflow) => {
    const source = parse(`.github/workflows/${workflow}.yml`);
    const checkout = source.jobs['report-failure'].steps.find(
      (step: any) => step.uses?.startsWith('actions/checkout@'),
    );
    const paths = checkout.with['sparse-checkout'].split('\n').map((line: string) => line.trim()).filter(Boolean);
    const closure = collectRelativeImportClosure(fileURLToPath(root), 'scripts/ci/report-workflow-failure.mjs');
    expect(closure).toContain('scripts/cathedral-seo-gates-check.mjs');
    for (const dependency of closure) {
      expect(paths.some((entry: string) => entry.endsWith('/') ? dependency.startsWith(entry) : dependency === entry),
        `${workflow}: missing reporter dependency ${dependency}`).toBe(true);
    }
  });

  it('reports both issue-fix failure jobs after their logs are complete', () => {
    const source = parse('.github/workflows/issue-fix.yml');
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);
    const byJob = new Map<string, any>(steps.map((step: any) => [step.with['log-from-job'], step]));

    expect(job.needs).toEqual(['risk_policy', 'fix']);
    expect(String(job.if)).toContain("needs.risk_policy.result == 'failure'");
    expect(String(job.if)).toContain("needs.fix.result == 'failure'");
    expect(byJob.get('risk_policy')?.with.title).toBe('CI Failure: ${{ github.workflow }}');
    expect(byJob.get('fix')?.with.title).toBe('CI Failure: ${{ github.workflow }}');
    expect(steps.every((step: any) => step.with['closed-by'] === 'close-recovered-failure-issues')).toBe(true);
  });

  it('reports a missing social copy pack with the canonical closer and completed generation log', () => {
    const source = parse('.github/workflows/social-copy-pack.yml');
    const generate = source.jobs.generate;
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);

    expect(generate.permissions).toEqual({ contents: 'read' });
    expect(job.needs).toBe('generate');
    expect(String(job.if)).toContain("needs.generate.result == 'failure'");
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read' });
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe("always() && needs.generate.result == 'failure'");
    expect(steps[0].with.title).toBe('CI Failure: ${{ github.workflow }}');
    expect(steps[0].with['closed-by']).toBe('close-recovered-failure-issues');
    expect(steps[0].with['log-from-job']).toBe('generate');
    expect(steps[0].with['workflow-file']).toBe('.github/workflows/social-copy-pack.yml');
  });

  it('reports every needs-human sweep job after its log is complete', () => {
    const source = parse('.github/workflows/needs-human-sweep.yml');
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);
    const byJob = new Map<string, any>(steps.map((step: any) => [step.with['log-from-job'], step]));

    expect(job.needs).toEqual(['prepass', 'failure_verdicts', 'sweep']);
    expect(String(job.if)).toContain("needs.prepass.result == 'failure'");
    expect(String(job.if)).toContain("needs.failure_verdicts.result == 'failure'");
    expect(String(job.if)).toContain("needs.sweep.result == 'failure'");
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read' });
    for (const failedJob of ['prepass', 'failure_verdicts', 'sweep']) {
      const step = byJob.get(failedJob);
      expect(step, failedJob).toBeTruthy();
      expect(step.with.title).toBe('CI Failure: ${{ github.workflow }}');
      expect(step.with['closed-by']).toBe('close-recovered-failure-issues');
      expect(step.with['workflow-file']).toBe('.github/workflows/needs-human-sweep.yml');
      expect(String(step.if)).toContain(`needs.${failedJob}.result == 'failure'`);
    }
  });

  it('reports caller-level failures from deploy, reusable validators and side effects', () => {
    const source = parse('.github/workflows/deploy-publish.yml');
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);
    const byJob = new Map<string, any>(steps.map((step: any) => [step.with['log-from-job'], step]));

    expect(job.needs).toEqual([
      'deploy',
      'publish-nonit-shards',
      'resolve-nonit-publish',
      'validate-dist',
      'validate-live',
      'publish',
      'runtime-watchdog',
    ]);
    expect(byJob.get('deploy')?.with['workflow-file']).toBe('.github/workflows/deploy-publish.yml');
    expect(byJob.get('publish-nonit-shards')?.with['workflow-file']).toBe('.github/workflows/deploy-publish.yml');
    expect(byJob.get('resolve-nonit-publish')?.with['workflow-file']).toBe('.github/workflows/deploy-publish.yml');
    expect(byJob.get('validate-dist / fast-gate')?.with['workflow-file'])
      .toBe('.github/workflows/post-deploy-validate-dist.yml');
    expect(byJob.get('validate-dist / fast-gate')?.with['build-sha'])
      .toBe('${{ inputs.source_sha }}');
    expect(byJob.get('validate-live / validate-live')?.with['workflow-file'])
      .toBe('.github/workflows/post-deploy-validate-live.yml');
    expect(byJob.get('publish / publish')?.with['workflow-file'])
      .toBe('.github/workflows/post-deploy-publish.yml');
    expect(steps.every((step: any) => step.with.title === 'CI Failure: ${{ github.workflow }}')).toBe(true);
    expect(read('.github/workflows/deploy-publish.yml')).toContain("needs.validate-dist.outputs.integrity_ok == 'true'");
  });

  it('reports AdSense policy reds without changing the blocking exit code', () => {
    const source = read('.github/workflows/adsense-prereview.yml');
    const auditStart = source.indexOf('- name: Run AdSense pre-review audit');
    const auditEnd = source.indexOf('\n      - name: Upload report artifacts', auditStart);
    const audit = source.slice(auditStart, auditEnd);
    const policyStart = source.indexOf('- name: Report blocking AdSense policy finding');
    const policy = source.slice(policyStart);

    expect(audit).toContain('exit 2');
    expect(audit).toContain('exit "$code"');
    expect(source).toContain("if: failure() && steps.audit.outputs.code == '2'");
    expect(policy).toContain('--title "CI Failure: ${{ github.workflow }}"');
    expect(policy).toContain('--label automation');
    expect(policy).toContain('--label ci-failure');
    expect(source).toContain('This does not suppress Auto Ads or downgrade any finding.');
  });
});
