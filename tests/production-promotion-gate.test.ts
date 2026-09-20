import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_BUILD_EVENTS,
  EXPECTED_BUILD_WORKFLOW,
  EXPECTED_BUILD_WORKFLOW_ID,
  EXPECTED_BUILD_WORKFLOW_PATH,
  EXPECTED_PUBLISH_WORKFLOW,
  EXPECTED_PUBLISH_WORKFLOW_PATH,
  EXPECTED_REPOSITORY,
  MAIN_REF,
  validateCanonicalBuildRun,
  validateDeployPublishCaller,
  validatePromotionTrigger,
} from '../scripts/ci/production-promotion-gate.mjs';

const root = path.resolve(import.meta.dirname, '..');

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
  it('admits only main and successful same-repository build triggers', () => {
    const common = {
      repository: EXPECTED_REPOSITORY,
      sourceRepository: EXPECTED_REPOSITORY,
    };

    expect(validatePromotionTrigger({
      ...common,
      eventName: 'push',
      ref: MAIN_REF,
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
      sourceWorkflowPath: EXPECTED_BUILD_WORKFLOW_PATH,
      sourceWorkflowId: EXPECTED_BUILD_WORKFLOW_ID,
      sourceEventName: EXPECTED_BUILD_EVENTS[0],
      headSha: 'abc123',
    }).valid).toBe(true);
    expect(validatePromotionTrigger({
      ...common,
      eventName: 'workflow_run',
      ref: 'main',
      conclusion: 'failure',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      sourceWorkflowPath: EXPECTED_BUILD_WORKFLOW_PATH,
      sourceWorkflowId: EXPECTED_BUILD_WORKFLOW_ID,
      sourceEventName: EXPECTED_BUILD_EVENTS[0],
      headSha: 'abc123',
    }).valid).toBe(false);
    expect(validatePromotionTrigger({
      ...common,
      sourceRepository: 'external/fork',
      eventName: 'workflow_run',
      ref: 'main',
      conclusion: 'success',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      sourceWorkflowPath: EXPECTED_BUILD_WORKFLOW_PATH,
      sourceWorkflowId: EXPECTED_BUILD_WORKFLOW_ID,
      sourceEventName: EXPECTED_BUILD_EVENTS[0],
      headSha: 'abc123',
    }).valid).toBe(false);
  });

  it('accepts only a canonical successful build run for recovery', () => {
    const run = {
      id: 26138669646,
      name: EXPECTED_BUILD_WORKFLOW,
      path: EXPECTED_BUILD_WORKFLOW_PATH,
      workflow_id: Number(EXPECTED_BUILD_WORKFLOW_ID),
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
      run: { ...run, conclusion: 'failure' },
    }).valid).toBe(false);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, head_sha: 'not-a-commit' },
    }).valid).toBe(false);
    expect(validateCanonicalBuildRun({
      runId: '26138669646',
      run: { ...run, workflow_id: 999999999 },
    }).valid).toBe(false);
  });

  it('ties post-deploy publishing to the canonical workflow_run caller', () => {
    const buildSha = '0123456789abcdef0123456789abcdef01234567';
    expect(EXPECTED_PUBLISH_WORKFLOW_PATH).toBe('.github/workflows/post-deploy-publish.yml');
    const caller = {
      eventName: 'workflow_run',
      workflow: EXPECTED_PUBLISH_WORKFLOW,
      workflowRef: `${EXPECTED_REPOSITORY}/${EXPECTED_PUBLISH_WORKFLOW_PATH}@${MAIN_REF}`,
      repository: EXPECTED_REPOSITORY,
      sourceRepository: EXPECTED_REPOSITORY,
      sourceRef: 'main',
      sourceConclusion: 'success',
      sourceWorkflow: EXPECTED_BUILD_WORKFLOW,
      sourceWorkflowPath: EXPECTED_BUILD_WORKFLOW_PATH,
      sourceWorkflowId: EXPECTED_BUILD_WORKFLOW_ID,
      sourceHeadSha: buildSha,
      sourceRunId: '26138669646',
      sourceEventName: EXPECTED_BUILD_EVENTS[0],
      deployRunId: '26138669646',
      deployEventName: 'push',
      deployRef: buildSha,
    };

    expect(validateDeployPublishCaller(caller).valid).toBe(true);
    expect(validateDeployPublishCaller({ ...caller, eventName: 'workflow_dispatch' }).valid).toBe(false);
    expect(validateDeployPublishCaller({
      ...caller,
      sourceWorkflowPath: '.github/workflows/other.yml',
    }).valid).toBe(false);
    expect(validateDeployPublishCaller({ ...caller, sourceWorkflowId: '999999999' }).valid).toBe(false);
    expect(validateDeployPublishCaller({ ...caller, sourceEventName: 'schedule' }).valid).toBe(false);
    expect(validateDeployPublishCaller({ ...caller, deployRunId: '99999999999' }).valid).toBe(false);
    expect(validateDeployPublishCaller({ ...caller, deployRef: 'bad-ref' }).valid).toBe(false);
  });

  it('puts the build workflow behind the fail-closed trigger job', () => {
    const workflow = readWorkflow('deploy.yml');
    const trigger = workflow.jobs['validate-promotion-trigger'];

    expect(findStep(trigger, 'trigger')).toBeDefined();
    expect(needs(workflow.jobs['matrix-setup'])).toContain('validate-promotion-trigger');
    // `rearm` runs under always(), which drops the implicit needs-success
    // gate, so admission has to be re-asserted in its own condition.
    expect(needs(workflow.jobs.rearm)).toContain('validate-promotion-trigger');
    expect(workflow.jobs.rearm.if).toContain("needs.validate-promotion-trigger.result == 'success'");
  });

  it('protects artifact restore before downloading or deploying', () => {
    const workflow = readWorkflow('restore-from-artifact.yml');
    const source = workflow.jobs['validate-source-build'];
    const deploy = workflow.jobs.deploy;

    expect(findStep(workflow.jobs['validate-promotion-trigger'], 'trigger')).toBeDefined();
    expect(needs(source)).toContain('validate-promotion-trigger');
    expect(findStep(source, 'source-run')).toBeDefined();
    expect(needs(deploy)).toContain('validate-source-build');
    expect(deploy.if).toContain("needs.validate-source-build.result == 'success'");
  });

  it('protects normal and recovery post-deploy publishing paths', () => {
    const workflow = readWorkflow('post-deploy-publish.yml');
    const publish = workflow.jobs.publish;
    const dispatch = workflow.on.workflow_dispatch;
    const workflowCallInputs = workflow.on.workflow_call.inputs;
    const caller = readWorkflow('deploy-publish.yml').jobs.publish;

    expect(dispatch.inputs.source_run_id).toMatchObject({ required: true, type: 'string' });
    expect(dispatch.inputs.deploy_run_id).toBeUndefined();
    expect(workflowCallInputs).toMatchObject({
      source_workflow: { required: true, type: 'string' },
      source_workflow_path: { required: true, type: 'string' },
      source_workflow_id: { required: true, type: 'string' },
      source_event_name: { required: true, type: 'string' },
    });
    expect(findStep(workflow.jobs['validate-deploy-publish-caller'], 'caller')).toBeDefined();
    const callerStep = findStep(workflow.jobs['validate-deploy-publish-caller'], 'caller');
    expect(callerStep?.env?.PROMOTION_SOURCE_WORKFLOW).toBe('${{ inputs.source_workflow }}');
    expect(callerStep?.env?.PROMOTION_SOURCE_WORKFLOW_PATH).toBe('${{ inputs.source_workflow_path }}');
    expect(callerStep?.env?.PROMOTION_SOURCE_WORKFLOW_ID).toBe('${{ inputs.source_workflow_id }}');
    expect(callerStep?.env?.PROMOTION_SOURCE_EVENT).toBe('${{ inputs.source_event_name }}');
    expect(caller.with).toMatchObject({
      source_workflow: '${{ github.event.workflow_run.name }}',
      source_workflow_path: '${{ github.event.workflow_run.path }}',
      source_workflow_id: '${{ github.event.workflow_run.workflow_id }}',
      source_event_name: '${{ github.event.workflow_run.event }}',
    });
    expect(findStep(workflow.jobs['validate-recovery-trigger'], 'trigger')).toBeDefined();
    expect(findStep(workflow.jobs['validate-recovery-source'], 'source-run')).toBeDefined();
    expect(needs(publish)).toEqual(expect.arrayContaining([
      'validate-deploy-publish-caller',
      'validate-recovery-source',
    ]));
    expect(publish.if).toContain("github.event_name == 'workflow_run'");
    expect(publish.if).toContain("needs.validate-deploy-publish-caller.result == 'success'");
    expect(publish.if).toContain("github.event_name == 'workflow_dispatch'");
    // The recovery dispatch keeps the main-branch workflow_ref restriction
    // that used to sit on the removed approval job.
    expect(publish.if).toContain('post-deploy-publish.yml@refs/heads/main');
    expect(publish.if).toContain("needs.validate-recovery-source.result == 'success'");
    expect(JSON.stringify(publish.steps)).not.toContain('inputs.deploy_');
    expect(JSON.stringify(publish.steps)).toContain('env.EFFECTIVE_DEPLOY_RUN_ID');
    expect(JSON.stringify(publish.steps)).toContain('env.EFFECTIVE_DEPLOY_REF');
  });
});
