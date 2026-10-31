/** Source-bound answer policy shared by the native runner and server proof route.
 * Pure policy: no DOM, filesystem, network, provider or candidate-projection resolver.
 */
import { isConsentOnly, isConsentRefusal, pureApplicationConsent } from './applicationConsent.js';
import { nativeFormContract, ownedAddressContract, consentContract, nativeScopeAllows } from './nativeFormContract.js';
import { nativeQuestionText } from './nativeQuestionText.js';
import { candidateIdentityRole, isCandidateIdentityTarget } from './candidateIdentityContract.js';
import { individualApplicationOriginQuestion } from './applicationOrigin.js';
import { operationalDefaultAnswer, isOperationalDefaultValue } from '../assistedApplicationOperationalAnswers.js';
import { formatPhoneForField, phoneCountryCode, countryCodeOfLabel } from './phoneNormalization.js';

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

export function exactAttestedAnswer(context, field, answer) {
  const contract = nativeFormContract(field);
  if (!contract) return false;
  const matched = (context?.answerEvidence || []).filter(record => {
    if (!['candidate', 'owner'].includes(record?.provenance?.actor)) return false;
    const question = record.question || {};
    if (Object.hasOwn(question, 'originalNativeContract')) return sameContract(question.originalNativeContract, contract)
      && sameAnswer(record.answer, answer);
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

/** A conservative refusal veto; it never certifies a positive fact or consent. */
export function hasAttestedNativeRefusal(field, answerEvidence = []) {
  const native = nativeFormContract(field);
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
  const contract = nativeFormContract(field);
  return Boolean(contract && (context?.localAnswerEvidence || []).some(record => validLocalReceipt(context, record)
    && sameContract(record.question.originalNativeContract, contract)
    && (sameAnswer(record.answer, answer) || isConsentOnly(field) && isConsentRefusal(record.answer) && isConsentRefusal(answer))));
}
export function localConsentAnswer(context, field, answer) {
  return isConsentOnly(field) && localExactAnswer(context, field, answer);
}

/** Closed native purposes only; extra qualifications or instructions are not transport. */
export function nativeApprovedDocumentPurpose(value) {
  const text = nativeQuestionText(value).replace(/[＊*]+/gu, '').trim();
  if (/^(?:(?:please |bitte |carica |inserisci |veuillez )?(?:your |ihr(?:e|en)? |la (?:tua|vostra) |votre )?)?(?:cover(?:ing)? letter|letter of motivation|motivation(?:al)? letter|motivation|motivationsschreiben|bewerbungsschreiben|anschreiben|motivazione|lettera (?:di motivazione|motivazionale|di presentazione)|lettre (?:de motivation|de présentation))[:?!.]?$/iu.test(text)) return 'motivation';
  if (/^(?:why (?:do you (?:want to work|wish to work)|would you like to work) (?:for|at|with) (?:us|our company)|why (?:our company|this company)|warum (?:möchten|wollen) sie (?:bei uns|für uns|in unserem unternehmen) arbeiten|perché (?:vuoi|desideri|vorresti|vuole|desidera) lavorare (?:con noi|per noi|nella nostra azienda)|pourquoi (?:souhaitez-vous|voulez-vous) travailler (?:chez nous|pour notre entreprise))[:?!.]?$/iu.test(text)) return 'whyCompany';
  return '';
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
  return [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])].some(record => exactAttestedAnswer({ answerEvidence: [record] }, field, record.answer)
    && [record.id, record.key, record.question?.id, record.question?.question, record.question?.applicationQuestion]
      .filter(Boolean).some(key => [counter.values || {}, counter.corrections || counter.formOverrides || {}]
        .some(current => Object.hasOwn(current, key) && !sameAnswer(current[key], record.answer))));
}

export function attestedAnswerConflict(context, field, proposedAnswer) {
  const contract = nativeFormContract(field);
  if (!contract) return false;
  const optionAnswer = value => {
    const matching = (contract.optionValues || []).filter(option => comparable(option.label) === comparable(value)
      || option.value != null && String(option.value) === String(value));
    return matching.length === 1 ? matching[0].label : value;
  };
  return [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])].some(record =>
    exactAttestedAnswer({ answerEvidence: [record] }, field, record.answer)
    && !sameAnswer(optionAnswer(record.answer), optionAnswer(proposedAnswer))
    && !(isConsentOnly(field) && isConsentRefusal(record.answer) && isConsentRefusal(proposedAnswer)));
}

export function pendingAnswerOrigin(context, field, localOnly = false) {
  const records = localOnly ? context?.localAnswerEvidence || []
    : [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])];
  const ids = records.filter(record => exactAttestedAnswer({ answerEvidence: [record] }, field, record.answer)).map(record => record.id);
  return (context?.unverifiedContext?.answerSources || context?.unverifiedContext?.answerOrigins || []).some(origin => origin.changedSinceConfirmation === true
    && Array.isArray(origin.answerIds) && origin.answerIds.some(id => ids.includes(id)));
}

export function hasUnverifiedCounterContext(context, actualAnswer, field) {
  const counter = context?.unverifiedContext || {};
  const cvRevision = (context?.answerEvidence || []).some(record => record.provenance?.cvHash && context?.scope?.sourceCvHash
    && record.provenance.cvHash !== context.scope.sourceCvHash
    && exactAttestedAnswer({ answerEvidence: [record] }, field, record.answer));
  return Boolean(context?.scope?.answerSourceConflicts?.length || cvRevision || pendingAnswerOrigin(context, field) || normalized(counter.candidateNotes) || normalized(counter.flowNotes) || normalized(counter.intakeNotes)
    || (Array.isArray(counter.feedback) ? counter.feedback.length : normalized(counter.feedback))
    || Object.keys(counter.corrections || counter.formOverrides || {}).length
    || normalized(counter.historicalContext) && comparable(counter.historicalContext) !== comparable(actualAnswer));
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
  const native = nativeFormContract(field);
  if (!native || proposedAnswer == null || String(proposedAnswer).trim() === '') return null;
  return { fieldId: fieldKey(field), nativeFormContract: native, proposedAnswer };
}

/** Only original identity scalars and positively owned applicant controls. */
export function mechanicallyGroundedNativeAction(candidate, field, action) {
  const value = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.value;
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
    if (role === 'phoneCountry' && phoneCountryCode(identity.phone)
      && phoneCountryCode(identity.phone) === countryCodeOfLabel(value)) return true;
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

/** All conflict checks precede every exemption; caller provenance is never authority. */
export function createNativeApplicationAnswerPolicy({ context, candidate } = {}) {
  const answer = action => action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.answer ?? action.value;
  const refusalEvidence = [...(context?.answerEvidence || []), ...(context?.localAnswerEvidence || [])];
  const refusalConflict = (field, action) => hasAttestedNativeRefusal(field, refusalEvidence) && booleanAnswer(answer(action)) === true;
  const pendingLocalConsent = field => isConsentOnly(field) && pendingAnswerOrigin(context, field, true);
  const ownAnswer = (field, action) => !isConsentOnly(field)
    && (exactAttestedAnswer(context, field, answer(action)) || localExactAnswer(context, field, answer(action)));
  const counterContext = (field, action) => hasUnverifiedCounterContext(context, answer(action), field);
  const failure = (field, action, proposedAnswer = answer(action)) => {
    if (refusalConflict(field, action)) return 'native_attested_refusal';
    if (attestedAnswerConflict(context, field, proposedAnswer)) return 'native_attested_answer_conflict';
    if (pendingLocalConsent(field)) return 'native_consent_confirmation_unverified';
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
    if (failure(field, action)) return '';
    if (mechanicallyGroundedNativeAction(candidate, field, action)
      && (isCandidateIdentityTarget(nativeFormContract(field)) || !counterContext(field, action))) return 'identity_mandate_preference';
    if (approvedDocumentTransport(context, field, action)) return 'approved_document_bytes';
    if (!counterContext(field, action) && localConsentAnswer(context, field, answer(action))) return 'local_consent';
    if (ownAnswer(field, action) && !counterContext(field, action)) return 'attested_answer';
    return '';
  };
  const needs = (field, action) => isQualificationAction(field, action) && !exemption(field, action);
  const assertValue = (field, action, proposedAnswer = answer(action)) => {
    const reason = failure(field, action, proposedAnswer);
    if (reason) throw new PortalQualificationUnverified(reason);
  };
  const claim = (field, action, proposedAnswer = answer(action)) => {
    if (!needs(field, action)) return null;
    assertValue(field, action, proposedAnswer);
    return claimFor(field, action, proposedAnswer);
  };
  return { needs, claim, assertValue, exemption, refuses: field => hasAttestedNativeRefusal(field, refusalEvidence) };
}

/** Decode the complete wire contract through the same validator used by Node. */
export function fieldFromNativeProof(entry) {
  const native = entry?.nativeFormContract;
  if (!entry || typeof entry.fieldId !== 'string' || !entry.fieldId || !native || typeof native !== 'object'
    || !Array.isArray(native.ownedScopes)) return null;
  const validation = native.validation;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)
    || Object.entries(validation).some(([key, value]) => !['type', 'min', 'max', 'minlength', 'maxlength', 'pattern', 'step', 'required', 'aria-required', 'multiple'].includes(key)
      || !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))) return null;
  const field = { id: entry.fieldId, label: native.question, context: native.context, section: native.section,
    inputType: native.controlType, kind: native.kind, name: native.name, required: native.required,
    autocomplete: native.autocomplete, options: native.optionValues, validation: native.validation,
    nativeOwnedScopes: native.ownedScopes, nativeUncheckedSubmission: native.uncheckedSubmission,
    nativeMetadataComplete: true, ...Object.fromEntries(Object.entries(native).filter(([key]) => key.startsWith('ownConsent')
      || ['addressContext', 'consentOwnershipUnknown'].includes(key))) };
  return sameContract(nativeFormContract(field), native) ? field : null;
}

/** A file role describes transport only. It never proves a qualification. */
export function nativeApprovedFilePurpose(value) {
  const text = nativeQuestionText(value).replace(/[＊*]+/gu, '').trim();
  if (/^(?:(?:upload|attach|please upload|please attach|carica|allega|inserisci|hochladen|bitte hochladen|veuillez joindre|joindre|téléverser)\s+)?(?:(?:your|my|il tuo|la tua|vostro|vostra|ihr(?:en)?|votre)\s+)?(?:cv|résumé|resume|curriculum(?: vitae)?|lebenslauf)[:?!.]?$/iu.test(text)) return 'cv';
  return nativeApprovedDocumentPurpose(text) === 'motivation' ? 'cover_letter' : '';
}

function attachmentCoverage(proof, fields, context, docsManifest) {
  if (!proof.attachments.length && !fields.length) return { coverage: [] };
  const coverage = [];
  for (const field of fields) {
    if (proof.attachments.some(item => item?.fieldId === field.id)) continue;
    if (field.required) return { failure: 'native_attachment_missing' };
    coverage.push({ fieldId: field.id, kind: 'empty' });
  }
  if (!proof.attachments.length) return { coverage };
  if (context?.documentsCurrent !== true || !context.scope?.sourceCvHash) return { failure: 'native_documents_stale' };
  if (!Array.isArray(docsManifest)) return { failure: 'native_manifest_unverified' };
  const seen = new Set();
  for (const attachment of proof.attachments) {
    const owned = fields.filter(field => field.id === attachment?.fieldId);
    if (owned.length !== 1 || seen.has(attachment.fieldId)) return { failure: 'native_attachment_ambiguous' };
    seen.add(attachment.fieldId);
    const field = owned[0];
    const purpose = nativeApprovedFilePurpose(field.label);
    if (!purpose || !nativeScopeAllows(field, text => nativeApprovedFilePurpose(text) === purpose)) return { failure: 'native_attachment_purpose_unverified' };
    if (attachment.slot !== purpose || !/^[a-f0-9]{64}$/u.test(attachment.sha256 || '')
      || !Number.isSafeInteger(attachment.size) || attachment.size <= 0) return { failure: 'native_attachment_unverified' };
    const matches = docsManifest.filter(item => item?.slot === attachment.slot);
    if (matches.length !== 1 || matches[0].sha256 !== attachment.sha256 || matches[0].size !== attachment.size) return { failure: 'native_attachment_unverified' };
    coverage.push({ fieldId: attachment.fieldId, kind: 'mechanical', exemption: 'approved_file_bytes',
      slot: attachment.slot, sha256: attachment.sha256, size: attachment.size });
  }
  return { coverage };
}

/** Derive claims from every submitted value, never from a client-selected subset. */
export function deriveNativeApplicationClaims({ proof, context, docsManifest, candidate } = {}) {
  const fail = failure => ({ status: 'unverified', failure, claims: [], coverage: [] });
  if (!proof || proof.version !== 'owner-native-proof-v1' || !Array.isArray(proof.fields)
    || !Array.isArray(proof.attachments) || !proof.fields.length || proof.fields.length > 256 || proof.attachments.length > proof.fields.length
    || !Number.isInteger(proof.round) || proof.round !== Number(context?.scope?.round)
    || typeof proof.frameUrl !== 'string' || !proof.frameUrl) return fail('native_proof_shape');
  try { const url = new URL(proof.frameUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('native_proof_shape'); }
  catch { return fail('native_proof_shape'); }
  if (Object.hasOwn(proof, 'claims')) return fail('native_client_claims');
  const ids = new Set(); const claims = []; const coverage = []; const fileFields = [];
  const policy = createNativeApplicationAnswerPolicy({ context, candidate: candidate || (context?.applicationIdentity ? { identity: context.applicationIdentity } : undefined) });
  for (const entry of proof.fields) {
    const field = fieldFromNativeProof(entry);
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
  const files = attachmentCoverage(proof, fileFields, context, docsManifest);
  if (files.failure) return fail(files.failure);
  coverage.push(...files.coverage);
  if (claims.length > 12) return fail('claim_budget');
  return { status: 'ready', claims, coverage };
}
