/**
 * Fail-closed admission checks for production promotion workflows.
 *
 * GitHub exposes the required-reviewer configuration for an environment only
 * through the repository API, not in the workflow expression context. The
 * approval job therefore performs an explicit read-only GET and requires a
 * non-empty required_reviewers rule as well as the environment-scoped
 * attestation secret. Missing, unreadable, or unprovable protection stops
 * before any production side effect.
 */

import { readFileSync } from 'node:fs';

export const MAIN_REF = 'refs/heads/main';
export const EXPECTED_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
export const PRODUCTION_ENVIRONMENT = 'production-deploy';
export const APPROVAL_SECRET = 'PRODUCTION_DEPLOY_APPROVAL';
export const REQUIRED_REVIEWERS_RULE = 'required_reviewers';
export const EXPECTED_BUILD_WORKFLOW = 'Deploy to GitHub Pages';
export const EXPECTED_BUILD_WORKFLOW_PATH = '.github/workflows/deploy.yml';
export const EXPECTED_PUBLISH_WORKFLOW = 'Publish to GitHub Pages (deploy + validate)';
export const EXPECTED_PUBLISH_WORKFLOW_PATH = '.github/workflows/deploy-publish.yml';

function normalizeRef(value) {
  const ref = String(value || '').trim();
  if (ref === 'main') return MAIN_REF;
  return ref;
}

/**
 * Validate that this run is an admissible production-promotion source.
 *
 * @param {object} input
 * @param {string} input.eventName
 * @param {string} input.ref branch/ref of the source event
 * @param {string} input.repository repository receiving the promotion
 * @param {string} input.sourceRepository repository that produced the source
 * @param {string} [input.conclusion] upstream conclusion for workflow_run
 * @param {string} [input.sourceWorkflow] upstream workflow name
 * @param {string} [input.headSha] upstream commit SHA
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePromotionTrigger({
  eventName,
  ref,
  repository,
  sourceRepository,
  conclusion,
  sourceWorkflow,
  headSha,
}) {
  const errors = [];
  const event = String(eventName || '').trim();
  const targetRepository = String(repository || '').trim();
  const sourceRepo = String(sourceRepository || '').trim();

  if (!event) errors.push('event name is missing');
  if (targetRepository !== EXPECTED_REPOSITORY) {
    errors.push(`target repository must be ${EXPECTED_REPOSITORY}`);
  }
  if (sourceRepo !== EXPECTED_REPOSITORY) {
    errors.push(`source repository must be ${EXPECTED_REPOSITORY}`);
  }
  if (targetRepository !== sourceRepo) {
    errors.push('source repository does not match the target repository');
  }

  if (event === 'push' || event === 'workflow_dispatch') {
    if (normalizeRef(ref) !== MAIN_REF) {
      errors.push('direct production promotion is allowed only from refs/heads/main');
    }
  } else if (event === 'workflow_run') {
    if (String(ref || '').trim() !== 'main') {
      errors.push('workflow_run promotion is allowed only from the main branch');
    }
    if (String(conclusion || '').trim() !== 'success') {
      errors.push('the source build did not complete successfully');
    }
    if (String(sourceWorkflow || '').trim() !== EXPECTED_BUILD_WORKFLOW) {
      errors.push(`source workflow must be ${EXPECTED_BUILD_WORKFLOW}`);
    }
    if (!String(headSha || '').trim()) errors.push('source build SHA is missing');
  } else if (event) {
    errors.push(`event ${event} is not an approved production-promotion trigger`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the normal post-deploy publisher caller contract.
 *
 * A reusable workflow inherits the caller's github context. The normal
 * deploy-publish caller therefore arrives here as workflow_run, not
 * workflow_call. Keep the caller identity and every artifact selector tied to
 * that canonical event so an arbitrary reusable-workflow call cannot reach
 * production side effects.
 *
 * @param {object} input
 * @param {string} input.eventName
 * @param {string} input.workflow
 * @param {string} input.workflowRef
 * @param {string} input.repository
 * @param {string} input.sourceRepository
 * @param {string} input.sourceRef
 * @param {string} input.sourceConclusion
 * @param {string} input.sourceWorkflow
 * @param {string} input.sourceHeadSha
 * @param {string|number} input.sourceRunId
 * @param {string} input.sourceEventName
 * @param {string|number} input.deployRunId
 * @param {string} input.deployEventName
 * @param {string} input.deployRef
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDeployPublishCaller({
  eventName,
  workflow,
  workflowRef,
  repository,
  sourceRepository,
  sourceRef,
  sourceConclusion,
  sourceWorkflow,
  sourceHeadSha,
  sourceRunId,
  sourceEventName,
  deployRunId,
  deployEventName,
  deployRef,
}) {
  const errors = [];
  const event = String(eventName || '').trim();
  const targetRepository = String(repository || '').trim();
  const sourceRun = String(sourceRunId ?? '').trim();
  const requestedRun = String(deployRunId ?? '').trim();
  const sourceEvent = String(sourceEventName || '').trim();
  const requestedEvent = String(deployEventName || '').trim();
  const sourceSha = String(sourceHeadSha || '').trim();
  const requestedRef = String(deployRef || '').trim();
  const expectedWorkflowRef = `${EXPECTED_REPOSITORY}/${EXPECTED_PUBLISH_WORKFLOW_PATH}@${MAIN_REF}`;

  if (event !== 'workflow_run') {
    errors.push('normal post-deploy publishing requires a workflow_run caller context');
  }
  if (String(workflow || '').trim() !== EXPECTED_PUBLISH_WORKFLOW) {
    errors.push(`caller workflow must be ${EXPECTED_PUBLISH_WORKFLOW}`);
  }
  if (String(workflowRef || '').trim() !== expectedWorkflowRef) {
    errors.push(`caller workflow ref must be ${expectedWorkflowRef}`);
  }
  if (!/^[0-9]+$/.test(sourceRun)) {
    errors.push('caller source build run id is missing or malformed');
  }
  if (requestedRun !== sourceRun) {
    errors.push('deploy_run_id does not match the caller workflow_run id');
  }
  if (!sourceEvent || requestedEvent !== sourceEvent) {
    errors.push('deploy_event_name does not match the caller workflow_run event');
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    errors.push('caller source build SHA is missing or malformed');
  }
  if (requestedRef !== sourceSha) {
    errors.push('deploy_ref does not match the caller workflow_run head SHA');
  }

  const trigger = validatePromotionTrigger({
    eventName: event,
    ref: sourceRef,
    repository: targetRepository,
    sourceRepository,
    conclusion: sourceConclusion,
    sourceWorkflow,
    headSha: sourceSha,
  });
  errors.push(...trigger.errors);

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the run selected by an explicit recovery/restore input.
 *
 * The run response is read-only evidence. The artifact is accepted only when
 * the run id, workflow path/name, source/target repositories, main branch,
 * successful conclusion, and full commit SHA all match the canonical build.
 * An absent or malformed field is a hard deny.
 *
 * @param {object} input
 * @param {string|number} input.runId
 * @param {object} input.run
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCanonicalBuildRun({ runId, run }) {
  const errors = [];
  const normalizedRunId = String(runId ?? '').trim();
  if (!/^[0-9]+$/.test(normalizedRunId)) {
    errors.push('source build run id must contain only decimal digits');
  }
  if (!run || typeof run !== 'object') {
    errors.push('source build run response is missing');
    return { valid: false, errors };
  }
  if (String(run.id ?? '').trim() !== normalizedRunId) {
    errors.push('source build run id does not match the requested run');
  }
  if (String(run.name || '').trim() !== EXPECTED_BUILD_WORKFLOW) {
    errors.push(`source build workflow must be ${EXPECTED_BUILD_WORKFLOW}`);
  }
  if (String(run.path || '').trim() !== EXPECTED_BUILD_WORKFLOW_PATH) {
    errors.push(`source build workflow path must be ${EXPECTED_BUILD_WORKFLOW_PATH}`);
  }
  if (!['push', 'workflow_dispatch'].includes(String(run.event || '').trim())) {
    errors.push('source build event is not an approved build trigger');
  }
  if (String(run.head_branch || '').trim() !== 'main') {
    errors.push('source build must be from the main branch');
  }
  if (String(run.conclusion || '').trim() !== 'success') {
    errors.push('source build did not complete successfully');
  }
  if (String(run.repository?.full_name || '').trim() !== EXPECTED_REPOSITORY) {
    errors.push(`source build target repository must be ${EXPECTED_REPOSITORY}`);
  }
  if (String(run.head_repository?.full_name || '').trim() !== EXPECTED_REPOSITORY) {
    errors.push(`source build source repository must be ${EXPECTED_REPOSITORY}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(run.head_sha || '').trim())) {
    errors.push('source build commit SHA is missing or malformed');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The secret is intentionally environment-scoped, but it is not approval proof
 * on its own. A read-only environment response must independently expose a
 * non-empty required_reviewers rule. Its absence, an API denial, or a response
 * without that rule is a hard deny before a promotion job can proceed.
 */
export function validateApprovalAttestation({ environmentName, attestation, environment }) {
  const errors = [];
  if (String(environmentName || '').trim() !== PRODUCTION_ENVIRONMENT) {
    errors.push(`approval job must declare environment ${PRODUCTION_ENVIRONMENT}`);
  }
  if (typeof attestation !== 'string' || attestation.trim() === '') {
    errors.push(`${APPROVAL_SECRET} is missing from the protected environment`);
  }
  if (String(environment?.name || '').trim() !== PRODUCTION_ENVIRONMENT) {
    errors.push('environment protection response is missing or names a different environment');
  }
  const hasRequiredReviewers = Array.isArray(environment?.protection_rules)
    && environment.protection_rules.some((rule) =>
      rule?.type === REQUIRED_REVIEWERS_RULE
      && Array.isArray(rule.reviewers)
      && rule.reviewers.length > 0);
  if (!hasRequiredReviewers) {
    errors.push('required-reviewer protection cannot be verified from the environment response');
  }
  return { valid: errors.length === 0, errors };
}

function fail(errors) {
  for (const error of errors) console.error(`::error::production promotion denied: ${error}`);
  process.exitCode = 1;
}

function runCli(mode) {
  if (mode === 'trigger') {
    const verdict = validatePromotionTrigger({
      eventName: process.env.PROMOTION_EVENT,
      ref: process.env.PROMOTION_REF,
      repository: process.env.PROMOTION_REPOSITORY,
      sourceRepository: process.env.PROMOTION_SOURCE_REPOSITORY,
      conclusion: process.env.PROMOTION_CONCLUSION,
      sourceWorkflow: process.env.PROMOTION_SOURCE_WORKFLOW,
      headSha: process.env.PROMOTION_HEAD_SHA,
    });
    if (!verdict.valid) return fail(verdict.errors);
    console.log(`[production-promotion-gate] trigger admitted: ${process.env.PROMOTION_EVENT}`);
    return;
  }

  if (mode === 'approval') {
    const rawEnvironment = readFileSync(0, 'utf8').trim();
    let environment;
    try {
      environment = rawEnvironment ? JSON.parse(rawEnvironment) : undefined;
    } catch {
      return fail(['environment protection response is not valid JSON']);
    }
    const verdict = validateApprovalAttestation({
      environmentName: process.env.PROMOTION_ENVIRONMENT_NAME,
      attestation: process.env[APPROVAL_SECRET],
      environment,
    });
    if (!verdict.valid) return fail(verdict.errors);
    console.log('[production-promotion-gate] required-reviewer protection verified and environment attestation present; promotion may proceed');
    return;
  }

  if (mode === 'caller') {
    const verdict = validateDeployPublishCaller({
      eventName: process.env.PROMOTION_EVENT,
      workflow: process.env.PROMOTION_CALLER_WORKFLOW,
      workflowRef: process.env.PROMOTION_CALLER_WORKFLOW_REF,
      repository: process.env.PROMOTION_REPOSITORY,
      sourceRepository: process.env.PROMOTION_SOURCE_REPOSITORY,
      sourceRef: process.env.PROMOTION_SOURCE_REF,
      sourceConclusion: process.env.PROMOTION_CONCLUSION,
      sourceWorkflow: process.env.PROMOTION_SOURCE_WORKFLOW,
      sourceHeadSha: process.env.PROMOTION_HEAD_SHA,
      sourceRunId: process.env.PROMOTION_SOURCE_RUN_ID,
      sourceEventName: process.env.PROMOTION_SOURCE_EVENT,
      deployRunId: process.env.INPUT_DEPLOY_RUN_ID,
      deployEventName: process.env.INPUT_DEPLOY_EVENT_NAME,
      deployRef: process.env.INPUT_DEPLOY_REF,
    });
    if (!verdict.valid) return fail(verdict.errors);
    console.log('[production-promotion-gate] canonical deploy-publish workflow_run caller admitted');
    return;
  }

  if (mode === 'source-run') {
    const rawRun = readFileSync(0, 'utf8').trim();
    let run;
    try {
      run = rawRun ? JSON.parse(rawRun) : undefined;
    } catch {
      return fail(['source build run response is not valid JSON']);
    }
    const verdict = validateCanonicalBuildRun({
      runId: process.env.PROMOTION_SOURCE_RUN_ID,
      run,
    });
    if (!verdict.valid) return fail(verdict.errors);
    console.log(`[production-promotion-gate] canonical successful build run verified: ${process.env.PROMOTION_SOURCE_RUN_ID}`);
    return;
  }

  fail([`unknown mode ${mode || '<missing>'}`]);
}

if (import.meta.url === `file://${process.argv[1]}`) runCli(process.argv[2]);
