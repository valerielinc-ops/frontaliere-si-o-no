#!/usr/bin/env node

/**
 * Verify the publisher attestation carried by a repository_dispatch.
 *
 * The client_payload is an untrusted lookup claim, not a signature. The
 * receiving workflow fetches the source run and the workflow definition with
 * read-only GitHub metadata API calls, then this module compares every
 * attested binding with those responses. Any missing, malformed, stale, or
 * otherwise unknown value remains unverified.
 *
 * Contract owned by the corpus publisher's `Notify the site` step:
 *
 *   event_type: articles-published
 *   client_payload (exactly these keys):
 *     schema_version: 1
 *     source_repository: nanakokyobashi-rgb/frontaliere-articles
 *     source_workflow: Publish article data API
 *     source_workflow_path: .github/workflows/publish-api.yml
 *     source_run_id: GITHUB_RUN_ID (string)
 *     source_run_attempt: GITHUB_RUN_ATTEMPT (string)
 *     source_sha: GITHUB_SHA (40 lowercase hex characters)
 *     source_branch: GITHUB_REF_NAME (must be main)
 *     source_event: GITHUB_EVENT_NAME (must be push)
 *
 * The publisher sends this event before its own run is complete. Only
 * status=in_progress with conclusion=null is accepted. A completed run cannot
 * prove that a new dispatch came from the publisher rather than being a replay
 * of an old payload, so it is deliberately denied; the site's schedule is the
 * safe recovery path for that race.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISHER_DISPATCH_ACTION = 'articles-published';
export const PUBLISHER_ATTESTATION_SCHEMA_VERSION = 1;
export const PUBLISHER_SOURCE_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const PUBLISHER_SOURCE_WORKFLOW = 'Publish article data API';
export const PUBLISHER_SOURCE_WORKFLOW_PATH = '.github/workflows/publish-api.yml';
export const PUBLISHER_SOURCE_BRANCH = 'main';
export const PUBLISHER_SOURCE_EVENT = 'push';

export const PUBLISHER_ATTESTATION_FIELDS = Object.freeze([
  'schema_version',
  'source_repository',
  'source_workflow',
  'source_workflow_path',
  'source_run_id',
  'source_run_attempt',
  'source_sha',
  'source_branch',
  'source_event',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveIntegerString(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,20}$/u.test(value);
}

function metadataIntegerString(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return isPositiveIntegerString(value) ? value : null;
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseAttestation(eventPayload, reasons) {
  const payload = eventPayload?.client_payload;
  if (!isRecord(payload)) {
    reasons.push('publisher-payload-missing-or-invalid');
    return null;
  }
  if (!hasExactKeys(payload, [...PUBLISHER_ATTESTATION_FIELDS].sort())) {
    reasons.push('publisher-payload-shape-mismatch');
  }
  if (payload.schema_version !== PUBLISHER_ATTESTATION_SCHEMA_VERSION) {
    reasons.push('publisher-payload-schema-mismatch');
  }

  const attestation = {
    sourceRepository: payload.source_repository,
    sourceWorkflow: payload.source_workflow,
    sourceWorkflowPath: payload.source_workflow_path,
    sourceRunId: payload.source_run_id,
    sourceRunAttempt: payload.source_run_attempt,
    sourceSha: payload.source_sha,
    sourceBranch: payload.source_branch,
    sourceEvent: payload.source_event,
  };

  if (attestation.sourceRepository !== PUBLISHER_SOURCE_REPOSITORY) {
    reasons.push('publisher-source-repository-mismatch');
  }
  if (attestation.sourceWorkflow !== PUBLISHER_SOURCE_WORKFLOW) {
    reasons.push('publisher-source-workflow-mismatch');
  }
  if (attestation.sourceWorkflowPath !== PUBLISHER_SOURCE_WORKFLOW_PATH) {
    reasons.push('publisher-source-workflow-path-mismatch');
  }
  if (!isPositiveIntegerString(attestation.sourceRunId)) {
    reasons.push('publisher-source-run-id-invalid');
  }
  if (!isPositiveIntegerString(attestation.sourceRunAttempt)) {
    reasons.push('publisher-source-run-attempt-invalid');
  } else if (attestation.sourceRunAttempt !== '1') {
    reasons.push('publisher-source-run-is-rerun');
  }
  if (typeof attestation.sourceSha !== 'string' || !/^[0-9a-f]{40}$/u.test(attestation.sourceSha)) {
    reasons.push('publisher-source-sha-invalid');
  }
  if (attestation.sourceBranch !== PUBLISHER_SOURCE_BRANCH) {
    reasons.push('publisher-source-branch-mismatch');
  }
  if (attestation.sourceEvent !== PUBLISHER_SOURCE_EVENT) {
    reasons.push('publisher-source-event-mismatch');
  }

  return reasons.length === 0 ? attestation : null;
}

function compareMetadata(attestation, runMetadata, workflowMetadata, reasons) {
  if (!isRecord(runMetadata)) {
    reasons.push('publisher-source-run-api-response-invalid');
    return;
  }
  if (!isRecord(workflowMetadata)) {
    reasons.push('publisher-source-workflow-api-response-invalid');
    return;
  }

  if (runMetadata.repository?.full_name !== PUBLISHER_SOURCE_REPOSITORY) {
    reasons.push('publisher-source-run-repository-mismatch');
  }
  if (workflowMetadata.name !== PUBLISHER_SOURCE_WORKFLOW) {
    reasons.push('publisher-source-workflow-api-name-mismatch');
  }
  if (workflowMetadata.path !== PUBLISHER_SOURCE_WORKFLOW_PATH) {
    reasons.push('publisher-source-workflow-api-path-mismatch');
  }

  const runWorkflowId = metadataIntegerString(runMetadata.workflow_id);
  const workflowId = metadataIntegerString(workflowMetadata.id);
  if (!runWorkflowId || !workflowId || runWorkflowId !== workflowId) {
    reasons.push('publisher-source-run-workflow-binding-mismatch');
  }

  const runId = metadataIntegerString(runMetadata.id);
  if (!runId || runId !== attestation.sourceRunId) {
    reasons.push('publisher-source-run-id-mismatch');
  }
  const runAttempt = metadataIntegerString(runMetadata.run_attempt);
  if (!runAttempt || runAttempt !== attestation.sourceRunAttempt) {
    reasons.push('publisher-source-run-attempt-mismatch');
  }
  if (runMetadata.head_sha !== attestation.sourceSha) {
    reasons.push('publisher-source-sha-mismatch');
  }
  if (runMetadata.head_branch !== attestation.sourceBranch) {
    reasons.push('publisher-source-branch-api-mismatch');
  }
  if (runMetadata.event !== attestation.sourceEvent) {
    reasons.push('publisher-source-event-api-mismatch');
  }

  // This is the only admitted lifecycle pair. In particular, completed/success
  // is not enough: after completion the same valid payload could be replayed.
  if (runMetadata.status !== 'in_progress' || runMetadata.conclusion !== null) {
    reasons.push('publisher-source-run-status-not-allowed');
  }
}

/**
 * Pure verifier for one repository_dispatch event and its two API responses.
 * The API responses are passed in by the workflow so this function remains
 * deterministic and easy to exercise with adversarial fixtures.
 */
export function evaluatePublisherDispatchAttestation({
  eventPayload,
  runMetadata,
  workflowMetadata,
} = {}) {
  const reasons = [];
  if (!isRecord(eventPayload) || eventPayload.action !== PUBLISHER_DISPATCH_ACTION) {
    reasons.push('publisher-dispatch-action-mismatch');
  }

  const attestation = parseAttestation(eventPayload, reasons);
  if (attestation) compareMetadata(attestation, runMetadata, workflowMetadata, reasons);

  return {
    verified: reasons.length === 0,
    reason: reasons[0] || 'publisher-source-run-verified',
    reasons,
    attestation,
  };
}

function readJson(filePath) {
  const target = typeof filePath === 'string' ? filePath : '';
  if (!target) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function writeGithubOutput(decision, outputPath) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') return false;
  try {
    fs.appendFileSync(outputPath, [
      `verified=${decision.verified ? 'true' : 'false'}`,
      `verification_reason=${decision.reason}`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function main({ env = process.env, argv = process.argv, logger = console } = {}) {
  const eventPayload = readJson(env.GITHUB_EVENT_PATH);
  const runMetadata = readJson(argv[2]);
  const workflowMetadata = readJson(argv[3]);
  const decision = evaluatePublisherDispatchAttestation({ eventPayload, runMetadata, workflowMetadata });
  if (!writeGithubOutput(decision, env.GITHUB_OUTPUT)) {
    logger.error('verify-publisher-dispatch: github output unavailable; denying publisher provenance');
    return 1;
  }
  logger.log(`verify-publisher-dispatch: ${decision.verified ? 'VERIFIED' : 'DENIED'} (${decision.reason})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
