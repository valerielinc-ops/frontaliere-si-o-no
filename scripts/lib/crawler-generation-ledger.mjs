import { digestDocument } from './canonical-json-digest.mjs';
import { isCrawlerGroupId } from './crawler-generation-group-ids.mjs';
import { isCrawlerGenerationToken } from './crawler-generation-token.mjs';

export const GROUP_MANIFEST_REASON_CODES = Object.freeze([
  'wait_failed',
  'remote_fetch_failed',
  'invalid_expected_roster',
  'receipt_missing',
  'receipt_invalid',
  'generation_token_missing',
  'ledger_persistence_failed',
  'receipt_primary_slice_missing',
  'receipt_failed',
  'receipt_commit_not_ancestor',
  'receipt_blob_mismatch',
  'slice_hash_mismatch',
  'duplicate_slice_ownership',
  'manifest_internal_error',
]);

const LEDGER_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LEDGER_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const LEDGER_REASON_SET = new Set(GROUP_MANIFEST_REASON_CODES);
const LEDGER_KEYS = [
  'schemaVersion', 'group', 'generationToken', 'callerRepository', 'callerRunId', 'callerRunAttempt',
  'checkedAt', 'remoteCommit', 'manifestDigest', 'valid', 'reasons', 'digest',
];

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ledgerPayload(manifest) {
  return {
    schemaVersion: 1,
    group: manifest.group,
    generationToken: manifest.generationToken,
    callerRepository: manifest.callerRepository,
    callerRunId: manifest.callerRunId,
    callerRunAttempt: manifest.callerRunAttempt,
    checkedAt: manifest.checkedAt,
    remoteCommit: manifest.remote?.commit ?? null,
    manifestDigest: manifest.digest,
    valid: manifest.valid,
    reasons: manifest.reasons,
  };
}

export function createCrawlerGenerationLedgerEntry(manifest) {
  const payload = ledgerPayload(manifest);
  return { ...payload, digest: digestDocument(payload) };
}

export function validateCrawlerGenerationLedgerEntry(entry) {
  if (!exactKeys(entry, LEDGER_KEYS)) return { valid: false, errors: ['unsupported_schema'] };
  const errors = [];
  if (entry.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!isCrawlerGroupId(entry.group)) errors.push('invalid_group');
  if (entry.generationToken !== null && !isCrawlerGenerationToken(entry.generationToken)) errors.push('invalid_generation_token');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.callerRepository ?? '')) errors.push('invalid_caller_repository');
  if (!/^[1-9][0-9]*$/.test(entry.callerRunId ?? '')) errors.push('invalid_caller_run_id');
  if (!Number.isInteger(entry.callerRunAttempt) || entry.callerRunAttempt < 1) errors.push('invalid_caller_run_attempt');
  if (typeof entry.checkedAt !== 'string' || Number.isNaN(Date.parse(entry.checkedAt))) errors.push('invalid_checked_at');
  if (entry.remoteCommit !== null && !LEDGER_COMMIT_RE.test(entry.remoteCommit ?? '')) errors.push('invalid_remote_commit');
  if (!LEDGER_HASH_RE.test(entry.manifestDigest ?? '')) errors.push('invalid_manifest_digest');
  if (typeof entry.valid !== 'boolean') errors.push('invalid_valid_flag');
  if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => !LEDGER_REASON_SET.has(reason))) errors.push('invalid_reasons');
  if (Array.isArray(entry.reasons) && new Set(entry.reasons).size !== entry.reasons.length) errors.push('duplicate_reasons');
  if (entry.valid === true && Array.isArray(entry.reasons) && entry.reasons.length > 0) errors.push('valid_entry_has_reasons');
  if (entry.valid === false && Array.isArray(entry.reasons) && entry.reasons.length === 0) errors.push('invalid_entry_without_reasons');
  if (entry.generationToken === null && Array.isArray(entry.reasons) && !entry.reasons.includes('generation_token_missing')) errors.push('missing_generation_token_reason');
  if (!LEDGER_HASH_RE.test(entry.digest ?? '')) errors.push('invalid_digest');
  try {
    const { digest: _digest, ...payload } = entry;
    if (digestDocument(payload) !== entry.digest) errors.push('digest_mismatch');
  } catch { errors.push('digest_mismatch'); }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors: [...new Set(errors)] };
}
