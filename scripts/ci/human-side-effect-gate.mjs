#!/usr/bin/env node

/**
 * Fail-closed gate for workflow side effects.
 *
 * A workflow run is allowed to send, publish, post, or mutate recipient state
 * only when all of these facts come from GitHub's event context:
 *
 *   - the event is an explicit workflow_dispatch, a repository_dispatch
 *     carrying the exact publisher action and a workflow-pinned principal
 *     attestation, or an explicitly opted-in schedule
 *     (APPROVAL_TRUSTED_SCHEDULE=true);
 *   - the dispatch was initiated by the same actor that triggered the run;
 *   - GitHub identifies that actor as a User (not an App/bot);
 *   - a manual dispatch explicitly supplied human_approval=true and
 *     dry_run=false, or the publisher dispatch has no input override;
 *   - this is the first attempt of a fresh run.
 *
 * The nonce is derived from the repository, workflow, actor, run id and run
 * attempt. It is consumed with an O_EXCL marker under RUNNER_TEMP, so a rerun
 * or a second invocation in the same runner cannot reuse it. No free-form
 * approval token is accepted: the boolean is only consent, while the
 * verifiable binding is GitHub's actor/run metadata plus the one-use marker.
 *
 * The helper never calls a provider, GitHub API, Firebase, R2, or git. It only
 * writes the four outputs needed by the calling workflow and one runner-local
 * nonce marker. GitHub executes a schedule only from the workflow definition
 * on the repository's default branch, and disables scheduled workflows on
 * forks, so there is no separate repository claim to bind here. The
 * schedule's three protections are the explicit per-workflow opt-in
 * (APPROVAL_TRUSTED_SCHEDULE=true), run_attempt == 1, and a one-use nonce; it
 * deliberately has no human actor or input proof to check.
 *
 * A denied decision exits successfully so the workflow can finish quietly;
 * credential hydration and mutating steps are skipped. The gate does not
 * promise a read-only/preview path, because preview execution without those
 * credentials is not available. The output remains the authoritative
 * fail-closed value for every mutating step.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISHER_DISPATCH_ACTION,
  PUBLISHER_SOURCE_BRANCH,
  PUBLISHER_SOURCE_EVENT,
  PUBLISHER_SOURCE_REPOSITORY,
  PUBLISHER_SOURCE_WORKFLOW,
  PUBLISHER_SOURCE_WORKFLOW_PATH,
} from './verify-publisher-dispatch.mjs';

export const HUMAN_APPROVAL_EVENT = 'workflow_dispatch';
export const PUBLISHER_DISPATCH_EVENT = 'repository_dispatch';
export const REQUIRED_ACTOR_TYPE = 'user';
export const NONCE_VERSION = 'human-side-effect-v1';

export { PUBLISHER_DISPATCH_ACTION } from './verify-publisher-dispatch.mjs';

const BOT_ACTOR_NAMES = new Set([
  'dependabot',
  'github-actions',
  'github-actions[bot]',
  'renovate',
  'renovate[bot]',
]);

function stringValue(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return typeof value === 'string' ? value.trim() : '';
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isSafeRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function isSafeActor(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
}

function isSafeWorkflow(value) {
  return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function isSafeSha(value) {
  return /^[0-9a-f]{40}$/u.test(value);
}

function isSafeScope(value) {
  return /^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(value);
}

function isPositiveIntegerString(value) {
  if (!/^[1-9][0-9]{0,20}$/u.test(value)) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function isBotActor(actor) {
  const normalized = actor.toLowerCase();
  return BOT_ACTOR_NAMES.has(normalized) || normalized.endsWith('[bot]');
}

/** Convert a GitHub boolean input into its only two accepted wire values. */
export function normalizeBooleanInput(value) {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === 'true' || normalized === 'false') return normalized;
  return null;
}

/**
 * Derive a stable, scope-bound nonce. The run id is not coerced to Number:
 * GitHub ids are opaque integers and must not lose precision.
 */
export function deriveApprovalNonce({
  scope,
  repository,
  workflow,
  actor,
  runId,
  runAttempt,
} = {}) {
  const fields = [scope, repository, workflow, actor, runId, runAttempt].map(stringValue);
  if (fields.some((field) => field.length === 0)) return null;
  return crypto
    .createHash('sha256')
    .update([NONCE_VERSION, ...fields].join('\u0000'))
    .digest('hex');
}

/**
 * Pure policy decision. `allow` is never true unless every required proof is
 * present and valid. This function deliberately returns a dry-run decision
 * instead of throwing for malformed event data.
 */
export function evaluateHumanApproval({
  event,
  actor,
  triggeringActor,
  actorType,
  repository,
  workflow,
  runId,
  runAttempt,
  consent,
  dryRun,
  scope,
  dispatchActor,
  dispatchAction,
  dispatchPayloadPresent,
  publisherSourceVerified,
  dispatchSourceSchemaVersion,
  dispatchSourceRepository,
  dispatchSourceWorkflow,
  dispatchSourceWorkflowPath,
  dispatchSourceRunId,
  dispatchSourceRunAttempt,
  dispatchSourceSha,
  dispatchSourceBranch,
  dispatchSourceEvent,
  approvalTrustedSchedule,
  trustedSchedule,
  expectedDispatchActor,
  expectedDispatchRepository,
  expectedDispatchScope,
  expectedDispatchWorkflow,
} = {}) {
  const eventName = stringValue(event);
  const isManualApprovalEvent = eventName === HUMAN_APPROVAL_EVENT;
  const isPublisherDispatchEvent = eventName === PUBLISHER_DISPATCH_EVENT;
  const isTrustedScheduleEvent = eventName === 'schedule'
    && normalizeBooleanInput(approvalTrustedSchedule ?? trustedSchedule) === 'true';
  const isDispatchEvent = isManualApprovalEvent || isPublisherDispatchEvent;
  const humanActor = stringValue(actor);
  const initiator = stringValue(triggeringActor);
  const senderType = stringValue(actorType).toLowerCase();
  const repo = stringValue(repository);
  const workflowName = stringValue(workflow);
  const id = stringValue(runId);
  const attempt = stringValue(runAttempt);
  const consentValue = stringValue(consent);
  const dryRunValue = stringValue(dryRun);
  const approval = normalizeBooleanInput(consentValue);
  const requestedDryRun = normalizeBooleanInput(dryRunValue);
  const approvalScope = stringValue(scope);
  const publisherActor = stringValue(dispatchActor);
  const publisherAction = stringValue(dispatchAction);
  const publisherPayloadPresent = stringValue(dispatchPayloadPresent);
  const publisherVerification = stringValue(publisherSourceVerified);
  const sourceSchemaVersion = stringValue(dispatchSourceSchemaVersion);
  const sourceRepository = stringValue(dispatchSourceRepository);
  const sourceWorkflow = stringValue(dispatchSourceWorkflow);
  const sourceWorkflowPath = stringValue(dispatchSourceWorkflowPath);
  const sourceRunId = stringValue(dispatchSourceRunId);
  const sourceRunAttempt = stringValue(dispatchSourceRunAttempt);
  const sourceSha = stringValue(dispatchSourceSha);
  const sourceBranch = stringValue(dispatchSourceBranch);
  const sourceEvent = stringValue(dispatchSourceEvent);
  const configuredPublisherActor = stringValue(expectedDispatchActor);
  const configuredRepository = stringValue(expectedDispatchRepository);
  const configuredScope = stringValue(expectedDispatchScope);
  const configuredWorkflow = stringValue(expectedDispatchWorkflow);
  const reasons = [];

  if (!isDispatchEvent && !isTrustedScheduleEvent) reasons.push('event-not-workflow-dispatch');
  if (isManualApprovalEvent && approval !== 'true') reasons.push('human-approval-not-explicit');
  if (isManualApprovalEvent && requestedDryRun !== 'false') reasons.push('dry-run-not-explicitly-disabled');
  if (isDispatchEvent) {
    if (senderType !== REQUIRED_ACTOR_TYPE) reasons.push('actor-is-not-a-github-user');
    if (!humanActor || !isSafeActor(humanActor) || isBotActor(humanActor)) reasons.push('actor-invalid-or-bot');
    if (!initiator || !isSafeActor(initiator) || isBotActor(initiator)) reasons.push('triggering-actor-invalid-or-bot');
    if (!humanActor || !initiator || humanActor.toLowerCase() !== initiator.toLowerCase()) {
      reasons.push('actor-and-triggering-actor-differ');
    }
  }
  if (!isSafeRepository(repo)) reasons.push('repository-invalid');
  if (!isSafeWorkflow(workflowName)) reasons.push('workflow-invalid');
  if (!isPositiveIntegerString(id)) reasons.push('run-id-invalid');
  if (attempt !== '1') reasons.push('run-is-a-rerun');
  if (!isSafeScope(approvalScope)) reasons.push('scope-invalid');

  if (isPublisherDispatchEvent) {
    // client_payload is only an untrusted claim. The preceding workflow step
    // must have verified it against the source repository's read-only metadata
    // API; the gate also checks the exact values passed from that payload.
    if (consentValue !== '') reasons.push('publisher-dispatch-has-consent-override');
    if (dryRunValue !== '') reasons.push('publisher-dispatch-has-dry-run-override');
    if (publisherAction !== PUBLISHER_DISPATCH_ACTION) reasons.push('publisher-dispatch-action-mismatch');
    if (!publisherActor || !isSafeActor(publisherActor) || isBotActor(publisherActor)) {
      reasons.push('publisher-dispatch-actor-invalid-or-bot');
    }
    if (!configuredPublisherActor || !isSafeActor(configuredPublisherActor)
      || publisherActor.toLowerCase() !== configuredPublisherActor.toLowerCase()) {
      reasons.push('publisher-dispatch-actor-mismatch');
    }
    if (!publisherActor || !humanActor || publisherActor.toLowerCase() !== humanActor.toLowerCase()) {
      reasons.push('publisher-dispatch-sender-mismatch');
    }
    if (publisherPayloadPresent !== 'true') reasons.push('publisher-dispatch-payload-missing-or-unknown');
    if (!isSafeRepository(configuredRepository) || repo.toLowerCase() !== configuredRepository.toLowerCase()) {
      reasons.push('publisher-dispatch-repository-mismatch');
    }
    if (!isSafeWorkflow(configuredWorkflow) || workflowName !== configuredWorkflow) {
      reasons.push('publisher-dispatch-workflow-mismatch');
    }
    if (!isSafeScope(configuredScope) || approvalScope !== configuredScope) {
      reasons.push('publisher-dispatch-scope-mismatch');
    }
    if (publisherVerification !== 'true') reasons.push('publisher-source-run-unverified');
    if (sourceSchemaVersion !== '1') reasons.push('publisher-source-schema-mismatch');
    if (sourceRepository !== PUBLISHER_SOURCE_REPOSITORY) {
      reasons.push('publisher-source-repository-mismatch');
    }
    if (sourceWorkflow !== PUBLISHER_SOURCE_WORKFLOW) {
      reasons.push('publisher-source-workflow-mismatch');
    }
    if (sourceWorkflowPath !== PUBLISHER_SOURCE_WORKFLOW_PATH) {
      reasons.push('publisher-source-workflow-path-mismatch');
    }
    if (!isPositiveIntegerString(sourceRunId)) reasons.push('publisher-source-run-id-invalid');
    if (sourceRunAttempt !== '1') reasons.push('publisher-source-run-is-rerun');
    if (!isSafeSha(sourceSha)) reasons.push('publisher-source-sha-invalid');
    if (sourceBranch !== PUBLISHER_SOURCE_BRANCH) reasons.push('publisher-source-branch-mismatch');
    if (sourceEvent !== PUBLISHER_SOURCE_EVENT) reasons.push('publisher-source-event-mismatch');
  }

  const nonce = deriveApprovalNonce({
    scope: approvalScope,
    repository: repo,
    workflow: workflowName,
    actor: humanActor,
    runId: id,
    runAttempt: attempt,
  });

  return {
    allow: reasons.length === 0 && nonce !== null,
    effectiveDryRun: reasons.length !== 0 || nonce === null,
    nonce,
    reason: reasons[0] || (isPublisherDispatchEvent
      ? 'trusted-publisher-dispatch-approved'
      : isTrustedScheduleEvent
        ? 'trusted-schedule-approved'
        : 'human-workflow-dispatch-approved'),
    reasons,
  };
}

/**
 * Consume the nonce once on the runner. Any unavailable or already-existing
 * marker denies the action; an unreadable temp directory is not a reason to
 * fall back to an unguarded send.
 */
export function consumeApprovalNonce({ nonce, runnerTemp } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(stringValue(nonce))) {
    return { consumed: false, reason: 'nonce-invalid' };
  }
  const tempRoot = stringValue(runnerTemp);
  if (!path.isAbsolute(tempRoot)) {
    return { consumed: false, reason: 'runner-temp-unavailable' };
  }

  const markerDir = path.join(tempRoot, 'frontaliere-human-approval');
  const markerPath = path.join(markerDir, `${nonce}.used`);
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(markerPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${NONCE_VERSION}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { consumed: true, reason: 'nonce-consumed-once' };
  } catch (error) {
    if (error?.code === 'EEXIST') return { consumed: false, reason: 'nonce-already-consumed' };
    return { consumed: false, reason: 'nonce-storage-unavailable' };
  }
}

function githubEnvironment(env = process.env) {
  return {
    event: env.APPROVAL_EVENT ?? env.GITHUB_EVENT_NAME,
    actor: env.APPROVAL_ACTOR ?? env.GITHUB_ACTOR,
    triggeringActor: env.APPROVAL_TRIGGERING_ACTOR ?? env.GITHUB_TRIGGERING_ACTOR,
    actorType: env.APPROVAL_ACTOR_TYPE,
    repository: env.APPROVAL_REPOSITORY ?? env.GITHUB_REPOSITORY,
    workflow: env.APPROVAL_WORKFLOW ?? env.GITHUB_WORKFLOW,
    runId: env.APPROVAL_RUN_ID ?? env.GITHUB_RUN_ID,
    runAttempt: env.APPROVAL_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT,
    consent: env.APPROVAL_CONSENT,
    dryRun: env.APPROVAL_DRY_RUN,
    scope: env.APPROVAL_SCOPE,
    dispatchActor: env.APPROVAL_DISPATCH_ACTOR,
    dispatchAction: env.APPROVAL_DISPATCH_ACTION,
    dispatchPayloadPresent: env.APPROVAL_DISPATCH_PAYLOAD_PRESENT,
    publisherSourceVerified: env.APPROVAL_PUBLISHER_SOURCE_VERIFIED,
    dispatchSourceSchemaVersion: env.APPROVAL_DISPATCH_SOURCE_SCHEMA_VERSION,
    dispatchSourceRepository: env.APPROVAL_DISPATCH_SOURCE_REPOSITORY,
    dispatchSourceWorkflow: env.APPROVAL_DISPATCH_SOURCE_WORKFLOW,
    dispatchSourceWorkflowPath: env.APPROVAL_DISPATCH_SOURCE_WORKFLOW_PATH,
    dispatchSourceRunId: env.APPROVAL_DISPATCH_SOURCE_RUN_ID,
    dispatchSourceRunAttempt: env.APPROVAL_DISPATCH_SOURCE_RUN_ATTEMPT,
    dispatchSourceSha: env.APPROVAL_DISPATCH_SOURCE_SHA,
    dispatchSourceBranch: env.APPROVAL_DISPATCH_SOURCE_BRANCH,
    dispatchSourceEvent: env.APPROVAL_DISPATCH_SOURCE_EVENT,
    approvalTrustedSchedule: env.APPROVAL_TRUSTED_SCHEDULE,
    expectedDispatchActor: env.APPROVAL_EXPECTED_DISPATCH_ACTOR,
    expectedDispatchRepository: env.APPROVAL_EXPECTED_DISPATCH_REPOSITORY,
    expectedDispatchScope: env.APPROVAL_EXPECTED_DISPATCH_SCOPE,
    expectedDispatchWorkflow: env.APPROVAL_EXPECTED_DISPATCH_WORKFLOW,
  };
}

function outputLines(decision) {
  return [
    `allow_side_effect=${decision.allow ? 'true' : 'false'}`,
    `effective_dry_run=${decision.effectiveDryRun ? 'true' : 'false'}`,
    `approval_nonce=${decision.allow ? decision.nonce : ''}`,
    `approval_reason=${decision.reason}`,
    '',
  ].join('\n');
}

export function writeGithubOutputs(decision, outputPath = process.env.GITHUB_OUTPUT) {
  const target = stringValue(outputPath);
  if (!target) return { written: false, reason: 'github-output-unavailable' };
  try {
    fs.appendFileSync(target, outputLines(decision), { encoding: 'utf8', mode: 0o600 });
    return { written: true, reason: 'outputs-written' };
  } catch {
    return { written: false, reason: 'github-output-unwritable' };
  }
}

export function main({ env = process.env, logger = console } = {}) {
  const input = githubEnvironment(env);
  let decision = evaluateHumanApproval(input);

  if (decision.allow) {
    const consumed = consumeApprovalNonce({ nonce: decision.nonce, runnerTemp: env.RUNNER_TEMP });
    if (!consumed.consumed) {
      decision = {
        ...decision,
        allow: false,
        effectiveDryRun: true,
        nonce: null,
        reason: consumed.reason,
        reasons: [...decision.reasons, consumed.reason],
      };
    }
  }

  const output = writeGithubOutputs(decision, env.GITHUB_OUTPUT);
  if (!output.written) {
    logger.error(`human-side-effect-gate: ${output.reason}; denying side effects`);
    return 1;
  }
  logger.log(`human-side-effect-gate: ${decision.allow ? 'ALLOW' : 'DENY'} (${decision.reason})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
