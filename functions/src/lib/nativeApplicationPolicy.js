/** Source-bound answer policy shared by the native runner and server proof route.
 * Pure policy: no DOM, filesystem, network, provider or candidate-projection resolver.
 */
import { isConsentOnly, isConsentRefusal, pureApplicationConsent } from './applicationConsent.js';
import { nativeFormContract, rawNativeFormContract, nativePolicyField, nativeFieldFromContract, ownedAddressContract, consentContract, nativeScopeAllows } from './nativeFormContract.js';
import { nativeQuestionText } from './nativeQuestionText.js';
import { candidateIdentityRole, isCandidateIdentityTarget } from './candidateIdentityContract.js';
import { individualApplicationOriginQuestion } from './applicationOrigin.js';
import { operationalDefaultAnswer, isOperationalDefaultValue } from '../assistedApplicationOperationalAnswers.js';
import { formatPhoneForField, phoneCountryOptionMatches } from './phoneNormalization.js';
import { nativeApprovedDocumentPurpose, nativeFilePurposeContract, NATIVE_DOCUMENT_TRANSPORT_VERSION } from './nativeFilePurpose.js';
import { nativePolicyAuthoritySource } from './nativePolicyAuthority.js';
export { nativeApprovedDocumentPurpose, nativeApprovedFilePurpose } from './nativeFilePurpose.js';

export const NATIVE_APPLICATION_POLICY_VERSION = 'native-application-policy-v3';
export const NATIVE_APPLICATION_MAX_FIELDS = 300;
export const NATIVE_APPLICATION_MAX_CLAIMS = 24;
export const NATIVE_APPLICATION_MAX_ATTACHMENTS = 82;

/** Shared transport recipe, not evidence or authority. Opaque values never enter the model payload. */
export function nativeApplicationDigestMaterial(proof) {
  if (!Array.isArray(proof?.fields) || typeof proof.successfulControlsDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(proof.successfulControlsDigest)) return null;
  return { fields: proof.fields, successfulControlsDigest: proof.successfulControlsDigest };
}

const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const comparable = value => normalized(value).toLowerCase();
const questionComparable = value => nativeQuestionText(value).toLowerCase();
const booleanAnswer = value => /^(?:yes|ja|si|sì|oui|true)$/iu.test(normalized(value)) ? true
  : /^(?:no|nein|non|false|falso)$/iu.test(normalized(value)) ? false : null;
const sameAnswer = (a, b) => booleanAnswer(a) !== null && booleanAnswer(a) === booleanAnswer(b) || comparable(a) === comparable(b);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sameContract = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export class PortalQualificationUnverified extends Error {
  constructor(reason = 'evidence_unverified') {
    super('portal_qualification_evidence_unverified');
    this.name = 'PortalQualificationUnverified';
    // The common flow retries this technical failure at most three times.
    this.code = 'evidence_entailment_unverified';
    // Only a bounded machine reason, never a question, answer or CV passage.
    this.reason = /^[a-z_]{1,60}$/.test(reason) ? reason : 'evidence_unverified';
  }
}


export function isQualificationAction(field, action) {
  if (!field || !action || field.inputType === 'password' || action.action === 'upload' || action.action === 'skip') return false;
  const answer = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.answer || action.value;
  if (answer == null || String(answer).trim() === '') return false;
  // All committed answers pass the gate unless a separate deterministic
  // identity/mandate/policy rule proves them. An unknown label is not a bypass.
  return true;
}

function attestedNativeAnswer(context, field, answer, allowLegacy = false) {
  const contract = rawNativeFormContract(field);
  if (!contract) return false;
  const matched = (context?.answerEvidence || []).filter(record => {
    if (!['candidate', 'owner'].includes(record?.provenance?.actor)) return false;
    const question = record.question || {};
    if (Object.hasOwn(question, 'originalNativeContract')) return sameContract(question.originalNativeContract, contract)
      && sameAnswer(record.answer, answer);
    if (!allowLegacy) return false;
    const names = [question.applicationQuestion, question.question].filter(Boolean).map(questionComparable);
    return names.includes(questionComparable(contract.question))
      && questionComparable(question.context) === questionComparable(contract.context)
      && questionComparable(question.section) === questionComparable(contract.section)
      && comparable(question.autocomplete) === comparable(contract.autocomplete)
      && sameContract(ownedAddressContract(question), ownedAddressContract(field))
      && JSON.stringify(consentContract(question)) === JSON.stringify(consentContract(field))
      && JSON.stringify((question.options || []).map(option => comparable(typeof option === 'string' ? option : option.label))) === JSON.stringify(contract.options.map(comparable))
      && comparable(question.type) === comparable(field.inputType || field.kind)
      && JSON.stringify(Object.entries(question.validation || {}).sort()) === JSON.stringify(Object.entries(contract.validation).sort())
      && sameAnswer(record.answer, answer);
  });
  return matched.length === 1;
}

export function exactAttestedAnswer(context, field, answer) {
  return attestedNativeAnswer(context, field, answer);
}

/** A conservative refusal veto; it never certifies a positive fact or consent. */
export function hasAttestedNativeRefusal(field, answerEvidence = []) {
  const native = rawNativeFormContract(field);
  if (!native) return false;
  return answerEvidence.some(record => {
    if (!['candidate', 'owner'].includes(record?.provenance?.actor)
      || !isConsentRefusal(record.answer)) return false;
    const question = record.question || {};
    if (Object.hasOwn(question, 'originalNativeContract')) return sameContract(question.originalNativeContract, native);
    if (![question.applicationQuestion, question.question].some(text => text && questionComparable(text) === questionComparable(native.question))
      || !['context', 'section', 'autocomplete'].every(key => questionComparable(question[key]) === questionComparable(native[key]))
      || !sameContract(ownedAddressContract(question), ownedAddressContract(field))) return false;
    if (field.kind === 'checkbox') return true;
    const options = question.applicationOptions || question.options || [];
    return JSON.stringify(options.map(option => comparable(typeof option === 'string' ? option : option.label)))
      === JSON.stringify(native.options.map(comparable));
  });
}

function validLocalReceipt(context, record) {
  return record?.version === 'native-answer-confirmation-v1'
    && /^confirmation-[a-f0-9]{64}$/.test(record.id || '') && /^[a-f0-9]{64}$/.test(record.contractHash || '')
    && record.category === 'local_answer' && record.scope === 'job'
    && ['candidate', 'owner'].includes(record.provenance?.actor)
    && record.provenance.orderId === context?.scope?.orderId
    && Number(record.provenance.round) === Number(context?.scope?.round)
    && record.question?.originalNativeContract;
}

export function localExactAnswer(context, field, answer) {
  const contract = rawNativeFormContract(field);
  return Boolean(contract && (context?.localAnswerEvidence || []).some(record => validLocalReceipt(context, record)
    && sameContract(record.question.originalNativeContract, contract)
    && (sameAnswer(record.answer, answer) || isConsentOnly(field) && isConsentRefusal(record.answer) && isConsentRefusal(answer))));
}

function localCounterCurrent(context, field, answer) {
  const contract = rawNativeFormContract(field);
  return /^[a-f0-9]{64}$/u.test(context?.localAnswerCounterHash || '') && Boolean(contract
    && (context?.localAnswerEvidence || []).some(record => validLocalReceipt(context, record)
      && record.sourceCounterChanged !== true
      && record.provenance.sourceCounterHash === context.localAnswerCounterHash
      && sameContract(record.question.originalNativeContract, contract) && sameAnswer(record.answer, answer)));
}
export function localConsentAnswer(context, field, answer) {
  return isConsentOnly(field) && localExactAnswer(context, field, answer);
}

export function approvedDocumentTransport(context, field, action) {
  if (context?.documentsCurrent !== true || !context.scope?.sourceCvHash || !['fill', 'type'].includes(action.action)) return false;
  const native = nativeFormContract(field);
  const role = native && nativeApprovedDocumentPurpose(native.question);
  if (!role || !nativeScopeAllows(field, text => Boolean(nativeApprovedDocumentPurpose(text)))) return false;
  const value = action.value;
  if (typeof value !== 'string' || !value || !validNativeValue(field, value)) return false;
  const texts = context.approvedDocumentTexts || {};
  return (role === 'whyCompany' ? [texts.whyCompany] : [texts.coverLetter, texts.motivation]).some(text => typeof text === 'string' && text === value);
}

export function hasStructuredConflict(context, field) {
  const counter = context?.unverifiedContext || {};
  return [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])].some(record => attestedNativeAnswer({ answerEvidence: [record] }, field, record.answer, true)
    && [record.id, record.key, record.question?.id, record.question?.question, record.question?.applicationQuestion]
      .filter(Boolean).some(key => [counter.values || {}, counter.corrections || counter.formOverrides || {}]
        .some(current => Object.hasOwn(current, key) && !sameAnswer(current[key], record.answer))));
}

export function attestedAnswerConflict(context, field, proposedAnswer) {
  const contract = rawNativeFormContract(field);
  if (!contract) return false;
  const optionAnswer = value => {
    const matching = (contract.optionValues || []).filter(option => comparable(option.label) === comparable(value)
      || option.value != null && String(option.value) === String(value));
    return matching.length === 1 ? matching[0].label : value;
  };
  return [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])].some(record =>
    attestedNativeAnswer({ answerEvidence: [record] }, field, record.answer, true)
    && !sameAnswer(optionAnswer(record.answer), optionAnswer(proposedAnswer))
    && !(isConsentOnly(field) && isConsentRefusal(record.answer) && isConsentRefusal(proposedAnswer)));
}

export function pendingAnswerOrigin(context, field, localOnly = false) {
  const records = localOnly ? context?.localAnswerEvidence || []
    : [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])];
  const ids = records.filter(record => attestedNativeAnswer({ answerEvidence: [record] }, field, record.answer, true)).map(record => record.id);
  return (context?.unverifiedContext?.answerSources || context?.unverifiedContext?.answerOrigins || []).some(origin => origin.changedSinceConfirmation === true
    && Array.isArray(origin.answerIds) && origin.answerIds.some(id => ids.includes(id)));
}

export function hasUnverifiedCounterContext(context, actualAnswer, field) {
  const counter = context?.unverifiedContext || {};
  const cvRevision = [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])].some(record => record.provenance?.cvHash && context?.scope?.sourceCvHash
    && record.provenance.cvHash !== context.scope.sourceCvHash
    && attestedNativeAnswer({ answerEvidence: [record] }, field, record.answer, true));
  const rawCounter = Boolean(normalized(counter.candidateNotes) || normalized(counter.flowNotes) || normalized(counter.intakeNotes)
    || (Array.isArray(counter.feedback) ? counter.feedback.length : normalized(counter.feedback))
    || Object.keys(counter.corrections || counter.formOverrides || {}).length
    || normalized(counter.historicalContext) && comparable(counter.historicalContext) !== comparable(actualAnswer));
  return Boolean(context?.scope?.answerSourceConflicts?.length || cvRevision || pendingAnswerOrigin(context, field)
    || rawCounter && !localCounterCurrent(context, field, actualAnswer));
}

export function fieldKey(field) { return String(field.frame || 0) + ':' + field.id; }
export function proposedNativeAnswer(field, action, value = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.value) {
  if (['select', 'radio', 'listbox', 'combobox'].includes(field.kind) && field.options?.length) {
    const options = field.options.filter(option => comparable(option.label) === comparable(value) || option.value != null && String(option.value) === String(value));
    if (options.length !== 1) throw new PortalQualificationUnverified('native_option_ambiguous');
    return options[0].label;
  }
  return value;
}

/** A single consuming atom has no competing repetition paths. Other native
 * regex syntax stays unknown; it must never execute on the server event loop.
 */
export function nativePatternSupported(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 200) return false;
  const source = pattern.replace(/^\^/, '').replace(/\$$/, '');
  return /^(?:\\[dDsSwW]|\[\^?(?:\\[dDsSwW-]|[A-Za-z0-9 ._@/+,:-])+\]|[A-Za-z0-9.])(?:[+*?]|\{\d{1,6}(?:,\d{0,6})?\})?$/u.test(source);
}

export function validNativeValue(field, value) {
  const constraints = field.validation || {};
  const text = String(value ?? '');
  const maximum = Object.hasOwn(constraints, 'maxlength') ? Number(constraints.maxlength) : Number(field.maxLength);
  if (Number.isFinite(maximum) && maximum >= 0 && (Object.hasOwn(constraints, 'maxlength') || maximum > 0) && text.length > maximum) return false;
  if (Number(constraints.minlength) > 0 && text.length < Number(constraints.minlength)) return false;
  if (constraints.pattern) {
    if (!nativePatternSupported(constraints.pattern)) return false;
    try { if (!new RegExp(`^(?:${constraints.pattern})$`, 'v').test(text)) return false; } catch { return false; }
  }
  if (field.inputType === 'number' || constraints.type === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) return false;
    const number = Number(text);
    if (constraints.min != null && number < Number(constraints.min) || constraints.max != null && number > Number(constraints.max)) return false;
    if (constraints.step && constraints.step !== 'any') {
      const step = Number(constraints.step);
      const position = (number - Number(constraints.min || 0)) / step;
      if (!(step > 0) || Math.abs(position - Math.round(position)) > 1e-8) return false;
    }
  }
  return true;
}

export function claimFor(field, action, proposedAnswer) {
  proposedAnswer = proposedNativeAnswer(field, action, proposedAnswer);
  const native = rawNativeFormContract(field);
  if (!native || proposedAnswer == null || String(proposedAnswer).trim() === '') return null;
  return { fieldId: fieldKey(field), nativeFormContract: native, proposedAnswer };
}

/** Only original identity scalars and positively owned applicant controls. */
export function mechanicallyGroundedNativeAction(candidate, field, action) {
  let value;
  try { value = proposedNativeAnswer(field, action, action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.value); }
  catch { return false; }
  const native = nativeFormContract(field);
  if (!native) return false;
  if (action.action === 'uncheck' && !pureApplicationConsent(field) && isConsentOnly(field)) return true;
  if (action.action === 'check' && pureApplicationConsent(field)) return true;
  if (isCandidateIdentityTarget(native)) {
    const role = candidateIdentityRole(native);
    const identity = candidate?.identity || {};
    if (role !== 'phoneCountry' && normalized(identity[role]) && comparable(identity[role]) === comparable(value)) return true;
    if (role === 'phone' && normalized(identity.phone) && [false, true].some(separateCountryCode =>
      comparable(value) === comparable(formatPhoneForField(identity.phone,
        { maxLength: Number(field.validation?.maxlength) || field.maxLength, separateCountryCode })))) return true;
    if (role === 'phoneCountry' && phoneCountryOptionMatches(value, identity.phone)) return true;
  }
  if (candidate && individualApplicationOriginQuestion(native.question)
    && nativeScopeAllows(field, individualApplicationOriginQuestion)) {
    const options = native.optionValues.filter(option => /^(?:nein|no|non)$/iu.test(normalized(option.label)));
    if (options.length === 1 && sameAnswer(options[0].label, value)) return true;
  }
  const preference = operationalDefaultAnswer(field);
  return Boolean(preference && isOperationalDefaultValue(field, value)
    && nativeScopeAllows(field, text => operationalDefaultAnswer({ ...field, label: text, question: text })?.topic === preference.topic));
}

/** Classifies a request for real server policy authority. This tag supplies no
 * authority itself and never applies to qualifications or document contents.
 */
function policyAuthorityPurpose(field, action) {
  const native = nativeFormContract(field);
  if (!native || isCandidateIdentityTarget(native)
    || !mechanicallyGroundedNativeAction({ identity: {} }, field, action)) return null;
  if (action.action === 'check' && pureApplicationConsent(field)) return { purpose: 'application_consent' };
  if (action.action === 'uncheck' && !pureApplicationConsent(field) && isConsentOnly(field)) return { purpose: 'optional_consent_refusal' };
  if (individualApplicationOriginQuestion(native.question) && nativeScopeAllows(field, individualApplicationOriginQuestion)) return { purpose: 'individual_application_origin' };
  const preference = operationalDefaultAnswer(field);
  return preference ? { purpose: 'operational_preference', preferenceTopic: preference.topic } : null;
}

/** Recomputed by the verifier; a client-supplied tag is never a policy grant. */
export function nativePolicyClaimAuthority(claim, { sourceAuthority } = {}) {
  const field = nativePolicyField(fieldFromNativeProof(claim, { sourceAuthority }), { sourceAuthority });
  if (!field || claim.nativeValueUnknown || !validNativeValue(field, claim.proposedAnswer)
    || ['select', 'radio', 'listbox', 'combobox'].includes(field.kind) && !field.options?.length) return null;
  const action = { action: field.kind === 'checkbox' ? booleanAnswer(claim.proposedAnswer) === true ? 'check' : 'uncheck' : 'fill', value: claim.proposedAnswer };
  if (field.kind === 'checkbox' && booleanAnswer(claim.proposedAnswer) === null) return null;
  try { proposedNativeAnswer(field, action, claim.proposedAnswer); }
  catch { return null; }
  const authority = policyAuthorityPurpose(field, action);
  return authority ? { version: NATIVE_APPLICATION_POLICY_VERSION, ...authority } : null;
}

/** All conflict checks precede every exemption; caller provenance is never authority. */
export function createNativeApplicationAnswerPolicy({ context, candidate } = {}) {
  const scoped = field => nativePolicyField(field, { sourceAuthority: context?.scope?.sourceAuthority });
  const answer = action => action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.answer ?? action.value;
  const refusalEvidence = [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])];
  const refusalConflict = (field, action) => hasAttestedNativeRefusal(field, refusalEvidence) && booleanAnswer(answer(action)) === true;
  const ownAnswer = (field, action) => !isConsentOnly(field)
    && (exactAttestedAnswer(context, field, answer(action)) || localExactAnswer(context, field, answer(action)));
  const counterContext = (field, action) => hasUnverifiedCounterContext(context, answer(action), field);
  const failure = (field, action, proposedAnswer = answer(action)) => {
    field = scoped(field);
    if (field?.nativeValueUnknown) return 'native_value_unverified';
    if (refusalConflict(field, action)) return 'native_attested_refusal';
    if (attestedAnswerConflict(context, field, proposedAnswer)) return 'native_attested_answer_conflict';
    if (hasStructuredConflict(context, field)) return 'counter_context_unresolved';
    const native = nativeFormContract(field);
    const identityRole = native && isCandidateIdentityTarget(native) && candidateIdentityRole(native);
    if (identityRole && [context?.unverifiedContext?.values || {}, context?.unverifiedContext?.corrections || context?.unverifiedContext?.formOverrides || {}]
      .some(values => [identityRole, field.id, native.question].some(key => Object.hasOwn(values, key) && !sameAnswer(values[key], proposedAnswer)))) return 'counter_context_unresolved';
    if (field.validation?.pattern && !nativePatternSupported(field.validation.pattern)) return 'native_pattern_unverified';
    if (!validNativeValue(field, proposedAnswer)) return 'native_value_invalid';
    if (!nativeFormContract(field) || consentContract(field) === null) return 'form_contract_unbound';
    if (['select', 'radio', 'listbox', 'combobox'].includes(field.kind) && !field.options?.length) return 'native_option_ambiguous';
    try { proposedNativeAnswer(field, action, proposedAnswer); }
    catch { return 'native_option_ambiguous'; }
    return '';
  };
  const exemption = (field, action) => {
    field = scoped(field);
    if (failure(field, action)) return '';
    if (mechanicallyGroundedNativeAction(candidate, field, action)) {
      if (isCandidateIdentityTarget(nativeFormContract(field))) return 'identity_mandate_preference';
      const purpose = policyAuthorityPurpose(field, action)?.purpose;
      const authority = nativePolicyAuthoritySource(context?.policyAuthority);
      const bound = authority && authority.policyBinding.orderId === context?.scope?.orderId
        && authority.policyBinding.round === context?.scope?.round && authority.policyRecord.scopes.includes(purpose);
      if (!counterContext(field, action) && bound) return 'identity_mandate_preference';
    }
    if (approvedDocumentTransport(context, field, action)) return 'approved_document_bytes';
    if (!counterContext(field, action) && localConsentAnswer(context, field, answer(action))) return 'local_consent';
    if (ownAnswer(field, action) && !counterContext(field, action)) return 'attested_answer';
    return '';
  };
  const needs = (field, action) => Boolean(field?.nativeValueUnknown) || isQualificationAction(field, action) && !exemption(scoped(field), action);
  const assertValue = (field, action, proposedAnswer = answer(action)) => {
    const reason = failure(field, action, proposedAnswer);
    if (reason) throw new PortalQualificationUnverified(reason);
  };
  const claim = (field, action, proposedAnswer = answer(action)) => {
    field = scoped(field);
    if (!needs(field, action)) return null;
    assertValue(field, action, proposedAnswer);
    const result = claimFor(field, action, proposedAnswer);
    const authority = result && !exactAttestedAnswer(context, field, result.proposedAnswer) && !localExactAnswer(context, field, result.proposedAnswer)
      && policyAuthorityPurpose(field, action);
    return result && authority ? { ...result, policyAuthorityNeeded: { version: NATIVE_APPLICATION_POLICY_VERSION, ...authority } } : result;
  };
  return { needs, claim, assertValue, exemption, refuses: field => hasAttestedNativeRefusal(field, refusalEvidence) };
}

/** Decode the complete wire contract through the same validator used by Node. */
export function fieldFromNativeProof(entry, { sourceAuthority } = {}) {
  return typeof entry?.fieldId === 'string' && entry.fieldId
    ? nativeFieldFromContract(entry.nativeFormContract, { id: entry.fieldId, sourceAuthority }) : null;
}

function verifiedDiplomaTransport({ proof, field, selected, purpose, context, verifiedDocumentTransports }) {
  if (!Array.isArray(verifiedDocumentTransports) || selected.some(file => !file.documentId || !file.fileId || !file.generation)) return null;
  const identity = file => JSON.stringify([file.documentId, file.fileId]);
  const fileSet = files => files.map(file => [file.documentId, file.fileId, file.generation, file.sha256, file.size])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (new Set(selected.map(identity)).size !== selected.length) return null;
  const matches = verifiedDocumentTransports.filter(result => {
    const witness = result?.attestation;
    return result?.status === 'verified' && witness?.version === NATIVE_DOCUMENT_TRANSPORT_VERSION
      && witness.category === 'file_transport' && witness.provenance?.actor === 'server'
      && witness.provenance.basis === 'current_server_document_assignment'
      && witness.scope?.orderId === context?.scope?.orderId && witness.scope?.round === context?.scope?.round
      && witness.target?.fieldId === field.id && witness.target?.frameUrl === proof.frameUrl
      && witness.target.multiple === (field.validation?.multiple === true)
      && sameContract(witness.purpose, purpose) && witness.requestedPurpose?.family === purpose.family
      && Object.entries(purpose.constraints).every(([key, value]) => witness.requestedPurpose.constraints?.[key] === value)
      && Array.isArray(witness.files) && witness.files.length === selected.length
      && witness.files.every(file => file && typeof file === 'object')
      && new Set(witness.files.map(identity)).size === witness.files.length
      && selected.every(manifest => witness.documentId === manifest.documentId)
      && sameContract(fileSet(selected), fileSet(witness.files))
      && /^document-transport-[a-f0-9]{64}$/u.test(witness.id || '')
      && /^[a-f0-9]{64}$/u.test(witness.requestContextHash || '') && /^[a-f0-9]{64}$/u.test(witness.nativeContractHash || '');
  });
  return matches.length === 1 ? matches[0].attestation : null;
}

function attachmentCoverage(proof, fields, context, docsManifest, verifiedDocumentTransports) {
  if (proof.attachments.some(attachment => !attachment || !fields.some(field => field.id === attachment.fieldId))) return { failure: 'native_attachment_ambiguous' };
  const coverage = [];
  for (const field of fields) {
    const attachments = proof.attachments.filter(item => item.fieldId === field.id);
    if (!attachments.length) {
      if (field.required) return { failure: 'native_attachment_missing' };
      coverage.push({ fieldId: field.id, kind: 'empty' });
      continue;
    }
    if (!Array.isArray(docsManifest)) return { failure: 'native_manifest_unverified' };
    if (attachments.length > 1 && field.validation?.multiple !== true) return { failure: 'native_attachment_ambiguous' };
    const filePurpose = nativeFilePurposeContract(nativeFormContract(field));
    const purpose = filePurpose?.family;
    if (!['cv', 'cover_letter', 'diploma'].includes(purpose)) return { failure: 'native_attachment_purpose_unverified' };
    const selected = []; const seen = new Set();
    for (const attachment of attachments) {
      if (Object.hasOwn(attachment, 'files') || typeof attachment.slot !== 'string' || !attachment.slot || attachment.slot.length > 512
        || !/^[a-f0-9]{64}$/u.test(attachment.sha256 || '') || !Number.isSafeInteger(attachment.size) || attachment.size <= 0) return { failure: 'native_attachment_unverified' };
      const matches = docsManifest.filter(item => item?.slot === attachment.slot && item.sha256 === attachment.sha256 && item.size === attachment.size);
      if (matches.length !== 1) return { failure: 'native_attachment_unverified' };
      const key = JSON.stringify([attachment.slot, attachment.sha256, attachment.size]);
      if (seen.has(key)) return { failure: 'native_attachment_ambiguous' };
      seen.add(key);
      selected.push({ slot: attachment.slot, sha256: attachment.sha256, size: attachment.size,
        ...(purpose === 'diploma' ? { documentId: matches[0].documentId, fileId: matches[0].fileId, generation: matches[0].generation } : {}) });
    }
    if (purpose === 'diploma') {
      if (selected.some(file => ['cv', 'cover_letter'].includes(file.slot))) return { failure: 'native_attachment_purpose_unverified' };
      const transport = verifiedDiplomaTransport({ proof, field, selected, purpose: filePurpose, context, verifiedDocumentTransports });
      if (!transport) return { failure: 'native_document_transport_unverified' };
      coverage.push({ fieldId: field.id, kind: 'mechanical', exemption: 'server_document_transport', transportId: transport.id,
        ...(selected.length === 1 ? selected[0] : { files: selected }) });
      continue;
    }
    if (context?.documentsCurrent !== true || !context.scope?.sourceCvHash) return { failure: 'native_documents_stale' };
    if (selected.some(file => file.slot !== purpose)) return { failure: 'native_attachment_purpose_unverified' };
    coverage.push({ fieldId: field.id, kind: 'mechanical', exemption: 'approved_file_bytes',
      ...(selected.length === 1 ? selected[0] : { files: selected }) });
  }
  return { coverage };
}

/** Derive claims from every submitted value, never from a client-selected subset. */
export function deriveNativeApplicationClaims({ proof, context, docsManifest, candidate, targetVerified = false, verifiedDocumentTransports = [] } = {}) {
  const fail = failure => ({ status: 'unverified', failure, claims: [], coverage: [] });
  // Only the server wrapper may provide this result after the canonical target
  // validator binds the physical form/control/destination to its expected job.
  if (targetVerified !== true) return fail('native_target_unverified');
  if (!proof || proof.version !== 'owner-native-proof-v1' || !Array.isArray(proof.fields)
    || !Array.isArray(proof.attachments) || !proof.fields.length || proof.fields.length > NATIVE_APPLICATION_MAX_FIELDS || proof.attachments.length > NATIVE_APPLICATION_MAX_ATTACHMENTS
    || !Number.isInteger(proof.round) || proof.round !== Number(context?.scope?.round)
    || typeof proof.frameUrl !== 'string' || !proof.frameUrl) return fail('native_proof_shape');
  try { const url = new URL(proof.frameUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('native_proof_shape'); }
  catch { return fail('native_proof_shape'); }
  if (Object.hasOwn(proof, 'claims')) return fail('native_client_claims');
  const ids = new Set(); const claims = []; const coverage = []; const fileFields = [];
  const policy = createNativeApplicationAnswerPolicy({ context, candidate: candidate || (context?.applicationIdentity ? { identity: context.applicationIdentity } : undefined) });
  for (const entry of proof.fields) {
    if (entry?.nativeValueUnknown) return fail('native_value_unverified');
    const field = nativePolicyField(fieldFromNativeProof(entry, { sourceAuthority: context?.scope?.sourceAuthority }), { sourceAuthority: context?.scope?.sourceAuthority });
    if (!field || ids.has(entry.fieldId)) return fail('form_contract_unbound');
    ids.add(entry.fieldId);
    if (field.inputType === 'password') return fail('credential_field_unverified');
    if (field.kind === 'file' || field.inputType === 'file') {
      if (entry.proposedAnswer != null && entry.proposedAnswer !== '') return fail('native_file_value_unverified');
      fileFields.push(field);
      continue;
    }
    if (entry.proposedAnswer === '' && ['text', 'textarea'].includes(field.kind) && field.required === false) {
      coverage.push({ fieldId: entry.fieldId, kind: 'empty' });
      continue;
    }
    if (!['string', 'boolean', 'number'].includes(typeof entry.proposedAnswer)
      || typeof entry.proposedAnswer === 'number' && !Number.isFinite(entry.proposedAnswer)
      || typeof entry.proposedAnswer === 'string' && !entry.proposedAnswer.trim()) return fail('native_value_unverified');
    const action = { fieldId: field.id, action: field.kind === 'checkbox' ? booleanAnswer(entry.proposedAnswer) === true ? 'check' : 'uncheck' : 'fill',
      value: entry.proposedAnswer };
    if (field.kind === 'checkbox' && booleanAnswer(entry.proposedAnswer) === null) return fail('native_value_unverified');
    try {
      policy.assertValue(field, action, entry.proposedAnswer);
      const claim = policy.claim(field, action, entry.proposedAnswer);
      if (claim) claims.push({ ...claim, fieldId: entry.fieldId });
      coverage.push({ fieldId: entry.fieldId, kind: claim ? 'claim' : 'mechanical', exemption: policy.exemption(field, action) });
    } catch (error) { return fail(error instanceof PortalQualificationUnverified ? error.reason : 'native_policy_unknown'); }
  }
  const files = attachmentCoverage(proof, fileFields, context, docsManifest, verifiedDocumentTransports);
  if (files.failure) return fail(files.failure);
  coverage.push(...files.coverage);
  if (claims.length > NATIVE_APPLICATION_MAX_CLAIMS) return fail('claim_budget');
  return { status: 'ready', claims, coverage };
}
