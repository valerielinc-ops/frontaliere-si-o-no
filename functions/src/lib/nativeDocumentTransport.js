/** Node/Functions-only, deterministic file-transport capabilities.
 * The caller must hydrate scope, Stage-validated target and documents from its
 * current private server reads, including the actual GCS bytes/generation.
 * Neither a client-shaped manifest nor clientCheck is an authority here.
 * No IO, candidate confirmation, content classification or qualification claim.
 */
import { createHash } from 'node:crypto';
import { nativeFilePurposeCaption, nativeFilePurposeContract } from './nativeFilePurpose.js';
import { neutralApplicationScopePattern } from './nativeFormContract.js';
import { nativeQuestionText } from './nativeQuestionText.js';

export const NATIVE_DOCUMENT_TRANSPORT_VERSION = 'server-native-document-transport-v1';
const neutralScope = new RegExp(neutralApplicationScopePattern, 'iu');
const HASH = /^[a-f0-9]{64}$/u;
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = reason => ({ status: 'unverified', reason, nextAction: 'select_existing_document' });

function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) throw new TypeError('non_json_contract');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const json = value => JSON.stringify(canonical(value));
const same = (left, right) => json(left) === json(right);
const digest = (domain, value) => createHash('sha256').update(`${domain}:${json(value)}`).digest('hex');

function url(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function scopeOf(value) {
  if (!record(value) || !ID(value.orderId) || !Number.isSafeInteger(value.round) || value.round < 1
    || value.jobId != null && !ID(value.jobId) || !url(value.sourceJobUrl)) return null;
  return { orderId: value.orderId, round: value.round, jobId: value.jobId ?? null, sourceJobUrl: url(value.sourceJobUrl) };
}

function targetOf(value) {
  if (!record(value) || !ID(value.fieldId) || !url(value.frameUrl) || !url(value.expectedApplyUrl)
    || typeof value.multiple !== 'boolean') return null;
  return { expectedApplyUrl: url(value.expectedApplyUrl), frameUrl: url(value.frameUrl), fieldId: value.fieldId, multiple: value.multiple };
}

function fullContract(value, multiple) {
  if (!record(value) || !record(value.validation)) return null;
  // The native producer supplies the actual boolean property. A conflicting
  // or non-canonical wire value is not silently interpreted as another control.
  if (Object.hasOwn(value.validation, 'multiple') && value.validation.multiple !== multiple) return null;
  if (!Object.hasOwn(value.validation, 'multiple') && multiple) return null;
  const purpose = nativeFilePurposeContract(value);
  return purpose ? { contract: canonical(value), purpose } : null;
}

function requestedPurpose(request) {
  if (!record(request) || !ID(request.id) || typeof request.label !== 'string' || request.kind !== 'diploma'
    || request.required != null && typeof request.required !== 'boolean'
    || request.quote != null && typeof request.quote !== 'string'
    || request.keywords != null && (!Array.isArray(request.keywords) || request.keywords.some(word => typeof word !== 'string'))) return null;
  const purpose = nativeFilePurposeCaption(request.label);
  if (purpose?.family !== 'diploma') return null;
  const constraints = { ...purpose.constraints };
  // Request aliases and quoted instructions cannot silently discard a subject,
  // degree level or competing purpose. Unknown meaning needs a new selection.
  for (const text of [...(request.keywords || []), request.quote || ''].filter(text => text.trim())) {
    if (text === request.quote && neutralScope.test(nativeQuestionText(text))) continue;
    const alias = nativeFilePurposeCaption(text);
    if (!alias || alias.family !== purpose.family) return null;
    for (const [key, value] of Object.entries(alias.constraints)) {
      if (constraints[key] != null && constraints[key] !== value) return null;
      constraints[key] = value;
    }
  }
  return { family: purpose.family, constraints };
}

function selectedFiles(attachment, multiple) {
  if (!record(attachment) || ['cv', 'cover_letter'].includes(attachment.slot)) return null;
  const set = Array.isArray(attachment.files);
  if (multiple && !set || set && ['fileId', 'generation', 'sha256', 'size'].some(key => Object.hasOwn(attachment, key))) return null;
  const files = set ? attachment.files : [attachment];
  if (!files.length || !multiple && files.length !== 1) return null;
  const seen = new Set(); const out = [];
  for (const file of files) {
    if (!record(file) || !ID(file.documentId) || !ID(file.fileId) || !HASH.test(file.sha256 || '')
      || typeof file.generation !== 'string' || !/^\d+$/u.test(file.generation)
      || !Number.isSafeInteger(file.size) || file.size <= 0) return null;
    const key = json([file.documentId, file.fileId]);
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ documentId: file.documentId, fileId: file.fileId, sha256: file.sha256, generation: file.generation, size: file.size });
  }
  return out.sort((a, b) => a.documentId.localeCompare(b.documentId) || a.fileId.localeCompare(b.fileId));
}

/** Construct only from current server membership and Stage-validated target.
 * attachment is the proposed native selection, enriched by one unambiguous
 * server-manifest join; its slot and any advisory verdict never grant purpose.
 */
export function resolveNativeDocumentTransport({ scope, target, nativeField, attachment, documents } = {}) {
  try {
    const currentScope = scopeOf(scope); const currentTarget = targetOf(target);
    if (!currentScope) return fail('document_scope_unverified');
    if (!currentTarget || !record(nativeField) || nativeField.fieldId !== currentTarget.fieldId
      || url(nativeField.frameUrl) !== currentTarget.frameUrl || attachment?.fieldId !== currentTarget.fieldId) return fail('document_target_unverified');
    const native = fullContract(nativeField.nativeFormContract, currentTarget.multiple);
    if (!native || native.purpose.family !== 'diploma') return fail('document_purpose_unverified');
    const files = selectedFiles(attachment, currentTarget.multiple);
    if (!files || !Array.isArray(documents)) return fail('document_selection_unverified');
    let request = null; let purpose = null;
    for (const file of files) {
      const candidates = documents.filter(item => item?.documentId === file.documentId && item?.fileId === file.fileId);
      if (candidates.length !== 1) return fail('document_assignment_ambiguous');
      const source = candidates[0];
      if (source.assigned !== true || ['cv', 'cover_letter'].includes(source.slot)
        || !scopeOf(source.scope) || !same(scopeOf(source.scope), currentScope)) return fail('document_assignment_unverified');
      if (source.sha256 !== file.sha256 || source.generation !== file.generation || source.size !== file.size) return fail('document_bytes_changed');
      const actualRequest = source.requestedDocument;
      const actualPurpose = requestedPurpose(actualRequest);
      if (!actualPurpose || actualRequest.id !== source.documentId || source.kind !== actualRequest.kind) return fail('document_request_unverified');
      if (request && !same(request, actualRequest)) return fail('document_request_ambiguous');
      if (Object.entries(native.purpose.constraints).some(([key, value]) => actualPurpose.constraints[key] !== value)) return fail('document_purpose_constraints_unverified');
      request = canonical(actualRequest); purpose = actualPurpose;
    }
    const material = {
      version: NATIVE_DOCUMENT_TRANSPORT_VERSION, category: 'file_transport',
      provenance: { actor: 'server', basis: 'current_server_document_assignment' },
      scope: currentScope, target: currentTarget,
      purpose: native.purpose, requestedPurpose: purpose,
      documentId: request.id,
      requestContextHash: digest('native-document-request-v1', request),
      nativeContractHash: digest('native-document-contract-v1', native.contract),
      files,
    };
    return { status: 'verified', attestation: { ...material, id: `document-transport-${digest('native-document-transport-v1', material)}` } };
  } catch { return fail('document_context_unverified'); }
}

/** A digest is not client authority: rederive against fresh private inputs.
 * No previously supplied receipt survives changed scope/target/request/bytes.
 */
export function validateNativeDocumentTransport(attestation, currentInputs) {
  const current = resolveNativeDocumentTransport(currentInputs);
  if (current.status !== 'verified') return current;
  try {
    return same(attestation, current.attestation) ? current : fail('document_transport_stale');
  } catch { return fail('document_transport_stale'); }
}
