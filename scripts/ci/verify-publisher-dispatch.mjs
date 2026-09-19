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
 * The publisher dispatches from its second-to-last step, so its run is
 * normally already finished by the time this verifier reads it — the receiving
 * job has to check this repo out first, and that takes minutes. The only
 * admitted lifecycle is therefore `completed/success`, and the anti-replay
 * property is carried by FRESHNESS (`updated_at`, an API field, not an
 * attested one) rather than by liveness. See the lifecycle check in
 * compareMetadata for the measurements that forced both choices.
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

/**
 * How long ago the publisher run may have LAST CHANGED (`updated_at`, i.e. its
 * completion) and still count as this dispatch's run.
 *
 * One hour, chosen against the two things that bracket it. The floor is the
 * latency between the publisher finishing and this verifier looking: this
 * job's queue wait plus the 46'229-file checkout that precedes the lookup —
 * 1m53s of checkout alone in run 35362400341, 2m36s for the whole job. So an
 * hour is roughly 20x the observed end-to-end latency, not the "two orders of
 * magnitude" an earlier draft of this comment claimed; a reviewer caught that
 * arithmetic, and the honest margin is what a future tuning decision needs.
 * The ceiling is the workflow's own `cron: '23 5,17 * * *'` schedule floor, 12
 * hours: the window must stay well under it, or a replayed payload could
 * substitute for a genuine publish between two scheduled runs. An hour sits
 * clear of both, with ~12x of room beneath the ceiling.
 *
 * Deliberately NOT a bound on how long a publisher run may last — see the
 * `updated_at` note in compareMetadata for why anchoring on the start instead
 * would rebuild the very trap this file is being repaired for.
 */
export const MAX_PUBLISHER_RUN_AGE_MS = 60 * 60 * 1000;

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

function compareMetadata(attestation, runMetadata, workflowMetadata, reasons, now) {
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

  // ── Lifecycle, and why it is no longer liveness-only ─────────────────────
  //
  // #8918 admitted in_progress/null and nothing else, arguing that a completed
  // run cannot prove the dispatch is new rather than a replay of an old
  // payload. Measured 2026-09-18: that pair is unreachable in practice. This
  // verifier lives in the repo, so the receiving job must check the repo out
  // before it can run — 46'229 files, 1m53s in run 35362674586's sibling
  // 35362400341, whose provenance step then read a publisher run that had
  // already completed. Result: every `articles-published` dispatch from
  // 8d953d627c8 (2026-09-16T19:25Z) onward denied with
  // publisher-source-run-status-not-allowed, `Commit if changed` never ran,
  // and packages/articles/content froze at 49b38547dad (2026-09-16T12:00Z)
  // with 2157 svizzera articles against the 2183 the corpus announced.
  //
  // Freshness carries the anti-replay property instead, and it is the stronger
  // half of the original argument: a replayed old payload names a run whose
  // last activity is long past, and the timestamp comes from the API response,
  // never from the untrusted client_payload.
  //
  // `completed/success` is now the ONLY admitted pair. An earlier draft of this
  // fix also accepted in_progress/null, which reviewers correctly rejected:
  // after the lookup retries give up, an in_progress run would authorize a
  // sync and could still FAIL afterwards, committing article data from a
  // publication that never finished. Requiring a conclusion is safe because of
  // where the publisher dispatches from — `Notify the site` is the
  // second-to-last step of publish-api.yml, after "Build data surface",
  // "Verify artifact" and the edge push, so the publication is durable before
  // the event is sent. Measured 2026-09-18 over the last 15 publisher runs:
  // 2.5-3.5 min wall clock, median 3.1. The receiving job spends 2m36s of its
  // own (1m53s of it checking out 46'229 files) before reaching this verifier,
  // and the step then still retries while the run reads `queued`/`in_progress`.
  // A publisher that is somehow slower than that loses one dispatch and is
  // picked up by the next one or by the 5:23/17:23 cron.
  if (runMetadata.status !== 'completed') {
    reasons.push('publisher-source-run-status-not-allowed');
  } else if (runMetadata.conclusion !== 'success') {
    reasons.push('publisher-source-run-not-successful');
  }

  // Anchored on `updated_at`, NOT on `run_started_at`.
  //
  // An earlier draft used run_started_at and reviewers caught the consequence:
  // that measures the publisher's START, so the window silently doubles as a
  // cap on how long a publisher run may LAST. A legitimate run longer than the
  // window would be rejected as stale and freeze the corpus again — the exact
  // failure class this file is being repaired for, reintroduced with a
  // different constant. `updated_at` measures how long ago the run last
  // changed, which for a completed run is its completion, so the check is
  // independent of publisher runtime and keeps holding as the corpus grows.
  //
  // Symmetric window: an `updated_at` an hour in the FUTURE is as suspect as
  // one an hour in the past, and costs one `Math.abs` rather than a second
  // constant nobody would tune separately.
  const updatedAt = Date.parse(
    typeof runMetadata.updated_at === 'string' ? runMetadata.updated_at : '',
  );
  if (!Number.isFinite(updatedAt)) {
    reasons.push('publisher-source-run-updated-at-invalid');
  } else if (Math.abs(now - updatedAt) > MAX_PUBLISHER_RUN_AGE_MS) {
    reasons.push('publisher-source-run-stale');
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
  // Injected so the freshness window is exercised by fixtures rather than by
  // the wall clock, which would make the test suite time-dependent.
  now = Date.now(),
} = {}) {
  const reasons = [];
  if (!isRecord(eventPayload) || eventPayload.action !== PUBLISHER_DISPATCH_ACTION) {
    reasons.push('publisher-dispatch-action-mismatch');
  }

  const attestation = parseAttestation(eventPayload, reasons);
  if (attestation) compareMetadata(attestation, runMetadata, workflowMetadata, reasons, now);

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
