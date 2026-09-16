import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SECRET,
  EXPECTED_BUILD_WORKFLOW,
  PRODUCTION_ENVIRONMENT,
  validateApprovalAttestation,
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
      repository: 'valerielinc-ops/frontaliere-si-o-no',
      sourceRepository: 'valerielinc-ops/frontaliere-si-o-no',
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
  });

  it('denies a missing or incorrectly named environment attestation', () => {
    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: 'configured-out-of-band',
    }).valid).toBe(true);
    expect(validateApprovalAttestation({
      environmentName: PRODUCTION_ENVIRONMENT,
      attestation: '   ',
    }).valid).toBe(false);
    expect(validateApprovalAttestation({
      environmentName: 'github-pages',
      attestation: 'configured-out-of-band',
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
      const approvalStep = findStep(approval, 'approval');
      expect(approvalStep, `${file}: approval attestation not checked`).toBeDefined();
      expect(approvalStep.env).toMatchObject({
        PROMOTION_ENVIRONMENT_NAME: PRODUCTION_ENVIRONMENT,
        [APPROVAL_SECRET]: `\${{ secrets.${APPROVAL_SECRET} }}`,
      });

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
});
