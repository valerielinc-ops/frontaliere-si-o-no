import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SECRET,
  EXPECTED_BUILD_WORKFLOW,
  EXPECTED_BUILD_WORKFLOW_PATH,
  EXPECTED_REPOSITORY,
  PRODUCTION_ENVIRONMENT,
  REQUIRED_REVIEWERS_RULE,
  validateApprovalAttestation,
  validateCanonicalBuildRun,
  validatePromotionTrigger,
} from '../scripts/ci/production-promotion-gate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflowFiles = [
  'deploy.yml',
  'deploy-cloud-functions.yml',
  'deploy-firestore-rules.yml',
  'deploy-worker.yml',
  'deploy-email-worker.yml',
  'deploy-publish.yml',
];

function readWorkflow(file: string) {
  return YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'));
}

function needs(job: any) {
  return Array.isArray(job?.needs) ? job.needs : [job?.needs];
}

function findStep(job: any, mode: string) {
  return (job?.steps || []).find((step: any) =>
    typeof step.run === 'string' && step.run.includes(`production-promotion-gate.mjs ${mode}`));
}

describe('production promotion admission', () => {
  it('admits only main push/dispatch and a successful same-repository Pages build', () => {
    const common = {
      repository: EXPECTED_REPOSITORY,
      sourceRepository: EXPECTED_REPOSITORY,
    };

    expect(validatePromotionTrigger({
      ...common,
      eventName: 'push',
      ref: 'refs/heads/main',
    }).valid).toBe(true);
    expect(validatePromotionTrigger({
      ...common,
      eventName: 'workflow_dispatch',
      ref: 'main',
    }).valid).toBe(true);
    expect(validatePromotionTrigger({
      ...common,
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/feature/f2',
    }).valid).toBe(false);
    expect(validatePromotionTrigger({
      ...common,
      eventName: 'workflow_run',
      ref: 'main',
      conclusion: 'success',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      headSha: 'abc123',
    }).valid).toBe(true);
    expect(validatePromotionTrigger({
      ...common,
      eventName: 'workflow_run',
      ref: 'main',
      conclusion: 'failure',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      headSha: 'abc123',
    }).valid).toBe(false);
    expect(validatePromotionTrigger({
      ...common,
      sourceRepository: 'external/fork',
      eventName: 'workflow_run',
      ref: 'main',
      conclusion: 'success',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      headSha: 'abc123',
    }).valid).toBe(false);
    expect(validatePromotionTrigger({
      ...common,
      repository: 'attacker/frontaliere-si-o-no',
      eventName: 'push',
      ref: 'refs/heads/main',
    }).valid).toBe(false);
  });

  it('accepts only a canonical successful build run for restore/recovery', () => {
    const run = {
      id: 26138669646,
      name: EXPECTED_BUILD_WORKFLOW,
      path: EXPECTED_BUILD_WORKFLOW_PATH,
      event: 'push',
      head_branch: 'main',
      conclusion: 'success',
      repository: { full_name: EXPECTED_REPOSITORY },
      head_repository: { full_name: EXPECTED_REPOSITORY },
      head_sha: '0123456789abcdef0123456789abcdef01234567',
    };

    expect(validateCanonicalBuildRun({ runId: '26138669646', run }).valid).toBe(true);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, head_repository: { full_name: 'external/fork' } },
    }).valid).toBe(false);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, repository: { full_name: 'attacker/frontaliere-si-o-no' } },
    }).valid).toBe(false);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, head_sha: 'not-a-commit' },
    }).valid).toBe(false);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, conclusion: 'failure' },
    }).valid).toBe(false);
  });

  it('denies a missing or incorrectly named environment attestation', () => {
    const protectedEnvironment = {
      name: PRODUCTION_ENVIRONMENT,
      protection_rules: [{
        type: REQUIRED_REVIEWERS_RULE,
        reviewers: [{ type: 'User', reviewer: { login: 'release-manager' } }],
      }],
    };

    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: 'configured-out-of-band',
      environment: protectedEnvironment,
    }).valid).toBe(true);
    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: '   ',
      environment: protectedEnvironment,
    }).valid).toBe(false);
    expect(validateApprovalAttestation({
      environmentName: 'github-pages',
      attestation: 'configured-out-of-band',
      environment: protectedEnvironment,
    }).valid).toBe(false);
  });

  it('denies a present secret when required-reviewer protection is not demonstrable', () => {
    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: 'present-but-insufficient',
      environment: {
        name: PRODUCTION_ENVIRONMENT,
        protection_rules: [],
      },
    }).valid).toBe(false);
    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: 'present-but-insufficient',
      environment: {
        name: PRODUCTION_ENVIRONMENT,
        protection_rules: [{ type: 'wait_timer', reviewers: [] }],
      },
    }).valid).toBe(false);
  });

  it('puts every production side-effect job behind the same approval contract', () => {
    for (const file of workflowFiles) {
      const workflow = readWorkflow(file);
      const trigger = workflow.jobs['validate-promotion-trigger'];
      const approval = workflow.jobs['production-approval'];
      expect(trigger, `${file}: trigger gate missing`).toBeDefined();
      expect(findStep(trigger, 'trigger'), `${file}: trigger gate not wired`).toBeDefined();
      expect(approval, `${file}: approval job missing`).toBeDefined();
      expect(approval.needs, `${file}: approval job must depend on trigger gate`)
        .toBe('validate-promotion-trigger');
      expect(approval.environment, `${file}: protected environment missing`).toEqual({
        name: PRODUCTION_ENVIRONMENT,
      });
      expect(approval.permissions, `${file}: environment API read permission missing`)
        .toMatchObject({ deployments: 'read' });
      const approvalStep = findStep(approval, 'approval');
      expect(approvalStep, `${file}: approval attestation not checked`).toBeDefined();
      expect(approvalStep.env).toMatchObject({
        GH_TOKEN: '${{ github.token }}',
        PROMOTION_REPOSITORY: '${{ github.repository }}',
        PROMOTION_ENVIRONMENT_NAME: PRODUCTION_ENVIRONMENT,
        [APPROVAL_SECRET]: `\${{ secrets.${APPROVAL_SECRET} }}`,
      });
      expect(approvalStep.run).toContain('gh api --method GET');

      const promotionJob = file === 'deploy.yml'
        ? workflow.jobs['build-locale']
        : file === 'deploy-publish.yml'
          ? workflow.jobs.deploy
          : Object.values(workflow.jobs).find((job: any) =>
            ['firebase deploy', 'wrangler-action'].some(token =>
              JSON.stringify(job).includes(token)));
      expect(promotionJob, `${file}: production side-effect job missing`).toBeDefined();
      expect(needs(promotionJob), `${file}: side-effect job bypasses approval`)
        .toContain('production-approval');
    }
  });

  it('keeps Pages validation behind the trigger gate and preserves the Pages environment', () => {
    const workflow = readWorkflow('deploy-publish.yml');
    expect(needs(workflow.jobs['validate-dist'])).toContain('validate-promotion-trigger');
    expect(workflow.jobs.deploy.environment).toMatchObject({ name: 'github-pages' });
    expect(needs(workflow.jobs.publish)).toContain('deploy');
  });

  it('routes post-deploy recovery dispatch through source-run and approval gates', () => {
    const workflow = readWorkflow('post-deploy-publish.yml');
    expect(workflow.on.workflow_dispatch?.inputs?.source_run_id).toMatchObject({
      required: true,
      type: 'string',
    });
    expect(workflow.on.workflow_call).toBeDefined();
    const trigger = workflow.jobs['validate-recovery-trigger'];
    const source = workflow.jobs['validate-recovery-source'];
    const approval = workflow.jobs['recovery-production-approval'];
    const publish = workflow.jobs.publish;

    expect(findStep(trigger, 'trigger')).toBeDefined();
    expect(needs(source)).toContain('validate-recovery-trigger');
    expect(findStep(source, 'source-run')).toBeDefined();
    expect(source.outputs.head_sha).toContain('source-build.outputs.head_sha');
    expect(needs(approval)).toContain('validate-recovery-source');
    expect(approval.environment).toEqual({ name: PRODUCTION_ENVIRONMENT });
    const approvalStep = findStep(approval, 'approval');
    expect(approvalStep).toBeDefined();
    expect(approvalStep.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      PROMOTION_REPOSITORY: '${{ github.repository }}',
      PROMOTION_ENVIRONMENT_NAME: PRODUCTION_ENVIRONMENT,
      [APPROVAL_SECRET]: `\${{ secrets.${APPROVAL_SECRET} }}`,
    });
    expect(approvalStep.run).toContain('gh api --method GET');
    expect(needs(publish)).toEqual(expect.arrayContaining([
      'validate-recovery-source',
      'recovery-production-approval',
    ]));
    expect(JSON.stringify(publish)).toContain('workflow_call');
    expect(JSON.stringify(publish)).toContain('workflow_dispatch');
  });

  it('protects artifact restore with the trigger, source-run, and approval gates', () => {
    const workflow = readWorkflow('restore-from-artifact.yml');
    const trigger = workflow.jobs['validate-promotion-trigger'];
    const source = workflow.jobs['validate-source-build'];
    const approval = workflow.jobs['production-approval'];
    const deploy = workflow.jobs.deploy;

    expect(findStep(trigger, 'trigger')).toBeDefined();
    expect(needs(source)).toContain('validate-promotion-trigger');
    expect(findStep(source, 'source-run')).toBeDefined();
    expect(findStep(source, 'source-run').run).toContain('gh api --method GET');
    expect(needs(approval)).toContain('validate-source-build');
    expect(approval.environment).toEqual({ name: PRODUCTION_ENVIRONMENT });
    expect(findStep(approval, 'approval')).toBeDefined();
    expect(needs(deploy)).toEqual(expect.arrayContaining([
      'validate-source-build',
      'production-approval',
    ]));
    expect(deploy.environment).toMatchObject({ name: 'github-pages' });
  });

  it('keeps pre-approval prep and dist validation secretless', () => {
    const build = readWorkflow('deploy.yml');
    const publish = readWorkflow('deploy-publish.yml');
    const dist = readWorkflow('post-deploy-validate-dist.yml');
    const postDeployPublish = readWorkflow('post-deploy-publish.yml');

    expect(JSON.stringify(build.jobs.prep)).not.toMatch(/secrets\.|load-rc-env|Remote Config|FIREBASE/i);
    expect(publish.jobs['validate-dist'].secrets).toBeUndefined();
    expect(JSON.stringify(dist)).not.toMatch(/secrets\.|load-rc-env|Remote Config|FIREBASE/i);
    const distSteps = Object.values(dist.jobs).flatMap((job: any) => job.steps ?? []);
    expect(JSON.stringify(distSteps)).not.toMatch(/post-to-(facebook|linkedin|reddit)|FB_|LINKEDIN|REDDIT/i);

    const publishCaller = publish.jobs.publish;
    expect(needs(publishCaller)).toContain('deploy');
    expect(needs(publish.jobs.deploy)).toContain('production-approval');
    expect(JSON.stringify(postDeployPublish.jobs.publish)).toMatch(/Load secrets from Remote Config/);
    expect(JSON.stringify(postDeployPublish.jobs.publish)).toMatch(/Post to LinkedIn Company Page/);
    expect(JSON.stringify(postDeployPublish.jobs.publish)).toMatch(/Post to Reddit Communities/);
  });
});
