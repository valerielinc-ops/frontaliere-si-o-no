import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = new URL('..', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const parse = (file: string) => YAML.parse(read(file));

function reporterSteps(job: any) {
  return (job?.steps ?? []).filter((step: any) => step?.uses === './.github/actions/report-failure');
}

describe('workflow failure reporting stays coupled to the central scanner contract', () => {
  it('reports both issue-fix failure jobs after their logs are complete', () => {
    const source = parse('.github/workflows/issue-fix.yml');
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);
    const byJob = new Map(steps.map((step: any) => [step.with['log-from-job'], step]));

    expect(job.needs).toEqual(['risk_policy', 'fix']);
    expect(String(job.if)).toContain("needs.risk_policy.result == 'failure'");
    expect(String(job.if)).toContain("needs.fix.result == 'failure'");
    expect(byJob.get('risk_policy')?.with.title).toBe('CI Failure: ${{ github.workflow }}');
    expect(byJob.get('fix')?.with.title).toBe('CI Failure: ${{ github.workflow }}');
    expect(steps.every((step: any) => step.with['closed-by'] === 'close-recovered-failure-issues')).toBe(true);
  });

  it('reports caller-level failures from deploy, reusable validators and side effects', () => {
    const source = parse('.github/workflows/deploy-publish.yml');
    const job = source.jobs['report-failure'];
    const steps = reporterSteps(job);
    const byJob = new Map(steps.map((step: any) => [step.with['log-from-job'], step]));

    expect(job.needs).toEqual(['deploy', 'validate-dist', 'validate-live', 'publish', 'runtime-watchdog']);
    expect(byJob.get('deploy')?.with['workflow-file']).toBe('.github/workflows/deploy-publish.yml');
    expect(byJob.get('validate-dist / validate-dist-postbuild')?.with['workflow-file'])
      .toBe('.github/workflows/post-deploy-validate-dist.yml');
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
