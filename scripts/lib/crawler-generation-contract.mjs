import { canonicalJson, digestDocument } from './canonical-json-digest.mjs';
import { validateCrawlerGenerationReceipt } from './crawler-generation-receipt.mjs';
import { isCrawlerGenerationToken } from './crawler-generation-token.mjs';
import { GITHUB_WORKFLOW_DISPATCH_API_VERSION } from '../../functions/src/githubApiHeaders.js';

export { canonicalJson, digestDocument, isCrawlerGenerationToken };

export const GROUP_IDS = Object.freeze(Array.from({ length: 23 }, (_, index) => String(index + 1).padStart(2, '0')));
export const GROUP_MANIFEST_REASON_CODES = Object.freeze([
  'wait_failed',
  'remote_fetch_failed',
  'invalid_expected_roster',
  'receipt_missing',
  'receipt_invalid',
  'receipt_primary_slice_missing',
  'receipt_failed',
  'receipt_commit_not_ancestor',
  'receipt_blob_mismatch',
  'slice_hash_mismatch',
  'duplicate_slice_ownership',
  'manifest_internal_error',
]);
export const BARRIER_STATUSES = Object.freeze([
  'waiting',
  'ready',
  'blocked_dispatch_missing',
  'blocked_group_failed',
  'blocked_group_cancelled',
  'blocked_group_timed_out',
  'blocked_manifest_missing',
  'blocked_manifest_invalid',
  'blocked_timeout',
]);
export const CRAWLER_GENERATION_DISPATCH_STATUSES = Object.freeze([
  'direct',
  'reconciled_transport_error',
  'reconciled_protocol_mismatch',
  'rejected',
  'missing',
  'duplicate',
  'invalid_200_response',
  'binding_mismatch',
  'duplicate_run_id',
  'api_protocol_mismatch',
]);
export const CRAWLER_GENERATION_NONTERMINAL_RUN_STATUSES = Object.freeze([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

export const SITE_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
export const SITE_MAIN_REF = 'refs/heads/main';
export const CALLER_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const CRAWLER_GENERATION_GITHUB_API_VERSION = GITHUB_WORKFLOW_DISPATCH_API_VERSION;
export const CRAWLER_GENERATION_DISPATCH_REF_PREFIX = 'crawler-generation-shadow-';
// 44 KiB × 23 groups = 1,036,288 bytes: the complete shadow cycle stays
// below 1 MiB by construction, before artifact/container overhead.
export const MAX_GROUP_MANIFEST_BYTES = 44 * 1024;
export const MAX_CYCLE_MANIFEST_BYTES = 1024 * 1024;
// workflow_dispatch has a 65,535-character aggregate input ceiling. Keep the
// canonical registry plus its duplicate binding inputs comfortably below it.
export const MAX_SENTINEL_BYTES = 32 * 1024;

const GROUP_REASON_SET = new Set(GROUP_MANIFEST_REASON_CODES);
const GROUP_ID_SET = new Set(GROUP_IDS);
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const OBJECT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SLICE_RE = /^data\/jobs\/by-crawler\/[a-z0-9][a-z0-9._-]*\.json$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CRAWLER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RECEIPT_OUTCOME_SET = new Set(['noop', 'pushed', 'push_contention', 'failed']);
const ACCEPTED_RECEIPT_OUTCOMES = new Set(['noop', 'pushed']);
const MAX_RECEIPT_FILES = 128;
const DISPATCH_STATUS_SET = new Set(CRAWLER_GENERATION_DISPATCH_STATUSES);
const ACCEPTED_DISPATCH_STATUS_SET = new Set(['direct', 'reconciled_transport_error']);
const NULL_DISPATCH_RUN_ID_STATUS_SET = new Set([
  'rejected', 'missing', 'duplicate', 'invalid_200_response', 'duplicate_run_id', 'api_protocol_mismatch',
]);

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareCodePoint);
  const expected = [...keys].sort(compareCodePoint);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validRunId(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

export function crawlerGenerationWorkflowName(group) {
  return `Crawler Group ${group} (sparse cross-repo execution)`;
}

export function crawlerGenerationRunName(group, generationToken) {
  return `crawler-generation-${generationToken}-group-${group}`;
}

export function parseCrawlerGenerationRunName(value) {
  const match = /^crawler-generation-(.+)-group-(\d{2})$/.exec(value ?? '');
  if (!match || !isCrawlerGenerationToken(match[1]) || !GROUP_ID_SET.has(match[2])) return null;
  return Object.freeze({ generationToken: match[1], group: match[2] });
}

export function crawlerGenerationWorkflowIdentity(group, generationToken, runId, corpusCodeCommit = null) {
  const boundRunId = validRunId(runId) ? runId : null;
  return {
    workflowFile: `crawler-group-${group}.yml`,
    workflowName: crawlerGenerationWorkflowName(group),
    runId: boundRunId,
    runName: crawlerGenerationRunName(group, generationToken),
    generationToken: isCrawlerGenerationToken(generationToken) ? generationToken : null,
    artifactName: boundRunId === null ? null : `crawler-group-${group}-terminal-${boundRunId}`,
    corpusCodeCommit: COMMIT_RE.test(corpusCodeCommit ?? '') ? corpusCodeCommit : null,
  };
}

export function crawlerGenerationLegacyWorkflowIdentity(group, runId) {
  return {
    ...crawlerGenerationWorkflowIdentity(group, '1-1', runId),
    runName: `crawler-generation--group-${group}`,
  };
}

export function crawlerGenerationSentinelWorkflowIdentity(generationToken, runId, corpusCodeCommit = null) {
  return {
    workflowFile: 'crawler-generation-observer-shadow.yml',
    workflowName: 'Crawler Generation Observer (shadow)',
    runId: validRunId(String(runId ?? '')) ? String(runId) : null,
    runName: `crawler-generation-sentinel-${generationToken}`,
    generationToken: isCrawlerGenerationToken(generationToken) ? generationToken : null,
    artifactName: validRunId(String(runId ?? ''))
      ? `crawler-generation-sentinel-${generationToken}`
      : null,
    corpusCodeCommit: COMMIT_RE.test(corpusCodeCommit ?? '') ? corpusCodeCommit : null,
  };
}

function exactWorkflowRunPath(value, workflowFile, ref) {
  const base = `.github/workflows/${workflowFile}`;
  return value === base || value === `${base}@${ref}`;
}

export function crawlerGenerationDispatchRef(generationToken) {
  if (!isCrawlerGenerationToken(generationToken)) throw new TypeError('Invalid crawler generation token');
  return `${CRAWLER_GENERATION_DISPATCH_REF_PREFIX}${generationToken}`;
}

function dispatchRefForBinding(binding) {
  if (!binding?.corpusCodeCommit) return 'main';
  if (binding && Object.prototype.hasOwnProperty.call(binding, 'generationToken')) {
    return isCrawlerGenerationToken(binding.generationToken)
      ? crawlerGenerationDispatchRef(binding.generationToken)
      : null;
  }
  // Legacy shim: a sentinel group entry persisted before `generationToken`
  // joined the binding schema carries the token only inside `runName`. A
  // generation cycle dispatched pre-deploy and observed post-deploy must
  // keep resolving instead of failing every group closed on the schema edge.
  const runName = binding?.runName ?? '';
  const groupMatch = /^crawler-generation-(.+)-group-(?:0[1-9]|1[0-9]|2[0-3])$/.exec(runName);
  const sentinelMatch = /^crawler-generation-sentinel-(.+)$/.exec(runName);
  const generationToken = groupMatch?.[1] ?? sentinelMatch?.[1] ?? null;
  return isCrawlerGenerationToken(generationToken) ? crawlerGenerationDispatchRef(generationToken) : null;
}

/**
 * Pure exact-ID Actions run binding shared by the dispatcher and observer.
 * It never infers identity from timestamps or a workflow's newest run.
 */
export function validateCrawlerGenerationWorkflowRun(
  run,
  binding,
  repository = CALLER_REPOSITORY,
  { requireLifecycle = true } = {},
) {
  const errors = [];
  const runId = String(run?.id ?? '');
  const validStatus = run?.status === 'completed'
    || CRAWLER_GENERATION_NONTERMINAL_RUN_STATUSES.includes(run?.status);
  const validConclusion = run?.status === 'completed'
    ? ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure']
      .includes(run?.conclusion)
    : run?.conclusion === null;
  if (runId !== binding?.runId) errors.push('run_id_mismatch');
  if (run?.repository?.full_name !== repository) errors.push('repository_mismatch');
  const expectedRef = dispatchRefForBinding(binding);
  // Actions has exposed `name` as either the static workflow name or the
  // dynamic run-name across lifecycle snapshots. The preflight artifact hash
  // binds the static workflow at the exact head SHA; both API forms stay exact.
  if (run?.name !== binding?.workflowName && run?.name !== binding?.runName) {
    errors.push('workflow_name_mismatch');
  }
  if (run?.display_title !== binding?.runName) errors.push('run_name_mismatch');
  if (expectedRef === null || !exactWorkflowRunPath(run?.path, binding?.workflowFile, expectedRef)) {
    errors.push('workflow_path_mismatch');
  }
  if (run?.event !== 'workflow_dispatch') errors.push('event_mismatch');
  if (run?.head_branch !== expectedRef) errors.push('head_branch_mismatch');
  if (binding?.corpusCodeCommit !== null && binding?.corpusCodeCommit !== undefined) {
    if (!COMMIT_RE.test(binding.corpusCodeCommit)) errors.push('expected_corpus_commit_invalid');
    else if (run?.head_sha !== binding.corpusCodeCommit) errors.push('head_sha_mismatch');
  }
  if (requireLifecycle && (!Number.isInteger(run?.run_attempt) || run.run_attempt < 1)) errors.push('run_attempt_invalid');
  if (requireLifecycle && !validStatus) errors.push('run_status_invalid');
  if (requireLifecycle && !validConclusion) errors.push('run_conclusion_invalid');
  return {
    valid: errors.length === 0,
    errors: normalizeReasons(errors),
    observation: errors.length === 0 ? {
      repository,
      runId,
      runAttempt: requireLifecycle ? run.run_attempt : null,
      runName: binding.runName,
      status: requireLifecycle ? run.status : null,
      conclusion: requireLifecycle ? run.conclusion : null,
    } : null,
  };
}

function normalizeReasons(reasons) {
  return [...new Set(reasons)].sort(compareCodePoint);
}

function crawlerIdsAreValid(ids) {
  return Array.isArray(ids)
    && ids.length > 0
    && ids.every((item) => typeof item === 'string' && CRAWLER_ID_RE.test(item))
    && new Set(ids).size === ids.length;
}

function primarySlicesAreValid(primarySlices, crawlerIds) {
  const values = primarySlices && typeof primarySlices === 'object' && !Array.isArray(primarySlices)
    ? Object.values(primarySlices)
    : [];
  return primarySlices && typeof primarySlices === 'object' && !Array.isArray(primarySlices)
    && canonicalJson(Object.keys(primarySlices).sort(compareCodePoint)) === canonicalJson([...crawlerIds].sort(compareCodePoint))
    && values.every(isValidCrawlerSlicePath)
    && new Set(values).size === values.length;
}

export function isValidCrawlerSlicePath(value) {
  return typeof value === 'string' && SLICE_RE.test(value);
}

function sliceFromReceipt(file, crawlerId, receiptCommit, remoteSliceOids) {
  const remoteBlobOid = Object.prototype.hasOwnProperty.call(remoteSliceOids, file.path)
    && (remoteSliceOids[file.path] === null || OBJECT_RE.test(remoteSliceOids[file.path]))
    ? remoteSliceOids[file.path]
    : null;
  const persisted = file.state === 'absent' ? remoteBlobOid === null : file.blobOid === remoteBlobOid;
  return {
    path: file.path,
    crawlerId,
    receiptCommit,
    state: file.state,
    blobOid: file.blobOid,
    sha256: file.sha256,
    remoteBlobOid,
    remoteSha256: persisted ? file.sha256 : null,
    persisted,
  };
}

/** Build a group terminal manifest from exact private-index commit receipts. */
export function createGroupTerminalManifest(input) {
  const reasons = Array.isArray(input.additionalReasons)
    ? input.additionalReasons.filter((reason) => GROUP_REASON_SET.has(reason))
    : [];
  const expectedCrawlerIds = Array.isArray(input.expectedCrawlerIds) ? [...input.expectedCrawlerIds] : [];
  if (!crawlerIdsAreValid(expectedCrawlerIds) || !primarySlicesAreValid(input.expectedPrimarySlices, expectedCrawlerIds)) {
    reasons.push('invalid_expected_roster');
  }
  const expected = [...new Set(expectedCrawlerIds.filter((item) => CRAWLER_ID_RE.test(item ?? '')))]
    .sort(compareCodePoint);
  const expectedPrimarySlices = Object.fromEntries(expected.flatMap((crawlerId) => (
    isValidCrawlerSlicePath(input.expectedPrimarySlices?.[crawlerId])
      ? [[crawlerId, input.expectedPrimarySlices[crawlerId]]]
      : []
  )));
  const receipts = Array.isArray(input.receipts)
    ? [...input.receipts].sort((left, right) => compareCodePoint(left?.crawlerId ?? '', right?.crawlerId ?? ''))
    : [];
  const receiptByCrawler = new Map();
  for (const receipt of receipts) {
    if (receipt?.crawlerId && receiptByCrawler.has(receipt.crawlerId)) reasons.push('receipt_invalid');
    else if (receipt?.crawlerId) receiptByCrawler.set(receipt.crawlerId, receipt);
  }
  const receiptEvidence = [...receiptByCrawler.values()]
    .filter((receipt) => validateCrawlerGenerationReceipt(receipt).valid)
    .sort((left, right) => compareCodePoint(left.crawlerId, right.crawlerId))
    .map((receipt) => ({
      crawlerId: receipt.crawlerId,
      outcome: receipt.outcome,
      commit: receipt.commit,
      remoteBaseCommit: receipt.remoteBaseCommit,
      receiptDigest: receipt.digest,
      fileCount: receipt.files.length,
    }));

  const acceptedReceipts = [];
  for (const crawlerId of expected) {
    const receipt = receiptByCrawler.get(crawlerId);
    if (!receipt) {
      reasons.push('receipt_missing');
    } else if (!validateCrawlerGenerationReceipt(receipt).valid) {
      reasons.push('receipt_invalid');
    } else if (!ACCEPTED_RECEIPT_OUTCOMES.has(receipt.outcome)) {
      reasons.push('receipt_failed');
    // Presence of the roster-bound record is mandatory; its state may be
    // explicit `absent` because some current crawler identities legitimately
    // publish no primary slice. The immutable remote tree must confirm it.
    } else if (!receipt.files.some((file) => file.path === expectedPrimarySlices[crawlerId])) {
      reasons.push('receipt_primary_slice_missing');
    } else {
      acceptedReceipts.push(receipt);
    }
  }
  if (receipts.some((receipt) => !expected.includes(receipt?.crawlerId))) reasons.push('receipt_invalid');

  const remoteSliceOids = input.remoteSliceOids && typeof input.remoteSliceOids === 'object'
    ? input.remoteSliceOids
    : {};
  const slices = [];
  const sliceOwners = new Set();
  for (const receipt of acceptedReceipts) {
    for (const file of receipt.files.filter((item) => SLICE_RE.test(item.path))) {
      if (sliceOwners.has(file.path)) {
        reasons.push('duplicate_slice_ownership');
        continue;
      }
      sliceOwners.add(file.path);
      const slice = sliceFromReceipt(file, receipt.crawlerId, receipt.commit, remoteSliceOids);
      if (!slice.persisted) reasons.push('slice_hash_mismatch');
      slices.push(slice);
    }
  }
  slices.sort((left, right) => compareCodePoint(left.path, right.path));

  if (input.waitOutcome !== 'success') reasons.push('wait_failed');
  const remoteCommit = typeof input.remoteCommit === 'string' && COMMIT_RE.test(input.remoteCommit)
    ? input.remoteCommit
    : null;
  if (remoteCommit === null) reasons.push('remote_fetch_failed');
  const normalizedReasons = normalizeReasons(reasons);
  const payload = {
    schemaVersion: 1,
    group: input.group,
    generationToken: isCrawlerGenerationToken(input.generationToken)
      ? input.generationToken
      : null,
    callerRepository: input.callerRepository,
    callerRunId: String(input.callerRunId ?? ''),
    callerRunAttempt: Number(input.callerRunAttempt),
    artifactName: `crawler-group-${input.group}-terminal-${String(input.callerRunId ?? '')}`,
    waitOutcome: input.waitOutcome,
    checkedAt: input.checkedAt,
    remote: { repository: input.remoteRepository, ref: input.remoteRef, commit: remoteCommit },
    expectedCrawlerIds: expected,
    expectedPrimarySlices,
    expectedCrawlers: expected.length,
    verifiedCrawlers: expected.filter((crawlerId) => slices.some((slice) => (
      slice.crawlerId === crawlerId && slice.path === expectedPrimarySlices[crawlerId]
    ))).length,
    expectedSlices: slices.length,
    verifiedSlices: slices.filter((slice) => slice.persisted).length,
    receiptEvidence,
    slices,
    valid: normalizedReasons.length === 0,
    reasons: normalizedReasons,
  };
  const manifest = { ...payload, digest: digestDocument(payload) };
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_GROUP_MANIFEST_BYTES) {
    throw new TypeError('Crawler group manifest exceeds byte limit');
  }
  return Object.freeze(manifest);
}

export function validateGroupTerminalManifest(manifest) {
  const topKeys = [
    'schemaVersion', 'group', 'generationToken', 'callerRepository', 'callerRunId', 'callerRunAttempt', 'artifactName',
    'waitOutcome', 'checkedAt', 'remote', 'expectedCrawlerIds', 'expectedCrawlers', 'verifiedCrawlers', 'expectedSlices', 'verifiedSlices',
    'expectedPrimarySlices', 'receiptEvidence', 'slices', 'valid', 'reasons', 'digest',
  ];
  if (!exactKeys(manifest, topKeys)) return { valid: false, errors: ['unsupported_schema'] };
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!GROUP_ID_SET.has(manifest.group)) errors.push('invalid_group');
  if (manifest.generationToken !== null && !isCrawlerGenerationToken(manifest.generationToken)) errors.push('invalid_generation_token');
  if (!REPOSITORY_RE.test(manifest.callerRepository ?? '')) errors.push('invalid_caller_repository');
  if (!validRunId(manifest.callerRunId)) errors.push('invalid_caller_run_id');
  if (!Number.isInteger(manifest.callerRunAttempt) || manifest.callerRunAttempt < 1) errors.push('invalid_caller_run_attempt');
  if (manifest.artifactName !== `crawler-group-${manifest.group}-terminal-${manifest.callerRunId}`) errors.push('invalid_artifact_name');
  if (!['success', 'failure', 'cancelled', 'skipped'].includes(manifest.waitOutcome)) errors.push('invalid_wait_outcome');
  if (!validIsoTimestamp(manifest.checkedAt)) errors.push('invalid_checked_at');
  if (!exactKeys(manifest.remote, ['repository', 'ref', 'commit'])) errors.push('invalid_remote_schema');
  if (manifest.remote?.repository !== SITE_REPOSITORY) errors.push('invalid_remote_repository');
  if (manifest.remote?.ref !== SITE_MAIN_REF) errors.push('invalid_remote_ref');
  if (manifest.remote?.commit !== null && !COMMIT_RE.test(manifest.remote.commit ?? '')) errors.push('invalid_remote_commit');
  if (!crawlerIdsAreValid(manifest.expectedCrawlerIds)) errors.push('invalid_expected_crawler_ids');
  if (!primarySlicesAreValid(manifest.expectedPrimarySlices, manifest.expectedCrawlerIds ?? [])) errors.push('invalid_expected_primary_slices');
  for (const field of ['expectedCrawlers', 'verifiedCrawlers', 'expectedSlices', 'verifiedSlices']) {
    if (!Number.isInteger(manifest[field]) || manifest[field] < 0) errors.push(`invalid_${field}`);
  }
  if (!Array.isArray(manifest.receiptEvidence)) errors.push('invalid_receipt_evidence');
  if (!Array.isArray(manifest.slices)) errors.push('invalid_slices');
  if (!Array.isArray(manifest.reasons) || manifest.reasons.some((reason) => !GROUP_REASON_SET.has(reason))) errors.push('invalid_reasons');
  if (typeof manifest.valid !== 'boolean') errors.push('invalid_valid_flag');
  if (!HASH_RE.test(manifest.digest ?? '')) errors.push('invalid_digest');
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_GROUP_MANIFEST_BYTES) errors.push('manifest_too_large');

  if (Array.isArray(manifest.receiptEvidence)) {
    const crawlerIds = [];
    for (const evidence of manifest.receiptEvidence) {
      if (!exactKeys(evidence, ['crawlerId', 'outcome', 'commit', 'remoteBaseCommit', 'receiptDigest', 'fileCount'])) {
        errors.push('invalid_receipt_evidence_schema');
        continue;
      }
      crawlerIds.push(evidence.crawlerId);
      if (!CRAWLER_ID_RE.test(evidence.crawlerId ?? '')) errors.push('invalid_receipt_evidence_crawler');
      if (!RECEIPT_OUTCOME_SET.has(evidence.outcome)) errors.push('invalid_receipt_evidence_outcome');
      if (!COMMIT_RE.test(evidence.commit ?? '') || !COMMIT_RE.test(evidence.remoteBaseCommit ?? '')) {
        errors.push('invalid_receipt_evidence_commit');
      }
      if ((evidence.outcome === 'noop') !== (evidence.commit === evidence.remoteBaseCommit)) {
        errors.push('invalid_receipt_evidence_transition');
      }
      if (!HASH_RE.test(evidence.receiptDigest ?? '')) errors.push('invalid_receipt_evidence_digest');
      if (!Number.isInteger(evidence.fileCount) || evidence.fileCount < 1 || evidence.fileCount > MAX_RECEIPT_FILES) {
        errors.push('invalid_receipt_evidence_file_count');
      }
    }
    if (new Set(crawlerIds).size !== crawlerIds.length) errors.push('duplicate_receipt_evidence_crawler');
    if (canonicalJson(crawlerIds) !== canonicalJson([...crawlerIds].sort(compareCodePoint))) {
      errors.push('non_canonical_receipt_evidence_order');
    }
  }
  if (Array.isArray(manifest.slices)) {
    const paths = [];
    for (const slice of manifest.slices) {
      if (!exactKeys(slice, ['path', 'crawlerId', 'receiptCommit', 'state', 'blobOid', 'sha256', 'remoteBlobOid', 'remoteSha256', 'persisted'])) {
        errors.push('invalid_slice_schema');
        continue;
      }
      paths.push(slice.path);
      if (!SLICE_RE.test(slice.path ?? '')) errors.push('invalid_slice_path');
      if (!CRAWLER_ID_RE.test(slice.crawlerId ?? '')) errors.push('invalid_slice_crawler');
      if (!COMMIT_RE.test(slice.receiptCommit ?? '')) errors.push('invalid_slice_commit');
      if (!['present', 'absent'].includes(slice.state)) errors.push('invalid_slice_state');
      if (slice.state === 'present' && !OBJECT_RE.test(slice.blobOid ?? '')) errors.push('invalid_slice_blob_oid');
      if (slice.state === 'present' && !HASH_RE.test(slice.sha256 ?? '')) errors.push('invalid_slice_hash');
      if (slice.state === 'absent' && (slice.blobOid !== null || slice.sha256 !== null)) errors.push('invalid_absent_slice_hash');
      if (slice.remoteBlobOid !== null && !OBJECT_RE.test(slice.remoteBlobOid ?? '')) errors.push('invalid_remote_slice_blob_oid');
      if (slice.remoteSha256 !== null && !HASH_RE.test(slice.remoteSha256 ?? '')) errors.push('invalid_remote_slice_hash');
      const persisted = slice.state === 'absent' ? slice.remoteBlobOid === null : slice.blobOid === slice.remoteBlobOid;
      if (slice.persisted !== persisted) errors.push('inconsistent_persisted_flag');
      if (slice.remoteSha256 !== (persisted ? slice.sha256 : null)) errors.push('inconsistent_remote_slice_hash');
    }
    if (canonicalJson(paths) !== canonicalJson([...paths].sort(compareCodePoint))) errors.push('non_canonical_slice_order');
  }

  try {
    const { digest, ...payload } = manifest;
    if (digestDocument(payload) !== digest) errors.push('digest_mismatch');
    if (manifest.expectedCrawlers !== manifest.expectedCrawlerIds.length) errors.push('inconsistent_expected_crawlers');
    if (manifest.expectedSlices !== manifest.slices.length) errors.push('inconsistent_expected_slices');
    if (manifest.verifiedSlices !== manifest.slices.filter((slice) => slice.persisted).length) {
      errors.push('inconsistent_verified_slices');
    }
    const verifiedCrawlerIds = manifest.expectedCrawlerIds.filter((crawlerId) => manifest.slices.some((slice) => (
      slice.crawlerId === crawlerId && slice.path === manifest.expectedPrimarySlices[crawlerId]
    )));
    if (manifest.verifiedCrawlers !== verifiedCrawlerIds.length) errors.push('inconsistent_verified_crawlers');
    if (canonicalJson(manifest.reasons) !== canonicalJson(normalizeReasons(manifest.reasons))) {
      errors.push('non_canonical_reasons');
    }
    if (manifest.valid !== (manifest.reasons.length === 0)) errors.push('inconsistent_valid_flag');
    if (manifest.valid) {
      const evidenceCrawlerIds = manifest.receiptEvidence.map((evidence) => evidence.crawlerId);
      if (canonicalJson(evidenceCrawlerIds) !== canonicalJson(manifest.expectedCrawlerIds)) errors.push('incomplete_ready_receipt_evidence');
      if (manifest.receiptEvidence.some((evidence) => !ACCEPTED_RECEIPT_OUTCOMES.has(evidence.outcome))) {
        errors.push('failed_ready_receipt_evidence');
      }
      if (manifest.waitOutcome !== 'success' || manifest.remote.commit === null) errors.push('invalid_ready_terminal_state');
      if (manifest.verifiedCrawlers !== manifest.expectedCrawlers || manifest.verifiedSlices !== manifest.expectedSlices) {
        errors.push('incomplete_ready_persistence');
      }
    }
  } catch {
    errors.push('invalid_manifest_invariants');
  }
  return { valid: errors.length === 0, errors: normalizeReasons(errors) };
}

export function createCrawlerGenerationRoster(groups, primarySlices) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new TypeError('Invalid roster groups');
  if (canonicalJson(Object.keys(groups).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    throw new TypeError('Roster must contain exactly 23 groups');
  }
  const seen = new Set();
  const normalizedGroups = {};
  for (const group of GROUP_IDS) {
    if (!crawlerIdsAreValid(groups[group])) throw new TypeError(`Invalid roster for group ${group}`);
    normalizedGroups[group] = [...groups[group]].sort(compareCodePoint);
    for (const crawlerId of normalizedGroups[group]) {
      if (seen.has(crawlerId)) throw new TypeError(`Duplicate roster crawler: ${crawlerId}`);
      seen.add(crawlerId);
    }
  }
  if (!primarySlicesAreValid(primarySlices, [...seen])) throw new TypeError('Invalid roster primary slices');
  const normalizedPrimarySlices = Object.fromEntries([...seen].sort(compareCodePoint).map((crawlerId) => [crawlerId, primarySlices[crawlerId]]));
  const payload = {
    schemaVersion: 1, groupCount: GROUP_IDS.length, crawlerCount: seen.size,
    groups: normalizedGroups, primarySlices: normalizedPrimarySlices,
  };
  return { ...payload, digest: digestDocument(payload) };
}

export function validateCrawlerGenerationRoster(roster) {
  if (!exactKeys(roster, ['schemaVersion', 'groupCount', 'crawlerCount', 'groups', 'primarySlices', 'digest'])) {
    return { valid: false, errors: ['unsupported_schema'] };
  }
  const errors = [];
  try {
    if (canonicalJson(roster) !== canonicalJson(createCrawlerGenerationRoster(roster.groups, roster.primarySlices))) errors.push('roster_rebuild_mismatch');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'invalid_roster');
  }
  return { valid: errors.length === 0, errors: normalizeReasons(errors) };
}

/**
 * Immutable same-repository sentinel input for one crawler generation.
 *
 * `siteCodeCommit` pins the observer implementation only. The terminal data
 * snapshot does not exist when the 23 runs are dispatched and is therefore
 * deliberately absent; it is derived later from their terminal manifests.
 */
export function createCrawlerGenerationSentinel(input) {
  if (!isCrawlerGenerationToken(input.generationToken)) throw new TypeError('Invalid generation token');
  if (!COMMIT_RE.test(input.siteCodeCommit ?? '')) throw new TypeError('Invalid site code commit');
  if (!COMMIT_RE.test(input.corpusCodeCommit ?? '')) throw new TypeError('Invalid corpus code commit');
  if (!input.groupRunIds || typeof input.groupRunIds !== 'object' || Array.isArray(input.groupRunIds)
      || canonicalJson(Object.keys(input.groupRunIds).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    throw new TypeError('Sentinel must bind exactly 23 groups');
  }
  const runIds = GROUP_IDS.map((group) => input.groupRunIds[group] === null
    ? null
    : String(input.groupRunIds[group] ?? ''));
  const presentRunIds = runIds.filter((runId) => runId !== null);
  if (runIds.some((runId) => runId !== null && !validRunId(runId))
      || new Set(presentRunIds).size !== presentRunIds.length) {
    throw new TypeError('Present sentinel run IDs must be unique positive integers');
  }
  const groups = Object.fromEntries(GROUP_IDS.map((group, index) => [
    group,
    crawlerGenerationWorkflowIdentity(group, input.generationToken, runIds[index], input.corpusCodeCommit),
  ]));
  const diagnosticsInput = input.dispatchDiagnostics ?? Object.fromEntries(GROUP_IDS.map((group, index) => [
    group,
    { status: runIds[index] === null ? 'missing' : 'direct', runId: runIds[index] },
  ]));
  if (!diagnosticsInput || typeof diagnosticsInput !== 'object' || Array.isArray(diagnosticsInput)
      || canonicalJson(Object.keys(diagnosticsInput).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    throw new TypeError('Sentinel dispatch diagnostics must contain exactly 23 groups');
  }
  const dispatchDiagnostics = {};
  for (const group of GROUP_IDS) {
    const diagnostic = diagnosticsInput[group];
    const diagnosticRunId = diagnostic?.runId === null ? null : String(diagnostic?.runId ?? '');
    if (!exactKeys(diagnostic, ['status', 'runId']) || !DISPATCH_STATUS_SET.has(diagnostic.status)
        || (diagnosticRunId !== null && !validRunId(diagnosticRunId))) {
      throw new TypeError(`Invalid dispatch diagnostic for group ${group}`);
    }
    const boundRunId = groups[group].runId;
    if (ACCEPTED_DISPATCH_STATUS_SET.has(diagnostic.status)) {
      if (diagnosticRunId === null || diagnosticRunId !== boundRunId) {
        throw new TypeError(`Accepted dispatch diagnostic is not bound for group ${group}`);
      }
    } else if (boundRunId !== null) {
      throw new TypeError(`Negative dispatch diagnostic cannot bind group ${group}`);
    }
    if (NULL_DISPATCH_RUN_ID_STATUS_SET.has(diagnostic.status) && diagnosticRunId !== null) {
      throw new TypeError(`Dispatch diagnostic must not retain a run ID for group ${group}`);
    }
    dispatchDiagnostics[group] = { status: diagnostic.status, runId: diagnosticRunId };
  }
  const payload = {
    schemaVersion: 1,
    generationToken: input.generationToken,
    siteCodeCommit: input.siteCodeCommit,
    corpusCodeCommit: input.corpusCodeCommit,
    callerRepository: CALLER_REPOSITORY,
    groups,
    dispatchDiagnostics,
  };
  const sentinel = { ...payload, digest: digestDocument(payload) };
  if (Buffer.byteLength(JSON.stringify(sentinel)) > MAX_SENTINEL_BYTES) {
    throw new TypeError('Crawler generation sentinel exceeds byte limit');
  }
  return Object.freeze(sentinel);
}

export function validateCrawlerGenerationSentinel(sentinel) {
  const errors = [];
  if (!exactKeys(sentinel, [
    'schemaVersion', 'generationToken', 'siteCodeCommit', 'corpusCodeCommit', 'callerRepository', 'groups', 'dispatchDiagnostics', 'digest',
  ])) return { valid: false, errors: ['unsupported_schema'] };
  if (sentinel.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!isCrawlerGenerationToken(sentinel.generationToken)) errors.push('invalid_generation_token');
  if (!COMMIT_RE.test(sentinel.siteCodeCommit ?? '')) errors.push('invalid_site_code_commit');
  if (!COMMIT_RE.test(sentinel.corpusCodeCommit ?? '')) errors.push('invalid_corpus_code_commit');
  if (sentinel.callerRepository !== CALLER_REPOSITORY) errors.push('invalid_caller_repository');
  if (!HASH_RE.test(sentinel.digest ?? '')) errors.push('invalid_digest');
  if (!sentinel.groups || typeof sentinel.groups !== 'object' || Array.isArray(sentinel.groups)
      || canonicalJson(Object.keys(sentinel.groups).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    errors.push('invalid_group_set');
  } else {
    const runIds = [];
    for (const group of GROUP_IDS) {
      const entry = sentinel.groups[group];
      // Legacy shim (paired with dispatchRefForBinding above): a group entry
      // persisted by a dispatcher run before `generationToken` joined the
      // binding schema is missing that key entirely. Accept both shapes so a
      // generation cycle in flight across a deploy still validates.
      const isLegacyEntry = entry && typeof entry === 'object' && !Array.isArray(entry)
        && !Object.prototype.hasOwnProperty.call(entry, 'generationToken');
      const entryKeys = isLegacyEntry
        ? ['workflowFile', 'workflowName', 'runId', 'runName', 'artifactName', 'corpusCodeCommit']
        : ['workflowFile', 'workflowName', 'runId', 'runName', 'generationToken', 'artifactName', 'corpusCodeCommit'];
      if (!exactKeys(entry, entryKeys)) {
        errors.push('invalid_group_binding_schema');
        continue;
      }
      runIds.push(entry.runId);
      const expected = crawlerGenerationWorkflowIdentity(
        group, sentinel.generationToken, entry.runId, sentinel.corpusCodeCommit,
      );
      const expectedComparable = isLegacyEntry
        ? Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'generationToken'))
        : expected;
      if ((entry.runId !== null && !validRunId(entry.runId))
          || canonicalJson(entry) !== canonicalJson(expectedComparable)) {
        errors.push('invalid_group_binding');
      }
    }
    const presentRunIds = runIds.filter((runId) => runId !== null);
    if (runIds.length !== GROUP_IDS.length || new Set(presentRunIds).size !== presentRunIds.length) {
      errors.push('duplicate_run_id');
    }
  }
  if (!sentinel.dispatchDiagnostics || typeof sentinel.dispatchDiagnostics !== 'object'
      || Array.isArray(sentinel.dispatchDiagnostics)
      || canonicalJson(Object.keys(sentinel.dispatchDiagnostics).sort(compareCodePoint)) !== canonicalJson(GROUP_IDS)) {
    errors.push('invalid_dispatch_diagnostics_set');
  } else if (sentinel.groups && typeof sentinel.groups === 'object' && !Array.isArray(sentinel.groups)) {
    for (const group of GROUP_IDS) {
      const diagnostic = sentinel.dispatchDiagnostics[group];
      const boundRunId = sentinel.groups[group]?.runId;
      if (!exactKeys(diagnostic, ['status', 'runId']) || !DISPATCH_STATUS_SET.has(diagnostic.status)
          || (diagnostic.runId !== null && !validRunId(diagnostic.runId))) {
        errors.push('invalid_dispatch_diagnostic');
        continue;
      }
      if (ACCEPTED_DISPATCH_STATUS_SET.has(diagnostic.status)
          ? diagnostic.runId === null || diagnostic.runId !== boundRunId
          : boundRunId !== null) {
        errors.push('inconsistent_dispatch_diagnostic_binding');
      }
      if (NULL_DISPATCH_RUN_ID_STATUS_SET.has(diagnostic.status) && diagnostic.runId !== null) {
        errors.push('invalid_dispatch_diagnostic_run_id');
      }
    }
  }
  try {
    if (Buffer.byteLength(JSON.stringify(sentinel)) > MAX_SENTINEL_BYTES) errors.push('sentinel_too_large');
    const { digest, ...payload } = sentinel;
    if (digestDocument(payload) !== digest) errors.push('digest_mismatch');
  } catch {
    errors.push('invalid_canonical_payload');
  }
  return { valid: errors.length === 0, errors: normalizeReasons(errors) };
}

/** Resolve same-generation replays without choosing between conflicting evidence. */
export function resolveCrawlerGenerationSentinels(sentinels) {
  const values = Array.isArray(sentinels) ? sentinels : [];
  if (values.length === 0) {
    return { status: 'blocked', reason: 'sentinel_missing', sentinel: null, replayCount: 0 };
  }
  if (values.some((sentinel) => !validateCrawlerGenerationSentinel(sentinel).valid)) {
    return { status: 'blocked', reason: 'sentinel_invalid', sentinel: null, replayCount: values.length };
  }
  const digests = new Set(values.map((sentinel) => sentinel.digest));
  if (digests.size !== 1) {
    return { status: 'blocked', reason: 'sentinel_conflict', sentinel: null, replayCount: values.length };
  }
  return { status: 'accepted', reason: null, sentinel: values[0], replayCount: values.length };
}

/**
 * Select the immutable terminal snapshot without reading the current branch
 * tip: it must be the sole manifest commit descending from every other tip.
 */
export function deriveCrawlerGenerationSourceCommit({ manifests, siteCodeCommit, isAncestor }) {
  const keys = manifests && typeof manifests === 'object' && !Array.isArray(manifests)
    ? Object.keys(manifests).sort(compareCodePoint)
    : [];
  if (!COMMIT_RE.test(siteCodeCommit ?? '') || canonicalJson(keys) !== canonicalJson(GROUP_IDS)) {
    return { status: 'blocked', sourceCommit: null, reason: 'terminal_manifest_set_invalid' };
  }
  const commits = [];
  for (const group of GROUP_IDS) {
    const manifest = manifests[group];
    if (!manifest || manifest.group !== group || !COMMIT_RE.test(manifest.remote?.commit ?? '')) {
      return { status: 'blocked', sourceCommit: null, reason: 'terminal_manifest_set_invalid' };
    }
    commits.push(manifest.remote.commit);
  }
  const uniqueCommits = [...new Set(commits)].sort(compareCodePoint);
  try {
    // A single pass promotes the candidate whenever a later supplied commit
    // descends from it. A second linear pass proves that the final candidate
    // descends from every tip. This also handles a merge tip encountered after
    // two incomparable parents, without the O(tips²) ancestry fan-out.
    let candidate = uniqueCommits[0];
    for (const commit of uniqueCommits.slice(1)) {
      if (isAncestor(candidate, commit)) candidate = commit;
    }
    if (uniqueCommits.some((commit) => commit !== candidate && !isAncestor(commit, candidate))) {
      return { status: 'blocked', sourceCommit: null, reason: 'source_history_incomparable' };
    }
    if (!isAncestor(siteCodeCommit, candidate)) {
      return { status: 'blocked', sourceCommit: null, reason: 'source_history_rewritten' };
    }
    return { status: 'ready', sourceCommit: candidate, reason: null };
  } catch {
    return { status: 'infrastructure_error', sourceCommit: null, reason: 'source_history_check_failed' };
  }
}

function registryEntryIsValid(entry, group, generationToken) {
  return exactKeys(entry, ['repository', 'workflow', 'runId', 'runName'])
    && entry.repository === CALLER_REPOSITORY
    && entry.workflow === `crawler-group-${group}.yml`
    && validRunId(entry.runId)
    && entry.runName === `crawler-generation-${generationToken}-group-${group}`;
}

function sameStringArrays(left, right) {
  return canonicalJson([...left].sort(compareCodePoint)) === canonicalJson([...right].sort(compareCodePoint));
}

const BLOCKING_STATUS_PRIORITY = Object.fromEntries([
  'blocked_dispatch_missing', 'blocked_group_cancelled', 'blocked_group_timed_out', 'blocked_group_failed',
  'blocked_manifest_missing', 'blocked_manifest_invalid', 'blocked_timeout', 'waiting',
].map((status, index) => [status, index]));

function runObservationIsBound(observation, entry) {
  if (!(exactKeys(observation, ['repository', 'runId', 'runAttempt', 'runName', 'status', 'conclusion'])
    && observation.repository === entry.repository
    && observation.runId === entry.runId
    && observation.runName === entry.runName
    && Number.isInteger(observation.runAttempt)
    && observation.runAttempt >= 1
    && (observation.status === 'completed'
      || CRAWLER_GENERATION_NONTERMINAL_RUN_STATUSES.includes(observation.status)))) return false;
  if (observation.status !== 'completed') return observation.conclusion === null;
  return ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure']
    .includes(observation.conclusion);
}

export function validateCrawlerGenerationObservationsEnvelope(value) {
  const valid = exactKeys(value, ['schemaVersion', 'evaluatedAt', 'timedOut', 'groups'])
    && value.schemaVersion === 1
    && validIsoTimestamp(value.evaluatedAt)
    && typeof value.timedOut === 'boolean'
    && value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)
    && sameStringArrays(Object.keys(value.groups), GROUP_IDS);
  return valid ? { valid: true, errors: [] } : { valid: false, errors: ['invalid_observations_envelope'] };
}

/** Pure central barrier evaluation. The caller supplies immutable Git tree oracles. */
export function evaluateCrawlerGenerationBarrier(input) {
  const rosterValidation = validateCrawlerGenerationRoster(input.roster);
  const registry = input.runRegistry;
  const registryShapeValid = exactKeys(registry, ['schemaVersion', 'cycleId', 'generationToken', 'groups'])
    && registry.schemaVersion === 1
    && registry.cycleId === input.cycleId
    && registry.groups && typeof registry.groups === 'object' && !Array.isArray(registry.groups);
  const generationTokenValid = registryShapeValid
    && typeof registry.generationToken === 'string'
    && isCrawlerGenerationToken(registry.generationToken)
    && registry.generationToken === registry.cycleId;
  const registryGroupKeysValid = registryShapeValid && sameStringArrays(Object.keys(registry.groups), GROUP_IDS);
  const registryRunIds = registryGroupKeysValid
    ? GROUP_IDS.map((group) => registry.groups[group]?.runId).filter((runId) => validRunId(runId))
    : [];
  const registryRunIdsUnique = registryRunIds.length === GROUP_IDS.length && new Set(registryRunIds).size === GROUP_IDS.length;
  const sourceCommitValid = COMMIT_RE.test(input.sourceCommit ?? '');
  const aggregateManifestBytes = GROUP_IDS.reduce((total, group) => {
    try { return total + Buffer.byteLength(JSON.stringify(input.manifests?.[group] ?? null)); } catch { return MAX_CYCLE_MANIFEST_BYTES + 1; }
  }, 0);
  const aggregateManifestsValid = aggregateManifestBytes <= MAX_CYCLE_MANIFEST_BYTES;
  const groupReports = {};

  for (const group of GROUP_IDS) {
    const entry = registryShapeValid ? registry.groups[group] : null;
    const observation = input.runObservations?.[group];
    const manifest = input.manifests?.[group];
    const reasons = [];
    let state = 'ready';
    if (!generationTokenValid) {
      state = 'blocked_dispatch_missing'; reasons.push('missing_or_invalid_generation_token');
    } else if (!registryGroupKeysValid || !registryRunIdsUnique) {
      state = 'blocked_dispatch_missing'; reasons.push('run_registry_not_exactly_23_unique_ids');
    } else if (!registryEntryIsValid(entry, group, registry.generationToken)) {
      state = 'blocked_dispatch_missing'; reasons.push('missing_or_invalid_run_binding');
    } else if (!runObservationIsBound(observation, entry)) {
      state = 'blocked_dispatch_missing'; reasons.push('missing_or_invalid_run_observation');
    } else if (observation.status !== 'completed') {
      state = input.timedOut ? 'blocked_timeout' : 'waiting'; reasons.push('caller_run_not_completed');
    } else if (observation.conclusion === 'cancelled') {
      state = 'blocked_group_cancelled'; reasons.push('caller_run_cancelled');
    } else if (observation.conclusion === 'timed_out') {
      state = 'blocked_group_timed_out'; reasons.push('caller_run_timed_out');
    } else if (!['success', 'failure'].includes(observation.conclusion)) {
      state = 'blocked_group_failed'; reasons.push('caller_run_failed');
    } else {
      const validation = validateGroupTerminalManifest(manifest);
      let accepted = validation.valid;
      if (!validation.valid) reasons.push(...validation.errors);
      if (accepted && (
        manifest.group !== group
        || manifest.generationToken !== registry.generationToken
        || manifest.callerRepository !== entry.repository
        || manifest.callerRunId !== entry.runId
        || manifest.callerRunAttempt !== observation.runAttempt
        || manifest.artifactName !== `crawler-group-${group}-terminal-${entry.runId}`
        || !rosterValidation.valid
        || !sameStringArrays(manifest.expectedCrawlerIds, input.roster.groups[group])
        || canonicalJson(manifest.expectedPrimarySlices) !== canonicalJson(Object.fromEntries(
          input.roster.groups[group].map((crawlerId) => [crawlerId, input.roster.primarySlices[crawlerId]]),
        ))
        || manifest.remote.repository !== SITE_REPOSITORY
        || manifest.remote.ref !== SITE_MAIN_REF
        || manifest.valid !== true
      )) {
        accepted = false; reasons.push('manifest_binding_mismatch');
      }
      if (accepted && !sourceCommitValid) {
        accepted = false; reasons.push('invalid_source_commit');
      }
      if (accepted && !aggregateManifestsValid) {
        accepted = false; reasons.push('manifest_cycle_too_large');
      }
      if (accepted) {
        try {
          // Receipt commits were already checked against this immutable group
          // tip by the finalizer. The central snapshot only re-checks the 23
          // group tips against the explicit source commit.
          const commits = [manifest.remote.commit];
          if (commits.some((commit) => !input.isAncestor(commit, input.sourceCommit))) {
            accepted = false; reasons.push('remote_commit_not_ancestor');
          }
          if (accepted && manifest.slices.some((slice) => !input.sourceFileMatches(input.sourceCommit, slice))) {
            accepted = false; reasons.push('source_slice_hash_mismatch');
          }
        } catch {
          accepted = false; reasons.push('source_tree_check_failed');
        }
      }
      if (!accepted) {
        if (observation.conclusion === 'failure') state = 'blocked_group_failed';
        else if (manifest === undefined || manifest === null) state = 'blocked_manifest_missing';
        else state = 'blocked_manifest_invalid';
      }
    }
    groupReports[group] = {
      state,
      callerRepository: entry?.repository ?? null,
      callerRunId: entry?.runId ?? null,
      status: observation?.status ?? null,
      conclusion: observation?.conclusion ?? null,
      manifestDigest: typeof manifest?.digest === 'string' ? manifest.digest : null,
      remoteCommit: typeof manifest?.remote?.commit === 'string' ? manifest.remote.commit : null,
      reasons: normalizeReasons(reasons),
    };
  }

  const nonReadyStatuses = Object.values(groupReports).map((group) => group.state).filter((item) => item !== 'ready');
  const status = nonReadyStatuses.length === 0
    ? 'ready'
    : nonReadyStatuses.sort((left, right) => BLOCKING_STATUS_PRIORITY[left] - BLOCKING_STATUS_PRIORITY[right])[0];
  const payload = {
    schemaVersion: 1,
    cycleId: input.cycleId,
    expectedGroups: GROUP_IDS.length,
    groups: groupReports,
    barrier: { status, readyAt: status === 'ready' ? input.evaluatedAt : null, sourceCommit: sourceCommitValid ? input.sourceCommit : null },
    translation: { mode: 'shadow', wouldDispatch: status === 'ready', dispatched: false },
  };
  return { ...payload, digest: digestDocument(payload) };
}
