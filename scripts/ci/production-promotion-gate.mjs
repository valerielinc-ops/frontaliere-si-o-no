/**
 * Fail-closed admission checks for production promotion workflows.
 *
 * GitHub exposes the required-reviewer configuration for an environment only
 * through repository settings/API, not in the workflow expression context.
 * The workflow therefore declares the protected environment and requires an
 * environment-scoped attestation secret after that environment gate releases
 * the job. Missing or unreadable proof stops before any production side effect.
 */

export const MAIN_REF = 'refs/heads/main';
export const PRODUCTION_ENVIRONMENT = 'production-deploy';
export const APPROVAL_SECRET = 'PRODUCTION_DEPLOY_APPROVAL';
export const EXPECTED_BUILD_WORKFLOW = 'Deploy to GitHub Pages';

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
  if (!targetRepository || !sourceRepo || targetRepository !== sourceRepo) {
    errors.push('source repository is missing or does not match the target repository');
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
 * The secret is intentionally environment-scoped. Its absence is not treated
 * as "no opinion": it is a hard deny before a promotion job can proceed.
 */
export function validateApprovalAttestation({ environmentName, attestation }) {
  const errors = [];
  if (String(environmentName || '').trim() !== PRODUCTION_ENVIRONMENT) {
    errors.push(`approval job must declare environment ${PRODUCTION_ENVIRONMENT}`);
  }
  if (typeof attestation !== 'string' || attestation.trim() === '') {
    errors.push(`${APPROVAL_SECRET} is missing from the protected environment`);
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
    const verdict = validateApprovalAttestation({
      environmentName: process.env.PROMOTION_ENVIRONMENT_NAME,
      attestation: process.env[APPROVAL_SECRET],
    });
    if (!verdict.valid) return fail(verdict.errors);
    console.log('[production-promotion-gate] environment attestation present; promotion may proceed');
    return;
  }

  fail([`unknown mode ${mode || '<missing>'}`]);
}

if (import.meta.url === `file://${process.argv[1]}`) runCli(process.argv[2]);
