import { createHash } from 'node:crypto';
import { UNKNOWN_ANSWER_VALUES, isUnknownAnswer } from './lib/unknownAnswer.js';
import { addressContextContract } from './lib/addressContextContract.js';
import { candidateAnswerFact, candidateFactAnswerForQuestion, candidateFactIdentity, candidateQuestionFact } from './lib/candidateAnswerFacts.js';
import { hasPortalQuestionEvidence, portalQuestionText, readablePortalQuestionText, unreadablePortalQuestion } from './lib/portalQuestionText.js';
import { provenOptionalOperationalPortalQuestion } from './lib/portalNativeContract.js';
import { isPreferredWorkloadQuestion, WORKLOAD_PREFERENCE_KEY } from './lib/workloadQuestion.js';
/**
 * What the candidate may change on the review page before approving (owner
 * decision 2026-09-30): the cover letter, the e-mail to the employer (only
 * when the application leaves by e-mail) and the form fields we propose. The
 * address stays the order's alias: the employer's replies must reach the flow
 * (forwarding, follow-ups, interview prep).
 *
 * Where each edit lives:
 * - the letter, the e-mail and the two motivation texts belong to the round's
 *   draft (a new round writes new ones);
 * - the candidate's own data (name, phone, place, permit, salary...) is kept
 *   in the flow as `formOverrides` and holds across rounds, like the answers.
 *
 * Everything that builds the application — the review page, the submission
 * (e-mail and portal), the handoff kit, the owner queue, the next draft —
 * reads the candidate through `candidateWithEdits`.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */

import {
  buildFormAnswers,
  candidateIdentity,
  clean,
  cleanBlock,
  letterText,
  parseLetterText,
  SALARY_RULE_MESSAGES,
  splitName,
} from './assistedApplicationAiDraftCore.js';
import { answerMessage, safePattern, validateAnswer } from './lib/answerRules.js';
import { minDateFor, zurichToday } from './lib/assistedApplicationQuestionConstraints.js';
import { isoDateOf } from './lib/cvPeriod.js';
import { asksHeldStatus, isPermitField, permitLabel, permitOptions, permitStatusOf } from './lib/permitStatus.js';
import { civilStatusCode, civilStatusOptions, cvPersonalFacts, isSalutation, personalFieldLabel, salutationFor, salutationGenderFromName, salutationOptions } from './lib/personalFacts.js';
import { hasCompleteLanguageList, hasExplicitLanguageSection, isLanguageAbilityQuestion, isLanguageNameOnly, languageCodesIn, languageExplicitlyAbsent } from './lib/languageFacts.js';
import { isIdentityEmailConfirmation } from './lib/identityEmail.js';
import { candidateAddressStatements, candidateAddressTopics, candidateStatementsOf, ownedAddressTwinFields, platformCandidateFacts, platformQuestionTopic, platformSalutationGender, withCandidateAddress } from './assistedApplicationPlatformDefaults.js';
import { isMatcherExperienceQuestion, verifiedCvAnswers } from './assistedApplicationCvAnswers.js';
import { verifiedDecisionAnswers } from './assistedApplicationDecisionAnswers.js';
import { operationalAnswerForOption } from './assistedApplicationOperationalAnswers.js';

export { isPreferredWorkloadQuestion } from './lib/workloadQuestion.js';

const LEGACY_LANGUAGE_LIST_LIMIT = 12;
const CANDIDATE_LOCALES = new Set(['it', 'en', 'de', 'fr']);
const QUESTION_OPTION_DESCRIPTOR_LIMIT = 40;
const LANGUAGE_LEVEL_RE = /\b(?:level|proficiency|fluency|fluent|niveau|livello|grado|kenntnis|kenntnisse|maitrise|maîtrise)\b/i;
const LANGUAGE_MODALITY_RE = /\b(?:written|schriftlich|ecrit|écrit|scritto|scritta)\b/i;
const LANGUAGE_ORAL_RE = /\b(?:oral|spoken|muendlich|mündlich|parlato|parlata|parle|parlé)\b/i;

function normalizeQuestionValue(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function candidateLocaleOf(value, order) {
  for (const candidate of [value, order?.locale]) {
    const locale = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (CANDIDATE_LOCALES.has(locale)) return locale;
  }
  return 'it';
}

// ATS tenants often add a generic fieldset label when a question is observed
// again (for example, `Candidate contact address`). It does not identify a
// different fact from the same question without a context. Keep substantive
// fieldset contexts in the answer key so a residence CAP and an employer CAP
// remain independent, while generic contact metadata cannot split one answer
// after the portal regenerates its question id.
const GENERIC_QUESTION_CONTEXT_RE = /^(?:(?:candidate|applicant)\s+)?(?:contact|personal|my|information|data|address)(?:\s+(?:contact|personal|address|details?|information|data|profile))?$/;

function questionContextKey(value) {
  const context = normalizeQuestionValue(value);
  return context && !GENERIC_QUESTION_CONTEXT_RE.test(context) ? context : '';
}

function questionHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function optionValues(question) {
  return (Array.isArray(question?.options) ? question.options : [])
    .flatMap((option) => typeof option === 'string' ? [option] : [option?.label, option?.value])
    .map(normalizeQuestionValue).filter(Boolean);
}

function currentOptionDescriptors(question) {
  return (Array.isArray(question?.options) ? question.options : []).flatMap(option => {
    const aliases = (typeof option === 'string' ? [option] : [option?.label, option?.value])
      .map(value => String(value ?? '').trim()).filter(Boolean);
    if (!aliases.length) return [];
    return [{ answer: String(typeof option === 'string' ? option : option?.label ?? option?.value).trim(), aliases }];
  });
}

// «I don't know»: shared with the platform facts (lib/unknownAnswer.js), which cannot import this module.
export { isUnknownAnswer };

function sortedOptionValues(question) {
  return [...new Set(optionValues(question))].sort();
}

function optionsIdentity(question) {
  const optionDescriptors = Array.isArray(question?.options) ? question.options : [];
  const suppliedFingerprint = String(question?.applicationOptionsFingerprint || '').trim();
  if (/^v1_[a-z0-9]{1,10}$/.test(suppliedFingerprint)) return suppliedFingerprint;
  const values = sortedOptionValues(question);
  // A full source list decides from its raw descriptor count, before unique
  // values are collapsed. Otherwise a duplicated early option plus a unique
  // 41st option would serialize to 40 rows with no stable identity.
  if (optionDescriptors.length > QUESTION_OPTION_DESCRIPTOR_LIMIT) return `v1_${questionHash(values.join('|'))}`;
  return values.length > QUESTION_OPTION_DESCRIPTOR_LIMIT
    ? `v1_${questionHash(values.join('|'))}`
    : values.join('|');
}

function answerConstraintOptionsIdentity(question) {
  const type = String(question?.type || '').trim().toLowerCase();
  const descriptors = currentOptionDescriptors(question);
  if (type === 'checkbox' && !descriptors.length) return 'binary:affirmative|negative';
  if (type === 'yes_no' && !descriptors.length) return 'binary:affirmative|negative';
  if (!['choice', 'radio', 'select', 'yes_no'].includes(type)) return optionsIdentity(questionForAnswerIdentity(question));
  const positiveAliases = new Set(['yes', 'si', 'ja', 'oui', 'true', '1']);
  const negativeAliases = new Set(['no', 'nein', 'non', 'false', '0']);
  const positive = descriptors.filter(option => option.aliases.some(alias => positiveAliases.has(normalizeQuestionValue(alias))));
  const negative = descriptors.filter(option => option.aliases.some(alias => negativeAliases.has(normalizeQuestionValue(alias))));
  if (descriptors.length === 2 && positive.length === 1 && negative.length === 1 && positive[0] !== negative[0]) {
    return 'binary:affirmative|negative';
  }
  return optionsIdentity(questionForAnswerIdentity(question));
}

function questionTextIdentity(question, text) {
  const normalized = normalizeQuestionValue(text);
  if (String(text || '').length > 240) return `v1_${questionHash(normalized)}`;
  const suppliedFingerprint = String(question?.questionIdentityFingerprint || '').trim();
  if (/^v1_[a-z0-9]{1,10}$/.test(suppliedFingerprint)) return suppliedFingerprint;
  return normalized;
}

/** Use the native portal prompt for identity while retaining candidate copy for display and answer validation. */
function questionForAnswerIdentity(question) {
  if (!hasPortalQuestionEvidence(question)) return question;
  const nativeQuestion = readablePortalQuestionText(question?.applicationQuestion)
    || readablePortalQuestionText(question?.portalQuestion);
  const nativeOptions = Array.isArray(question?.applicationOptions) ? question.applicationOptions : [];
  const hasNativeOptions = nativeOptions.length > 0 && optionValues({ ...question, options: nativeOptions }).length > 0;
  return {
    ...question,
    ...(nativeQuestion ? { question: nativeQuestion } : {}),
    ...(hasNativeOptions ? { options: nativeOptions } : {}),
  };
}

/** Compact identity for native option lists omitted from bounded runner events. */
export function candidateQuestionOptionsFingerprint(question) {
  const identityQuestion = questionForAnswerIdentity(question);
  const descriptors = Array.isArray(identityQuestion?.options) ? identityQuestion.options : [];
  const supplied = String(question?.applicationOptionsFingerprint || '').trim();
  if (/^v1_[a-z0-9]{1,10}$/.test(supplied)) return supplied;
  const values = sortedOptionValues(identityQuestion);
  return descriptors.length > QUESTION_OPTION_DESCRIPTOR_LIMIT
    ? `v1_${questionHash(values.join('|'))}`
    : '';
}

/** Compact identity for a native prompt omitted from bounded runner events. */
export function candidateQuestionTextFingerprint(question) {
  const identityQuestion = questionForAnswerIdentity(question);
  const text = String(identityQuestion?.question || '').trim();
  if (text.length > 240) return `v1_${questionHash(normalizeQuestionValue(text))}`;
  const supplied = String(question?.questionIdentityFingerprint || '').trim();
  return /^v1_[a-z0-9]{1,10}$/.test(supplied) ? supplied : '';
}

function hasQuestionAnswer(value) {
  const meaningful = item => {
    const text = String(item ?? '').trim();
    return Boolean(text) && !UNKNOWN_ANSWER_VALUES.has(normalizeQuestionValue(text));
  };
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.some(meaningful))
    || typeof value === 'string' && meaningful(value);
}

function answerValueKey(value) {
  return Array.isArray(value) ? value.map(normalizeQuestionValue).sort().join('|') : normalizeQuestionValue(value);
}

const CANDIDATE_ANSWER_HISTORY_LIMIT = 120;
const CANDIDATE_ANSWER_HISTORY_VALUE_LIMIT = 500;
const CATALOG_ANSWER_QUESTION_TYPES = new Set(['choice', 'select', 'radio', 'dropdown', 'combobox', 'multi_choice']);
const DRIVING_LICENCE_QUESTION_RE = /\b(?:driv(?:e|ing|er(?:['’]s)?)|license to drive|licence to drive|f[uü]hrerschein|fahrausweis|f[uü]hrerausweis|permis de conduire|patent[ae] di guida|patente(?: di guida)?)\b/i;
const HISTORY_COMPATIBLE_QUESTION_TYPES = new Set([
  'checkbox|yes_no', 'choice|radio', 'choice|select', 'choice|text', 'choice|yes_no', 'number|text',
  'radio|select', 'radio|text', 'select|text', 'text|textarea',
]);

function answerFitsQuestion(value, question, nowMs = Date.now()) {
  if (candidateQuestionFact(question) && (!candidateAnswerFact(question, value) || !validateAnswer(value, question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) }).ok)) return false;
  if (isPreferredWorkloadQuestion(question?.question)) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,3}(?:[.,]\d{1,2})?\s*%?$/.test(text)) return false;
    const percentage = Number(text.replace('%', '').trim().replace(',', '.'));
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return false;
    const validation = validateAnswer(question?.type === 'number' ? String(percentage) : text, question);
    if (!validation.ok) return false;
  }
  const options = optionValues(question);
  if (!options.length) return true;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map(normalizeQuestionValue).filter(Boolean);
  return normalized.length > 0 && normalized.every((answer) => options.includes(answer));
}

function binaryOptionAnswer(value, question) {
  if (String(question?.type || '').trim().toLowerCase() !== 'yes_no') return undefined;
  const normalized = normalizeQuestionValue(value);
  const positiveValues = new Set(['true', 'yes', 'si', 'ja', 'oui', '1']);
  const negativeValues = new Set(['false', 'no', 'nein', 'non', '0']);
  const polarity = positiveValues.has(normalized) ? 'positive' : negativeValues.has(normalized) ? 'negative' : '';
  if (!polarity) return undefined;
  const descriptors = currentOptionDescriptors(question);
  const positiveAliases = new Set(['yes', 'si', 'ja', 'oui', 'true', '1']);
  const negativeAliases = new Set(['no', 'nein', 'non', 'false', '0']);
  const positive = descriptors.filter(option => option.aliases.some(alias => positiveAliases.has(normalizeQuestionValue(alias))));
  const negative = descriptors.filter(option => option.aliases.some(alias => negativeAliases.has(normalizeQuestionValue(alias))));
  if (positive.length !== 1 || negative.length !== 1 || positive[0] === negative[0]) return undefined;
  return polarity === 'positive' ? positive[0].answer : negative[0].answer;
}

function permitOptionAnswer(value, question) {
  const wording = [question?.applicationQuestion, question?.portalQuestion, question?.question, question?.label]
    .filter(Boolean).join(' ');
  if (DRIVING_LICENCE_QUESTION_RE.test(wording) || !isPermitField(wording) || !asksHeldStatus(wording)) return undefined;
  const status = permitStatusOf(value);
  if (!status) return undefined;
  const matches = currentOptionDescriptors(question).filter(option => permitStatusOf(option.answer) === status);
  return matches.length === 1 ? matches[0].answer : undefined;
}

function answerForCurrentQuestion(value, question, nowMs = Date.now()) {
  const operationalMapped = operationalAnswerForOption(question, value);
  const candidateFactAnswer = candidateQuestionFact(question) ? candidateFactAnswerForQuestion(question, operationalMapped ?? value) : null;
  const permitMapped = permitOptionAnswer(candidateFactAnswer ?? operationalMapped ?? value, question);
  const binaryMapped = binaryOptionAnswer(permitMapped ?? candidateFactAnswer ?? operationalMapped ?? value, question);
  const currentValue = binaryMapped ?? permitMapped ?? candidateFactAnswer ?? operationalMapped ?? value;
  if (!answerFitsQuestion(currentValue, question, nowMs)) return undefined;
  const options = currentOptionDescriptors(question);
  const values = Array.isArray(currentValue) ? currentValue : [currentValue];
  const type = String(question?.type || '').trim().toLowerCase();
  if (CATALOG_ANSWER_QUESTION_TYPES.has(type) && !options.length) return undefined;
  if (['yes_no', 'checkbox'].includes(type) && !options.length) {
    const binaryValues = new Set(['yes', 'no', 'si', 'ja', 'nein', 'oui', 'non', 'true', 'false', '1', '0']);
    if (!values.every(answer => binaryValues.has(normalizeQuestionValue(answer)))) return undefined;
  }
  const mappedValues = values.map(answer => {
    if (!options.length) return answer;
    const normalized = normalizeQuestionValue(answer);
    const matches = options.filter(option => option.aliases.some(alias => normalizeQuestionValue(alias) === normalized));
    return matches.length === 1 ? matches[0].answer : undefined;
  });
  if (mappedValues.some(answer => answer === undefined)) return undefined;
  const todayIso = zurichToday(nowMs);
  const identityQuestion = questionForAnswerIdentity(question);
  const currentMinDate = minDateFor({ ...question, question: identityQuestion?.question || question?.question }, nowMs);
  const minDates = [
    currentMinDate,
    question?.minDate === 'today' || question?.validation?.minDate === 'today' ? todayIso : '',
    /^\d{4}-\d{2}-\d{2}$/.test(String(question?.minDate || '')) ? String(question.minDate) : '',
  ].filter(Boolean);
  const validationQuestion = {
    ...question,
    ...(minDates.length ? { minDate: minDates.sort().at(-1) } : {}),
    ...(question?.type === 'choice' && options.length ? { options: options.map(option => option.answer) } : {}),
  };
  const validatedValues = type === 'number' && isPreferredWorkloadQuestion(question?.question)
    ? mappedValues.map(answer => String(Number(String(answer).replace('%', '').trim().replace(',', '.'))))
    : mappedValues;
  if (!validatedValues.every(answer => validateAnswer(String(answer ?? ''), validationQuestion, { todayIso }).ok)) return undefined;
  return Array.isArray(currentValue) ? validatedValues : validatedValues[0];
}

/** Strict execution check; direct same-id answers remain visible to review, but may not satisfy a live field. */
export function validatedCandidateAnswerForQuestion(value, question, nowMs = Date.now()) {
  return answerForCurrentQuestion(value, question, nowMs);
}

function isLegacyPermitAnswer(question, value) {
  if (typeof value !== 'string' || value.length > CANDIDATE_ANSWER_HISTORY_VALUE_LIMIT) return false;
  const wording = [question?.applicationQuestion, question?.portalQuestion, question?.question, question?.label]
    .filter(Boolean).join(' ');
  const words = normalizeQuestionValue(value).split(' ').filter(Boolean);
  return words.length >= 3 && isPermitField(wording) && asksHeldStatus(wording)
    && !DRIVING_LICENCE_QUESTION_RE.test(wording) && !permitStatusOf(value);
}

function isDirectAnswerInvalidForCurrentContract(question, value, nowMs) {
  if (String(question?.type || '').trim().toLowerCase() === 'date'
    && answerForCurrentQuestion(value, question, nowMs) === undefined) return true;
  const type = String(question?.type || '').trim().toLowerCase();
  if (CATALOG_ANSWER_QUESTION_TYPES.has(type) && optionValues(question).length > 0
    && answerForCurrentQuestion(value, question, nowMs) === undefined) return true;
  const wording = [question?.applicationQuestion, question?.portalQuestion, question?.question, question?.label]
    .filter(Boolean).join(' ');
  return DRIVING_LICENCE_QUESTION_RE.test(wording) && Boolean(permitStatusOf(value));
}

function isPermitStatusQuestion(question) {
  const wording = [question?.applicationQuestion, question?.portalQuestion, question?.question, question?.label]
    .filter(Boolean).join(' ');
  return !DRIVING_LICENCE_QUESTION_RE.test(wording) && isPermitField(wording) && asksHeldStatus(wording);
}

// An answer already saved under this question id is still the candidate's own
// response when a catalogue has not arrived yet. It is kept for the runner to
// compare with the live control; it is never projected to a different id.
function directAnswerForCurrentQuestion(value, question, nowMs = Date.now()) {
  const type = String(question?.type || '').trim().toLowerCase();
  if (CATALOG_ANSWER_QUESTION_TYPES.has(type) && optionValues(question).length === 0 && hasQuestionAnswer(value)) return value;
  if (isPermitStatusQuestion(question) && typeof value === 'string' && value.trim()) {
    return answerForCurrentQuestion(value, question, nowMs) ?? value;
  }
  return answerForCurrentQuestion(value, question, nowMs);
}

function stableConstraintCanonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') return 'null';
  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map(item => stableConstraintCanonicalJson(item, ancestors)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableConstraintCanonicalJson(value[key], ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

function stableConstraintDigest(value) {
  return createHash('sha256').update(stableConstraintCanonicalJson(value)).digest('hex');
}

function stableConstraintOverflow(type, prefix, overflow) {
  return {
    $candidateAnswerConstraintOverflow: type,
    prefix,
    overflowCount: overflow.length,
    overflowDigest: stableConstraintDigest(overflow),
  };
}

function stableConstraintValue(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth > 4) {
    return { $candidateAnswerConstraintOverflow: 'depth', digest: stableConstraintDigest(value) };
  }
  if (Array.isArray(value)) {
    const prefix = value.slice(0, 40).map(item => stableConstraintValue(item, depth + 1));
    if (value.length <= 40) return prefix;
    return stableConstraintOverflow('array', prefix, value.slice(40));
  }
  if (typeof value !== 'object') return null;
  const keys = Object.keys(value).sort();
  const prefixKeys = keys.slice(0, 40);
  const prefix = Object.fromEntries(prefixKeys.map(key => [key, stableConstraintValue(value[key], depth + 1)]));
  if (keys.length <= 40) return prefix;
  const overflowKeys = keys.slice(40);
  const overflow = overflowKeys.map(key => [key, value[key]]);
  return stableConstraintOverflow('object', prefix, overflow);
}

function candidateAnswerContractValues(question) {
  return {
    why: normalizeQuestionValue(question?.why || '').slice(0, 500),
    validation: stableConstraintValue(question?.validation || {}),
    minDate: String(question?.minDate || '').slice(0, 80),
    maxDate: String(question?.maxDate || '').slice(0, 80),
    min: stableConstraintValue(question?.min),
    max: stableConstraintValue(question?.max),
    minLength: stableConstraintValue(question?.minLength),
    maxLength: stableConstraintValue(question?.maxLength),
    pattern: String(question?.pattern || '').slice(0, 240),
    required: question?.required === true,
    affirmativeConsent: question?.requiresAffirmativeConsent === true,
  };
}

function candidateAnswerCompatibilityKey(question) {
  return createHash('sha256').update(JSON.stringify(candidateAnswerContractValues(question))).digest('hex');
}

function candidateAnswerConstraintsKey(question) {
  const permitStatus = isPermitStatusQuestion(question);
  const constraints = {
    ...candidateAnswerContractValues(question),
    // The permit review deliberately keeps an owner's literal status even if
    // the native catalogue changes. Other catalogues are answer constraints.
    options: permitStatus ? '' : answerConstraintOptionsIdentity(question),
  };
  return createHash('sha256').update(JSON.stringify(constraints)).digest('hex');
}

function candidateAnswerHistoryIdentity(question) {
  const identityQuestion = questionForAnswerIdentity(question);
  const rawText = String(identityQuestion?.question || '').trim();
  const semanticKey = normalizeQuestionValue(question?.semanticKey || question?.portalKey || '').slice(0, 160);
  return {
    semanticKey,
    questionText: rawText ? questionTextIdentity(identityQuestion, rawText).slice(0, 520) : '',
    context: questionContextKey(identityQuestion?.context).slice(0, 240),
    section: normalizeQuestionValue(identityQuestion?.section).slice(0, 240),
    autocomplete: normalizeQuestionValue(identityQuestion?.autocomplete).slice(0, 240),
    candidateKey: candidateQuestionAnswerKey(question).slice(0, 180),
    questionType: String(question?.type || '').trim().toLowerCase().slice(0, 40),
    answerContractKey: candidateAnswerCompatibilityKey(question),
    constraintsKey: candidateAnswerConstraintsKey(question),
  };
}

function candidateAnswerHistoryValue(value) {
  if (typeof value === 'string') return value.length <= CANDIDATE_ANSWER_HISTORY_VALUE_LIMIT ? value : null;
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value) || value.length > 40) return null;
  const items = value.map(item => typeof item === 'string' && item.length <= 500
    ? item : typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) ? item : null);
  return items.every(item => item !== null) && items.reduce((total, item) => total + String(item).length, 0) <= 1000 ? items : null;
}

/** A bounded, order-local ledger of values the candidate explicitly saved on a reviewed question. */
export function candidateAnswerHistoryState(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-CANDIDATE_ANSWER_HISTORY_LIMIT).flatMap(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.source !== 'candidate') return [];
    const id = String(record.id || '').trim().slice(0, 160);
    const round = Number(record.round);
    const confirmedAt = Number(record.confirmedAt);
    const status = ['answered', 'cleared', 'unknown'].includes(record.status) ? record.status : '';
    const answer = candidateAnswerHistoryValue(record.answer);
    if (!id || !Number.isInteger(round) || round < 1 || !Number.isFinite(confirmedAt) || confirmedAt <= 0
      || !status || answer === null) return [];
    return [{
      id,
      semanticKey: String(record.semanticKey || '').slice(0, 160),
      questionText: String(record.questionText || '').slice(0, 520),
      context: String(record.context || '').slice(0, 240),
      section: String(record.section || '').slice(0, 240),
      autocomplete: String(record.autocomplete || '').slice(0, 240),
      candidateKey: String(record.candidateKey || '').slice(0, 180),
      questionType: String(record.questionType || '').slice(0, 40),
      answerContractKey: String(record.answerContractKey || '').slice(0, 64),
      constraintsKey: String(record.constraintsKey || '').slice(0, 64),
      answer,
      status,
      round,
      confirmedAt,
      source: 'candidate',
    }];
  });
}

/** Merge concurrent writes without dropping a distinct answer or an explicit clear. */
export function mergeCandidateAnswerHistory(previous = [], next = []) {
  const merged = new Map();
  for (const record of [...candidateAnswerHistoryState(previous), ...candidateAnswerHistoryState(next)]) {
    const identity = JSON.stringify([record.id, record.round, record.semanticKey, record.questionText, record.context,
      record.section, record.autocomplete, record.candidateKey, record.questionType, record.answerContractKey,
      record.constraintsKey, record.status, answerValueKey(record.answer)]);
    const current = merged.get(identity);
    if (!current || record.confirmedAt >= current.confirmedAt) merged.set(identity, record);
  }
  return [...merged.values()].sort((left, right) => left.confirmedAt - right.confirmedAt).slice(-CANDIDATE_ANSWER_HISTORY_LIMIT);
}

/** Capture candidate-confirmed answers without placing their values in audit events or shared profiles. */
export function rememberCandidateAnswerHistory({ previous = [], questions = [], changed = {}, round, confirmedAt, actor = 'candidate' } = {}) {
  const history = candidateAnswerHistoryState(previous);
  if (actor !== 'candidate' || !Number.isInteger(Number(round)) || Number(round) < 1
    || !Number.isFinite(Number(confirmedAt)) || Number(confirmedAt) <= 0
    || !changed || typeof changed !== 'object' || Array.isArray(changed)) return history;
  const byId = new Map((Array.isArray(questions) ? questions : []).map(question => [String(question?.id || ''), question]));
  for (const [id, rawAnswer] of Object.entries(changed)) {
    const question = byId.get(id);
    if (!question || !id || id.length > 160) continue;
    const answer = candidateAnswerHistoryValue(rawAnswer);
    if (answer === null) continue;
    const identity = candidateAnswerHistoryIdentity(question);
    if (!identity.semanticKey && !identity.questionText && !identity.candidateKey) continue;
    const status = isUnknownAnswer(answer) ? 'unknown' : hasQuestionAnswer(answer) ? 'answered' : 'cleared';
    const sameEntry = history.findIndex(record => record.id === id && record.round === Number(round)
      && record.semanticKey === identity.semanticKey && record.questionText === identity.questionText
      && record.context === identity.context && record.section === identity.section && record.autocomplete === identity.autocomplete
      && record.candidateKey === identity.candidateKey && record.questionType === identity.questionType
      && record.answerContractKey === identity.answerContractKey
      && record.constraintsKey === identity.constraintsKey && record.status === status
      && answerValueKey(record.answer) === answerValueKey(answer));
    const latestForId = history.filter(record => record.id === id).reduce((latest, record) => Math.max(latest, record.confirmedAt), 0);
    const sameCandidateEntry = record => record.round === Number(round)
      && record.semanticKey === identity.semanticKey && record.questionText === identity.questionText
      && record.context === identity.context && record.section === identity.section && record.autocomplete === identity.autocomplete
      && record.candidateKey === identity.candidateKey && record.questionType === identity.questionType
      && record.answerContractKey === identity.answerContractKey
      && record.constraintsKey === identity.constraintsKey && record.status === status
      && answerValueKey(record.answer) === answerValueKey(answer);
    const latestHasConflict = history.some(record => record.id === id && record.confirmedAt === latestForId && !sameCandidateEntry(record));
    const sameEntryIsLatest = sameEntry >= 0 && history[sameEntry].confirmedAt === latestForId && !latestHasConflict;
    const recordedAt = latestForId >= Number(confirmedAt)
      ? latestForId + (sameEntryIsLatest ? 0 : 1) : Number(confirmedAt);
    const next = { id, ...identity, answer, status, round: Number(round), confirmedAt: recordedAt, source: 'candidate' };
    if (sameEntry >= 0) history[sameEntry] = next;
    else history.push(next);
  }
  return mergeCandidateAnswerHistory([], history);
}

function compatibleAnswerQuestionTypes(previous, current) {
  const oldType = String(previous || '').trim().toLowerCase();
  const newType = String(current || '').trim().toLowerCase();
  if (!oldType || !newType) return false;
  return oldType === newType || HISTORY_COMPATIBLE_QUESTION_TYPES.has([oldType, newType].sort().join('|'));
}

function isLegacySameIdCandidateAnswerHistory(record, question) {
  const id = String(question?.id || '').trim();
  return Boolean(id && record?.id === id && !record.answerContractKey && !record.constraintsKey);
}

function candidateAnswerHistoryQuestionType(record, question) {
  if (record?.questionType) return record.questionType;
  return isLegacySameIdCandidateAnswerHistory(record, question)
    ? candidateAnswerHistoryIdentity(question).questionType
    : '';
}

function candidateAnswerQuestionTopicMatches(record, question) {
  // Before contract hashes existed, the stable question id is the only
  // available link to the current question. Cross-id matches still require
  // the persisted topic identity below.
  if (isLegacySameIdCandidateAnswerHistory(record, question)) return true;
  const current = candidateAnswerHistoryIdentity(question);
  const contextsCompatible = ['context', 'section', 'autocomplete'].every(field =>
    !record[field] || !current[field] || record[field] === current[field]);
  const languageContractsConflict = /^language_[a-z0-9]+_(?:any|written|oral)_(?:threshold_[abc][12]|proficiency|ability)$/.test(record.candidateKey || '')
    && /^language_[a-z0-9]+_(?:any|written|oral)_(?:threshold_[abc][12]|proficiency|ability)$/.test(current.candidateKey || '')
    && record.candidateKey !== current.candidateKey;
  const semanticMatch = Boolean(record.semanticKey && current.semanticKey && record.semanticKey === current.semanticKey);
  const textMatch = Boolean(record.questionText && current.questionText && record.questionText === current.questionText && contextsCompatible);
  const candidateKeyMatch = Boolean(record.candidateKey && current.candidateKey && record.candidateKey === current.candidateKey && contextsCompatible);
  return contextsCompatible && !languageContractsConflict && (semanticMatch || textMatch || candidateKeyMatch);
}

function compatibleAnswerQuestionIdentity(record, question) {
  const current = candidateAnswerHistoryIdentity(question);
  const constraintsKey = isLegacySameIdCandidateAnswerHistory(record, question)
    ? current.constraintsKey
    : record.constraintsKey;
  return Boolean(constraintsKey && current.constraintsKey && constraintsKey === current.constraintsKey
    && candidateAnswerQuestionTopicMatches(record, question));
}

function compatibleAnswerQuestionContract(record, question) {
  const current = candidateAnswerHistoryIdentity(question);
  const answerContractKey = isLegacySameIdCandidateAnswerHistory(record, question)
    ? current.answerContractKey
    : record.answerContractKey;
  return Boolean(answerContractKey && current.answerContractKey
    && answerContractKey === current.answerContractKey
    && candidateAnswerQuestionTopicMatches(record, question));
}

function candidateAnswerHistoryStateForQuestion(question, history) {
  const id = String(question?.id || '').trim();
  const matches = candidateAnswerHistoryState(history).filter(record => record.id === id
    || candidateAnswerQuestionTopicMatches(record, question));
  if (!matches.length) return { present: false, record: null, ambiguous: false };
  const latestAt = Math.max(...matches.map(record => record.confirmedAt));
  const latest = matches.filter(record => record.confirmedAt === latestAt);
  const values = new Set(latest.map(record => JSON.stringify([record.status, answerValueKey(record.answer), record.semanticKey,
    record.questionText, record.context, record.section, record.autocomplete, record.candidateKey, record.questionType,
    record.answerContractKey, record.constraintsKey])));
  return { present: true, record: values.size === 1 ? latest.at(-1) : null, ambiguous: values.size !== 1 };
}

export function candidateAnswerHistoryRecordForQuestionId(question, history) {
  const id = String(question?.id || '').trim();
  const matches = candidateAnswerHistoryState(history).filter(record => record.id === id);
  if (!matches.length) return undefined;
  const latestAt = Math.max(...matches.map(record => record.confirmedAt));
  const latest = matches.filter(record => record.confirmedAt === latestAt);
  const values = new Set(latest.map(record => JSON.stringify([record.status, answerValueKey(record.answer), record.semanticKey,
    record.questionText, record.context, record.section, record.autocomplete, record.candidateKey, record.questionType,
    record.answerContractKey, record.constraintsKey])));
  if (values.size !== 1) return null;
  return latest.at(-1);
}

function candidateAnswerHistoryStateForQuestionId(question, history) {
  const record = candidateAnswerHistoryRecordForQuestionId(question, history);
  return { present: record !== undefined, record, ambiguous: record === null };
}

function candidateHistoryAnswerForQuestion(question, history, nowMs) {
  const matches = candidateAnswerHistoryState(history).filter(record => candidateAnswerQuestionTopicMatches(record, question));
  if (!matches.length) return undefined;
  const latestAt = Math.max(...matches.map(record => record.confirmedAt));
  const latest = matches.filter(record => record.confirmedAt === latestAt);
  const values = new Set(latest.map(record => `${record.status}:${answerValueKey(record.answer)}`));
  if (values.size !== 1) return undefined;
  const record = latest.at(-1);
  const currentAnswer = record.id === String(question?.id || '')
    ? directAnswerForCurrentQuestion(record.answer, question, nowMs)
    : answerForCurrentQuestion(record.answer, question, nowMs);
  if (record.status !== 'answered' || !hasQuestionAnswer(record.answer)
    || !compatibleAnswerQuestionIdentity(record, question)
    || !compatibleAnswerQuestionTypes(candidateAnswerHistoryQuestionType(record, question), question?.type)
    || currentAnswer === undefined) return undefined;
  return currentAnswer;
}

/** Only this writer version marks the per-order semantic map as candidate/owner confirmed. */
export const ORDER_QUESTION_ANSWER_EVIDENCE_VERSION = 'order-confirmed-question-answers-v3';

/** Complete general questions only: additional domain, future or employer clauses retain their own key. */
export function isGeneralCandidateLanguageQuestion(value) {
  const text = normalizeQuestionValue(value).split(' ').map(word => languageCodesIn(word).length === 1 && isLanguageNameOnly(word) ? 'language_target' : word).join(' ');
  return /^(?:what is your (?:current )?(?:(?:written|spoken|oral) )?language_target (?:proficiency(?: level)?|fluency level|level)|what is your (?:current )?level of language_target|do you speak language_target(?: if so how would you describe your proficiency level)?|qual e il tuo (?:attuale )?livello di language_target|parli language_target|wie ist (?:ihr|dein) (?:aktuelles )?niveau in language_target|sprechen sie language_target|quel est votre niveau (?:actuel )?(?:en|de) language_target|parlez vous language_target)$/.test(text);
}

/** Stable fact key for an answer, independent of a model or ATS field id. */
export function candidateQuestionAnswerKey(question) {
  const identityQuestion = questionForAnswerIdentity(question);
  const text = String(identityQuestion?.question ?? '').trim();
  if (!text) return '';
  const suppliedTextFingerprint = String(identityQuestion?.questionIdentityFingerprint || '').trim();
  const hasBoundedTextIdentity = text.length > 240
    || /^v1_[a-z0-9]{1,10}$/.test(suppliedTextFingerprint);
  const fact = hasBoundedTextIdentity ? null : candidateQuestionFact(identityQuestion);
  if (fact) return `fact_${questionHash(candidateFactIdentity(fact))}`;
  const context = questionContextKey(identityQuestion?.context);
  const section = normalizeQuestionValue(identityQuestion?.section);
  const autocomplete = normalizeQuestionValue(identityQuestion?.autocomplete);
  const ownership = addressContextContract(identityQuestion);
  if (ownership === null || ownership?.unknown) return '';
  const ownershipKey = ownership === undefined ? '' : JSON.stringify(ownership);
  const languageCodes = hasBoundedTextIdentity ? [] : languageCodesIn(text);
  if (!hasBoundedTextIdentity && !context && !section && !autocomplete && !ownershipKey && languageCodes.length === 1 && isLanguageAbilityQuestion(text) && isGeneralCandidateLanguageQuestion(text)) {
    const normalized = normalizeQuestionValue(text);
    const normalizedContract = normalizeQuestionValue([text, identityQuestion?.why].filter(Boolean).join(' '));
    const threshold = /\b(?:at least|minimum|min(?:imum)? level|required level|mindestens|au moins|almeno|minimum|minimo)\s*(?:level\s*)?([abc][12])\b/i.exec(normalizedContract)?.[1] || '';
    const modality = LANGUAGE_MODALITY_RE.test(normalizedContract) ? 'written' : LANGUAGE_ORAL_RE.test(normalizedContract) ? 'oral' : 'any';
    const kind = threshold ? `threshold_${threshold}` : LANGUAGE_LEVEL_RE.test(normalized) ? 'proficiency' : 'ability';
    const levelField = kind === 'proficiency' && ['text', 'choice'].includes(identityQuestion?.type || 'text')
      && !optionValues(identityQuestion).some(option => /^(?:yes|no|si|ja|nein|oui|non|true|false)$/.test(option));
    const binaryField = kind === 'ability' && ['yes_no', 'checkbox'].includes(identityQuestion?.type);
    if (levelField || binaryField) return `language_${languageCodes[0]}_${modality}_${kind}`;
  }
  const normalized = questionTextIdentity(identityQuestion, text);
  if (!normalized) return '';
  if (!hasBoundedTextIdentity && !context && !section && !autocomplete && !ownershipKey && isPreferredWorkloadQuestion(text)) return WORKLOAD_PREFERENCE_KEY;
  const metadataContext = section || autocomplete ? `${context}\u0000${section}\u0000${autocomplete}` : context;
  const scopedContext = ownershipKey ? `${metadataContext}\u0000${ownershipKey}` : metadataContext;
  const type = normalizeQuestionValue(identityQuestion?.type) || 'unknown';
  const options = optionsIdentity(identityQuestion);
  return `question_${questionHash(`${type}\u0000${scopedContext}\u0000${normalized}\u0000${options}`)}`;
}

/**
 * Candidate-owned answer state that cannot be projected must keep platform
 * defaults away from that question. Incompatible answers are also reported
 * to metadata recovery, which must leave the whole draft untouched.
 */
export function candidateAnswerProjectionDiagnostics(questions, {
  answers = {}, memory = {}, history = [], nowMs = Date.now(), canExpressAnswer = null,
} = {}) {
  const suppressed = new Set();
  const incompatible = new Set();
  const suppressedAnswerContracts = [];
  const addSuppressed = (question, { status = 'unknown', answer = undefined, allowLiveMapping = false } = {}) => {
    const id = String(question?.id || '').trim();
    if (!id) return;
    suppressed.add(id);
    suppressedAnswerContracts.push({
      id,
      labels: [...new Set([question.applicationQuestion, question.portalQuestion, question.question, question.label]
        .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 520)))],
      status,
      ...(status === 'answered' && hasQuestionAnswer(answer) ? { answer } : {}),
      allowLiveMapping: allowLiveMapping === true,
    });
  };
  for (const question of Array.isArray(questions) ? questions : []) {
    const id = String(question?.id || '').trim();
    if (!id) continue;
    const direct = answers && typeof answers === 'object' ? answers[id] : undefined;
    if (isUnknownAnswer(direct)) {
      addSuppressed(question);
      continue;
    }
    if (hasQuestionAnswer(direct)) {
      const savedState = candidateAnswerHistoryStateForQuestionId(question, history);
      const saved = savedState.record;
      const savedTypeCompatible = Boolean(saved && saved.status === 'answered'
        && compatibleAnswerQuestionTypes(candidateAnswerHistoryQuestionType(saved, question), question.type));
      const savedContractCompatible = savedTypeCompatible && compatibleAnswerQuestionContract(saved, question);
      const savedFullyCompatible = savedContractCompatible && compatibleAnswerQuestionIdentity(saved, question);
      const directCurrent = directAnswerForCurrentQuestion(direct, question, nowMs);
      const directExpressible = directCurrent !== undefined
        || (typeof canExpressAnswer === 'function' && canExpressAnswer(question, direct));
      const liveMappingAllowed = directExpressible && (!savedState.present || savedContractCompatible);
      const invalidHistory = savedState.ambiguous || (savedState.present && !savedFullyCompatible && !liveMappingAllowed);
      if (invalidHistory || (savedState.present && !savedFullyCompatible) || !directExpressible) {
        addSuppressed(question, { status: 'answered', answer: direct,
          allowLiveMapping: !savedState.present || savedContractCompatible });
        if (invalidHistory || !directExpressible) incompatible.add(id);
      }
      continue;
    }
    const historical = candidateAnswerHistoryStateForQuestion(question, history);
    if (historical.present) {
      const record = historical.record;
      if (historical.ambiguous) {
        addSuppressed(question);
        incompatible.add(id);
      } else if (record?.status === 'answered') {
        const typeCompatible = compatibleAnswerQuestionTypes(candidateAnswerHistoryQuestionType(record, question), question.type);
        const contractCompatible = typeCompatible && compatibleAnswerQuestionContract(record, question);
        const fullyCompatible = contractCompatible && compatibleAnswerQuestionIdentity(record, question);
        const answer = record.id === id
          ? directAnswerForCurrentQuestion(record.answer, question, nowMs)
          : answerForCurrentQuestion(record.answer, question, nowMs);
        const liveExpressible = record.id === id && contractCompatible
          && (answer !== undefined || (typeof canExpressAnswer === 'function' && canExpressAnswer(question, record.answer)));
        if (!fullyCompatible || answer === undefined) {
          addSuppressed(question, { status: 'answered', answer: record.answer,
            allowLiveMapping: record.id === id && contractCompatible });
          if (!liveExpressible) incompatible.add(id);
        }
      } else {
        addSuppressed(question);
      }
      continue;
    }
    const key = candidateQuestionAnswerKey(question);
    if (key && Object.hasOwn(memory || {}, key)) {
      const remembered = memory[key];
      if (!hasQuestionAnswer(remembered)) {
        addSuppressed(question);
      } else if (answerForCurrentQuestion(remembered, question, nowMs) === undefined) {
        addSuppressed(question, { status: 'answered', answer: remembered });
        if (!(typeof canExpressAnswer === 'function' && canExpressAnswer(question, remembered))) incompatible.add(id);
      }
    }
  }
  return {
    suppressDefaultQuestionIds: [...suppressed],
    incompatibleQuestionIds: [...incompatible],
    suppressedAnswerContracts,
  };
}

/** Reuse candidate answers only when their topic is unambiguous and the value fits the current contract. */
export function candidateAnswersForQuestions(questions, answers = {}, memory = {}, history = [], nowMs = Date.now()) {
  const result = { ...(answers && typeof answers === 'object' ? answers : {}) };
  const unknownKeys = new Set();
  const unknownQuestionIds = new Set();
  for (const question of Array.isArray(questions) ? questions : []) {
    if (isUnknownAnswer(result[question?.id])) {
      const key = candidateQuestionAnswerKey(question);
      if (key) unknownKeys.add(key);
      unknownQuestionIds.add(question.id);
      delete result[question.id];
    }
  }
  // A value saved under this id can outlive a portal's changed options or validation contract.
  // Keep the stored source and candidate ledger intact, but do not let a stale value satisfy today's field.
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id || !hasQuestionAnswer(result[question.id])) continue;
    const saved = candidateAnswerHistoryRecordForQuestionId(question, history);
    const hasMatchingCandidateHistory = saved && saved.status === 'answered'
      && answerValueKey(saved.answer) === answerValueKey(result[question.id]);
    if (saved && saved.status !== 'answered') {
      const key = candidateQuestionAnswerKey(question);
      if (key) unknownKeys.add(key);
      unknownQuestionIds.add(question.id);
      delete result[question.id];
      continue;
    }
    if (saved === undefined || (saved && !hasMatchingCandidateHistory)) {
      const current = answerForCurrentQuestion(result[question.id], question, nowMs);
      if (current !== undefined) result[question.id] = current;
      else if (!isLegacyPermitAnswer(question, result[question.id])
        && isDirectAnswerInvalidForCurrentContract(question, result[question.id], nowMs)) {
        const key = candidateQuestionAnswerKey(question);
        if (key) unknownKeys.add(key);
        unknownQuestionIds.add(question.id);
        delete result[question.id];
      }
      // A direct same-id answer outside a non-catalogue validation can remain visible for review.
      // Execution paths call validatedCandidateAnswerForQuestion before treating it as complete.
      continue;
    }
    if (saved === null || (saved && (saved.status !== 'answered'
      || !compatibleAnswerQuestionTypes(candidateAnswerHistoryQuestionType(saved, question), question.type)
      || !compatibleAnswerQuestionIdentity(saved, question)))) {
      const key = candidateQuestionAnswerKey(question);
      if (key) unknownKeys.add(key);
      unknownQuestionIds.add(question.id);
      delete result[question.id];
      continue;
    }
    const current = directAnswerForCurrentQuestion(result[question.id], question, nowMs);
    if (current === undefined && question?.requiresAffirmativeConsent === true
      && hasQuestionAnswer(result[question.id]) && !requiredPortalConsentAffirmed(question, result[question.id])) continue;
    if (current !== undefined) result[question.id] = current;
    else if (!isLegacyPermitAnswer(question, result[question.id])) delete result[question.id];
  }
  const currentValues = new Map();
  const conflicts = new Set();
  for (const question of Array.isArray(questions) ? questions : []) {
    const key = candidateQuestionAnswerKey(question);
    const value = result[question?.id];
    if (!key || !hasQuestionAnswer(value)) continue;
    const current = answerForCurrentQuestion(value, question, nowMs);
    if (current === undefined) continue;
    const previous = currentValues.get(key);
    if (!previous) currentValues.set(key, { value, comparable: answerValueKey(value), constraintsKey: candidateAnswerConstraintsKey(question) });
    else if (previous.comparable !== answerValueKey(value)
      || previous.constraintsKey !== candidateAnswerConstraintsKey(question)) conflicts.add(key);
  }
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id || hasQuestionAnswer(result[question.id])) continue;
    if (candidateAnswerHistoryStateForQuestion(question, history).present) continue;
    const key = candidateQuestionAnswerKey(question);
    if (!key || conflicts.has(key) || unknownKeys.has(key)) continue;
    const remembered = Object.hasOwn(memory || {}, key) ? memory[key] : undefined;
    if (Object.hasOwn(memory || {}, key) && !hasQuestionAnswer(remembered)) continue;
    const recorded = currentValues.get(key)?.value ?? remembered;
    const source = candidateQuestionFact(question) ? candidateFactAnswerForQuestion(question, recorded) : recorded;
    if (hasQuestionAnswer(source)) {
      const current = answerForCurrentQuestion(source, question, nowMs);
      if (current === undefined) continue;
      result[question.id] = key === WORKLOAD_PREFERENCE_KEY && question.type === 'number'
        ? String(Number(String(current).replace('%', '').trim().replace(',', '.')))
        : current;
    }
  }
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id || hasQuestionAnswer(result[question.id]) || unknownQuestionIds.has(question.id)) continue;
    const key = candidateQuestionAnswerKey(question);
    if (key && unknownKeys.has(key)) continue;
    const historical = candidateHistoryAnswerForQuestion(question, history, nowMs);
    if (historical !== undefined) result[question.id] = historical;
  }
  return withTwinAddressAnswers(Array.isArray(questions) ? questions : [], answers, memory, result, unknownKeys, nowMs);
}

/**
 * The candidate's own address blocks of one order (assistedApplicationPlatformDefaults.js candidateAddressTopics):
 * what they typed in one block answers the same field of the other (owner decision 2026-11-11, Yellowshark
 * 1EpmkrDu: a second block of the same form asked street, number, postal code and town again). Only one value
 * per field: two different ones stay the candidate's to reconcile. A field they cleared, marked unknown or
 * emptied in the ledger stays theirs, and another party's address never takes it.
 */
function withTwinAddressAnswers(questions, answers, memory, result, unknownKeys, nowMs) {
  const topics = candidateAddressTopics(questions);
  if (!topics.size) return result;
  const given = new Map();
  for (const question of questions) {
    const topic = topics.get(String(question?.id ?? ''));
    const value = result[question?.id];
    if (!topic || typeof value !== 'string' || !hasQuestionAnswer(value)) continue;
    if (!given.has(topic)) given.set(topic, new Map());
    given.get(topic).set(answerValueKey(value), value);
  }
  for (const question of questions) {
    const topic = topics.get(String(question?.id ?? ''));
    if (!topic || given.get(topic)?.size !== 1 || hasQuestionAnswer(result[question.id])) continue;
    if (Object.hasOwn(answers || {}, question.id)) continue;
    const key = candidateQuestionAnswerKey(question);
    if (key && (unknownKeys.has(key) || (Object.hasOwn(memory || {}, key) && !hasQuestionAnswer(memory[key])))) continue;
    const [value] = given.get(topic).values();
    const current = answerForCurrentQuestion(value, question, nowMs);
    if (current !== undefined) result[question.id] = current;
  }
  return result;
}

/** Persist a compact, order-scoped answer ledger so a later draft can survive new question ids. */
export function rememberCandidateQuestionAnswers({ questions, answers = {}, previous = {}, changed = {} } = {}) {
  const memory = { ...(previous && typeof previous === 'object' ? previous : {}) };
  const groups = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    const key = candidateQuestionAnswerKey(question);
    if (!key || !question?.id) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  for (const [key, group] of groups) {
    const changedQuestions = group.filter((question) => Object.hasOwn(changed || {}, question.id));
    const changedValues = changedQuestions.map((question) => answers[question.id]).filter(hasQuestionAnswer);
    const currentValues = group.map((question) => answers[question.id]).filter(hasQuestionAnswer);
    const unique = new Map(currentValues.map((value) => [answerValueKey(value), value]));
    const changedUnique = new Map(changedValues.map((value) => [answerValueKey(value), value]));
    const explicitClear = changedQuestions.some((question) => !hasQuestionAnswer(changed[question.id]));
    if (changedUnique.size === 1) memory[key] = [...changedUnique.values()][0];
    else if (changedUnique.size > 1 || explicitClear) memory[key] = '';
    else if (unique.size === 1 && !Object.hasOwn(memory, key)) memory[key] = [...unique.values()][0];
    else if (unique.size > 1) memory[key] = '';
  }
  return Object.fromEntries(Object.entries(memory).slice(-80));
}

/** Whether a language ability question still needs an answer after facts from the CV are applied. */
export function questionNeedsCandidateAnswer(question, profile, draft) {
  return Boolean(question) && !provenOptionalOperationalPortalQuestion(question, draft)
    && !unreadablePortalQuestion(question) && !languageExplicitlyAbsent(profile, question?.question);
}

/** A required application consent remains open unless the candidate explicitly agrees. */
export function requiredPortalConsentAffirmed(question, value) {
  if (question?.requiresAffirmativeConsent !== true) return true;
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = (Array.isArray(value) ? value.join(' ') : String(value)).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  if (/\b(?:no|nein|non|not|never|dont|don t|doesn t|didn t|won t|cannot|can t|unable|refus\w*|rifiut\w*)\b/.test(text)) return false;
  return /^(?:si|yes|ja|oui|true|1)(?:\b|$)/.test(text)
    || /\b(?:acconsent\w*|consent\w*|accett\w*|agree\w*|accept\w*|conferm\w*)\b/.test(text);
}

/** Remove questions established by the CV and duplicate semantic requests, retaining required status. */
export function questionsForCandidate(questions, profile, answers = {}, memory = {}, draft = null, history = [], nowMs = Date.now()) {
  const projectedAnswers = candidateAnswersForQuestions(questions, answers, memory, history, nowMs);
  const candidates = (Array.isArray(questions) ? questions : []).filter((question) =>
    questionNeedsCandidateAnswer(question, profile, draft)
      && !(isIdentityEmailConfirmationQuestion(question) && hasQuestionAnswer(projectedAnswers[question?.id])))
    .map(question => {
      const visible = hasPortalQuestionEvidence(question) ? { ...question, question: portalQuestionText(question),
        ...(question.portalNativeContract && question.required === false
          && !provenOptionalOperationalPortalQuestion(question, draft) ? { required: true } : {}) } : question;
      // A matcher question about prior experience describes job fit, not a field the application portal
      // requires. Keep it on the review page as an editable proposal, but do not gate the portal send.
      return isMatcherExperienceQuestion(visible) && visible.required ? { ...visible, required: false } : visible;
    });
  // The same field of two address blocks of the candidate's own (candidateAddressTopics) is one request: shown
  // once, its answer reaches the other block (withTwinAddressAnswers). Two different answers show both again.
  const addressTopics = candidateAddressTopics(questions);
  const groupKey = (question) => {
    const topic = addressTopics.get(String(question?.id ?? ''));
    return topic ? `candidate_address_${topic}` : candidateQuestionAnswerKey(question);
  };
  const answerValues = new Map();
  const conflictingKeys = new Set();
  const questionsByKey = new Map();
  for (const question of candidates) {
    const key = groupKey(question);
    if (key) {
      if (!questionsByKey.has(key)) questionsByKey.set(key, []);
      questionsByKey.get(key).push(question);
    }
    const answer = projectedAnswers[question?.id];
    if (!key || !hasQuestionAnswer(answer)) continue;
    if (!answerValues.has(key)) answerValues.set(key, new Set());
    answerValues.get(key).add(answerValueKey(answer));
    if (answerValues.get(key).size > 1) conflictingKeys.add(key);
  }
  const incompatibleKeys = new Set();
  for (const [key, group] of questionsByKey) {
    for (const question of group) {
      const answer = projectedAnswers[question?.id];
      if (hasQuestionAnswer(answer) && group.some((other) => !answerFitsQuestion(answer, other))) incompatibleKeys.add(key);
    }
  }
  const result = [];
  const seen = new Map();
  for (const question of candidates) {
    const key = groupKey(question);
    if (!key) {
      result.push(question);
      continue;
    }
    if (conflictingKeys.has(key) || incompatibleKeys.has(key)) {
      result.push(question);
      continue;
    }
    const priorIndex = seen.get(key);
    if (priorIndex === undefined) {
      seen.set(key, result.length);
      result.push(question);
      continue;
    }
    const previous = result[priorIndex];
    const previousAnswered = hasQuestionAnswer(projectedAnswers[previous.id]);
    const currentAnswered = hasQuestionAnswer(projectedAnswers[question.id]);
    const preferred = currentAnswered && !previousAnswered
      || Boolean(question.required && !previous.required)
      ? question
      : previous;
    result[priorIndex] = { ...preferred, required: Boolean(previous.required || question.required) };
  }
  return result;
}

function isIdentityEmailConfirmationQuestion(question) {
  const type = String(question?.type || '').trim().toLowerCase();
  const label = [question?.question, question?.applicationQuestion].filter(Boolean).join(' ');
  const context = [question?.context, question?.section, question?.autocomplete].filter(Boolean).join(' ');
  return question?.source === 'portal'
    && question?.required === true
    && ['text', 'email', 'email_address'].includes(type)
    && isIdentityEmailConfirmation({ label, context });
}

const MESSAGES = {
  name: {
    it: 'Scrivi il nome con le lettere, come nei tuoi documenti.',
    de: 'Schreib den Namen mit Buchstaben, wie in deinen Dokumenten.',
    fr: 'Écrivez le nom en lettres, comme sur vos documents.',
    en: 'Write the name in letters, as in your documents.',
  },
  phone: {
    it: 'Un numero di telefono, per esempio +41 91 123 45 67.',
    de: 'Eine Telefonnummer, zum Beispiel +41 91 123 45 67.',
    fr: 'Un numéro de téléphone, par exemple +41 91 123 45 67.',
    en: 'A phone number, for example +41 91 123 45 67.',
  },
  linkedin: {
    it: 'Il link al tuo profilo LinkedIn, per esempio linkedin.com/in/nome-cognome.',
    de: 'Der Link zu deinem LinkedIn-Profil, zum Beispiel linkedin.com/in/vorname-nachname.',
    fr: 'Le lien vers votre profil LinkedIn, par exemple linkedin.com/in/prenom-nom.',
    en: 'The link to your LinkedIn profile, for example linkedin.com/in/first-last.',
  },
  salary: SALARY_RULE_MESSAGES,
  required: {
    it: 'Questo campo è obbligatorio.',
    de: 'Dieses Feld ist obligatorisch.',
    fr: 'Ce champ est obligatoire.',
    en: 'This field is required.',
  },
  tooShort: {
    it: 'Il testo è troppo corto.',
    de: 'Der Text ist zu kurz.',
    fr: 'Le texte est trop court.',
    en: 'The text is too short.',
  },
  tooLong: {
    it: 'Il testo è troppo lungo.',
    de: 'Der Text ist zu lang.',
    fr: 'Le texte est trop long.',
    en: 'The text is too long.',
  },
  alias: {
    it: 'L’indirizzo della candidatura non si cambia: le risposte del datore arrivano lì e te le inoltriamo.',
    de: 'Die Adresse der Bewerbung bleibt: Antworten des Arbeitgebers kommen dort an und wir leiten sie dir weiter.',
    fr: 'L’adresse de la candidature ne change pas : les réponses de l’employeur y arrivent et nous vous les transmettons.',
    en: 'The application address stays: the employer’s replies arrive there and we forward them to you.',
  },
  question: {
    it: 'Si cambia nella domanda qui sopra.',
    de: 'Das änderst du in der Frage oben.',
    fr: 'Cela se modifie dans la question ci-dessus.',
    en: 'Change it in the question above.',
  },
  birthDate: {
    it: 'Una data di nascita valida, per esempio 12.03.1998.',
    de: 'Ein gültiges Geburtsdatum, zum Beispiel 12.03.1998.',
    fr: 'Une date de naissance valide, par exemple 12.03.1998.',
    en: 'A valid date of birth, for example 12.03.1998.',
  },
};

const say = (key, locale) => MESSAGES[key][locale] || MESSAGES[key].it;

const rule = (partial) => ({ pattern: '', minLength: 0, maxLength: 200, min: null, max: null, minDate: '', example: '', message: '', ...partial });

const NAME = safePattern("\\p{L}[\\p{L}\\p{M}'’. -]*");
const PHONE = safePattern('\\+?[0-9][0-9 ()./-]{5,24}');
const LINKEDIN = safePattern('(?:https?://)?(?:[a-z]{2,3}\\.)?linkedin\\.com/\\S+');
// Day first, as the CV prints it, or ISO; that it is a real date in the past is checked on save.
const BIRTH_DATE = safePattern('\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{4}-\\d{2}-\\d{2}');

/**
 * The form fields the candidate may change. `inLetter`: printed in the letter
 * header, so a change rebuilds the PDF. `inCv`: printed in the tailored CV, so
 * the page shows it for e-mail applications too. `answerId`: the question that
 * asks the same thing wins (the field is changed there). `perRound`: a text of
 * this round's draft, not a fact about the candidate. `choice: 'permit'`: one
 * of the permit statuses (lib/permitStatus.js). `birthDate`: a real date in
 * the past.
 */
export const EDITABLE_FIELDS = {
  firstName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Maria' }), message: 'name', required: true, inLetter: true, inCv: true },
  lastName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Rossi' }), message: 'name', required: true, inLetter: true, inCv: true },
  phone: { rule: rule({ pattern: PHONE, maxLength: 30, example: '+41 91 123 45 67' }), message: 'phone', inLetter: true, inCv: true },
  location: { rule: rule({ maxLength: 120 }), inLetter: true, inCv: true },
  linkedin: { rule: rule({ pattern: LINKEDIN, maxLength: 200, example: 'linkedin.com/in/nome-cognome' }), message: 'linkedin', inCv: true },
  languages: { rule: rule({ maxLength: 200 }), inCv: true },
  // Optional corrections, never asked by a required question (decision 5): no question locks them.
  dateOfBirth: { rule: rule({ pattern: BIRTH_DATE, maxLength: 40, example: '12.03.1998' }), message: 'birthDate', inCv: true, birthDate: true },
  nationality: { rule: rule({ maxLength: 120 }), inCv: true },
  workPermit: { rule: rule({ maxLength: 120 }), answerId: 'work_permit', inCv: true, choice: 'permit' },
  availability: { rule: rule({ maxLength: 120 }), answerId: 'availability', inCv: true },
  salary: { rule: rule({ pattern: safePattern('.*\\d.*'), maxLength: 120, example: "CHF 80'000" }), message: 'salary', answerId: 'salary_expectation' },
  motivationShort: { rule: rule({ maxLength: 600 }), perRound: true },
  whyCompany: { rule: rule({ maxLength: 400 }), perRound: true },
  // What the candidate said of themselves, by an answer or in their CV's own words (lib/personalFacts.js):
  // shown only when known, so that they can correct it. Neither is asked once the CV says it.
  salutation: { rule: rule({ maxLength: 40 }), answerId: 'salutation', choice: 'salutation' },
  civilStatus: { rule: rule({ maxLength: 60 }), choice: 'civilStatus' },
};

// The closed lists a field is chosen from, in the candidate's language, and whether a text is one of a list
// (in any of the four languages: a value kept from another locale stays valid).
const CHOICES = {
  permit: { options: permitOptions, valid: (text) => Boolean(permitStatusOf(text)) },
  salutation: { options: salutationOptions, valid: isSalutation },
  civilStatus: { options: civilStatusOptions, valid: (text) => Boolean(civilStatusCode(text)) },
};

/** Letter and e-mail lengths (the draft writes within them). */
export const TEXT_LIMITS = {
  coverLetterText: { min: 200, max: 8000 },
  emailSubject: { min: 3, max: 250 },
  emailBody: { min: 20, max: 4000 },
};

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function candidatePassportAnswerInputs(questions, answers, flow) {
  const direct = flow?.answers && typeof flow.answers === 'object' ? flow.answers : {};
  const remembered = flow?.questionAnswers && typeof flow.questionAnswers === 'object' ? flow.questionAnswers : {};
  return (Array.isArray(questions) ? questions : [])
    .filter((question) => question?.id && platformQuestionTopic(question)?.startsWith('passport_'))
    .filter((question) => has(direct, question.id) || has(remembered, question.id) || has(answers, question.id))
    .map((question) => ({
      question,
      value: has(direct, question.id) ? direct[question.id]
        : has(remembered, question.id) ? remembered[question.id] : answers[question.id],
    }))
    .filter(({ value }) => typeof value === 'string' || Array.isArray(value));
}

/** The stored overrides, only known keys and bounded values. */
function storedOverrides(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const spec = EDITABLE_FIELDS[key];
    if (spec && !spec.perRound && typeof value === 'string') out[key] = clean(value, spec.rule.maxLength);
  }
  return out;
}

/**
 * The CV's languages with the ones the candidate stated: a stated level replaces the CV's for the same
 * language, a stated language the CV does not list is added, the CV's other languages stay.
 */
function withStatedLanguages(languages, stated) {
  const list = (Array.isArray(languages) ? languages : []).map((entry) => ({ ...entry }));
  for (const entry of stated) {
    const code = String(entry?.code || '');
    if (!code) continue;
    const level = clean(entry.level, 40);
    const index = list.findIndex((known) => languageCodesIn(known?.language || '')[0] === code);
    if (index < 0) list.push({ language: clean(entry.language, 40) || code, level });
    else if (level) list[index] = { ...list[index], level };
  }
  return list;
}

function splitLanguages(text) {
  return String(text || '').split(/[,;\n]/).map((part) => clean(part, 80)).filter(Boolean).map((language) => ({ language, level: '' }));
}

/**
 * The candidate as the application uses them: the order and the CV, then what
 * the candidate changed. A corrected permit, availability or salary replaces
 * an older answer; only a question the current draft asks again wins over it.
 * `profile.permitStatus` is derived here at every read, never stored as a
 * source: the code of the status the candidate chose (lib/permitStatus.js),
 * '' when none.
 * `personal`: the form of address and the civil status, derived here at every
 * read too: what the candidate answered or corrected, else what the CV states
 * explicitly or an unambiguous first name supports (lib/personalFacts.js). A form of address known from either source also stands as `answers.salutation`, so the
 * question is not asked and the portal's field is filled as if answered. The
 * civil status stays out of `profile` and `answers`: the letter and the CV
 * are written from those, and neither says whom the candidate married.
 * @returns {{identity:{name:string,email:string,phone:string,firstName:string,lastName:string}, profile:object & {permitStatus:string}, answers:object, overrides:object, personal:{salutation:string, civilStatus:string}}}
 */
export function candidateWithEdits({ order, draft, flow, locale: requestedLocale, nowMs = Date.now() }) {
  const overrides = storedOverrides(flow?.formOverrides);
  const base = candidateIdentity(order, draft?.profile);
  const names = splitName(base.name);
  const firstName = has(overrides, 'firstName') ? overrides.firstName : names.firstName;
  const lastName = has(overrides, 'lastName') ? overrides.lastName : names.lastName;
  const identity = {
    ...base,
    name: [firstName, lastName].filter(Boolean).join(' ') || base.name,
    firstName,
    lastName,
    phone: has(overrides, 'phone') ? overrides.phone : base.phone,
  };
  const profile = { ...(draft?.profile || {}) };
  // Older profiles capped language lists at 12 without a completeness marker.
  // A shorter list can still be complete when its CV has a dedicated language
  // section; keep an at-cap legacy list conservative because it may be cut off.
  if (profile.languagesListTruncated === undefined) {
    profile.languagesListTruncated = Array.isArray(profile.languages)
      && profile.languages.length >= LEGACY_LANGUAGE_LIST_LIMIT;
  }
  const completeLanguageList = !profile.languagesListTruncated && hasCompleteLanguageList(profile);
  profile.languagesExplicitList = completeLanguageList
    && (profile.languagesExplicitList === true || hasExplicitLanguageSection(draft?.factSources?.text));
  if (has(overrides, 'location')) profile.location = overrides.location;
  if (has(overrides, 'linkedin')) profile.linkedin = overrides.linkedin;
  // What the candidate stated in their reply to the concierge e-mail (assistedApplicationCandidateReply.js):
  // their own word, above the CV and the platform's rules, below a correction they make here afterwards.
  const statements = candidateStatementsOf(order);
  if (!has(overrides, 'availability') && clean(statements.availability, 120)) profile.availability = clean(statements.availability, 120);
  if (!has(overrides, 'languages') && Array.isArray(statements.languages) && statements.languages.length) {
    profile.languages = withStatedLanguages(profile.languages, statements.languages);
  }
  if (has(overrides, 'languages')) {
    profile.languages = splitLanguages(overrides.languages);
    profile.languagesListTruncated = false;
    profile.languagesExplicitList = Boolean(overrides.languages.trim()) && hasCompleteLanguageList(profile);
  }
  if (has(overrides, 'workPermit')) profile.workPermit = overrides.workPermit;
  if (has(overrides, 'availability')) profile.availability = overrides.availability;
  if (has(overrides, 'dateOfBirth')) profile.dateOfBirth = overrides.dateOfBirth;
  if (has(overrides, 'nationality')) profile.nationality = overrides.nationality;
  // Asked at CV upload (owner decision 2026-11-09): the candidate's own word, below a correction of theirs.
  const uploaded = order?.candidateFacts && typeof order.candidateFacts === 'object' ? order.candidateFacts : {};
  if (!has(overrides, 'nationality') && !clean(profile.nationality, 80) && clean(uploaded.nationality, 80)) profile.nationality = clean(uploaded.nationality, 80);
  const answerProjection = candidateAnswerProjectionDiagnostics(draft?.questions, {
    answers: flow?.answers || {}, memory: flow?.questionAnswers || {}, history: flow?.candidateAnswerHistory || [], nowMs,
  });
  const answers = candidateAnswersForQuestions(draft?.questions, flow?.answers || {}, flow?.questionAnswers || {},
    flow?.candidateAnswerHistory || [], nowMs);
  // A required portal can repeat the applicant's identity e-mail as a
  // confirmation field. It is already known from the order/alias; use that
  // value in the same answer projection as the portal planner and keep it out
  // of the candidate Q&A form. Other people's contact e-mails remain open.
  if (identity.email) {
    for (const question of draft?.questions || []) {
      if (question?.id && isIdentityEmailConfirmationQuestion(question)) {
        answers[question.id] = identity.email;
      }
    }
  }
  const asked = new Set((draft?.questions || []).map((question) => question.id));
  for (const [key, spec] of Object.entries(EDITABLE_FIELDS)) {
    if (spec.answerId && has(overrides, key) && !asked.has(spec.answerId)) answers[spec.answerId] = overrides[key];
  }
  // The status is what the candidate chose (the question, else the field, else an older answer), never the CV's
  // words (decision 2). An availability they gave is the one the CV prints.
  profile.permitStatus = permitStatusOf(clean(answers.work_permit, 200) || (has(overrides, 'workPermit') ? overrides.workPermit : ''))
    || (has(overrides, 'workPermit') ? '' : permitStatusOf(uploaded.workPermit));
  const availability = clean(answers.availability, 200);
  if (availability) profile.availability = availability;
  const cv = cvPersonalFacts(draft?.factSources?.text);
  const locale = candidateLocaleOf(requestedLocale, order);
  const salutation = salutationNow({ answers, overrides, cvGender: cv.gender || salutationGenderFromName(identity.firstName, locale), locale });
  // An unambiguous first name is the owner's approved form-of-address default
  // for application portals, including a required native title choice. A
  // candidate answer or correction still wins; ambiguous names and an
  // explicitly cleared correction stay blank.
  // The form of address is never asked (owner decision 2026-11-09): a first name the lexicon does not know
  // takes the platform's reading of it; only a correction the candidate cleared stays blank.
  const platformSalutation = salutation || (has(overrides, 'salutation') ? ''
    : salutationFor(platformSalutationGender(identity.firstName, locale), locale));
  if (platformSalutation) answers.salutation = platformSalutation;
  else delete answers.salutation;
  // The permit asked at upload answers the permit question of the draft, as the candidate chose it; an
  // answer or a correction of theirs stays as they gave it.
  const uploadedPermit = permitStatusOf(uploaded.workPermit);
  if (uploadedPermit && profile.permitStatus === uploadedPermit && asked.has('work_permit')
    && !clean(answers.work_permit, 200) && !has(overrides, 'workPermit')) {
    answers.work_permit = permitLabel(uploadedPermit, locale);
  }
  const personal = { salutation: platformSalutation, civilStatus: has(overrides, 'civilStatus') ? overrides.civilStatus : cv.civilStatusText };
  // Form-only values (assistedApplicationPlatformDefaults.js): kept apart from `profile`, which the letter
  // and the CV are written from, so a synthesized street or an estimated birth date is never printed there.
  // A permit field the candidate corrected or answered, even to empty, is their word: no permit is deduced over it.
  const permitDeduction = !has(overrides, 'workPermit') && !has(flow?.answers || {}, 'work_permit');
  // The same for the nationality (owner decision 2026-11-11): a correction or an answer of theirs, even emptied,
  // is their word, and no nationality is deduced from the CV over it.
  const nationalityDeduction = !has(overrides, 'nationality') && !has(flow?.answers || {}, 'nationality');
  // The address the candidate typed in one of their own address blocks wins over the platform's, so every other
  // block of theirs receives the same one; a block proved theirs only by its fields is named for the platform
  // rule (owner decision 2026-11-11, assistedApplicationPlatformDefaults.js candidateAddressTopics).
  const candidatePassportAnswers = candidatePassportAnswerInputs(draft?.questions, answers, flow);
  const passportOverride = {
    provided: has(flow?.formOverrides || {}, 'passport') && typeof flow?.formOverrides?.passport === 'string',
    value: flow?.formOverrides?.passport,
  };
  const decisionAnswers = verifiedDecisionAnswers(draft?.questions, draft?.factSources?.text, {
    postingTitle: draft?.job?.title || '', postingRequirements: Array.isArray(draft?.requirements) ? draft.requirements : [],
  });
  // A candidate's passport declaration has priority over a platform decision, including an explicit blank.
  // Keep the deterministic rules available so every other passport form receives the same candidate fact.
  if (passportOverride.provided || (has(uploaded, 'passport') && typeof uploaded.passport === 'string') || candidatePassportAnswers.length) {
    for (const question of draft?.questions || []) {
      if (question?.id && platformQuestionTopic(question)?.startsWith('passport_')) delete decisionAnswers[question.id];
    }
  }
  const platformFacts = withCandidateAddress(platformCandidateFacts({
    order, profile, identity, personal, answers, locale, seed: order?.userId || order?.orderId || '', permitDeduction,
    nationalityDeduction, cvText: draft?.factSources?.text || '', questions: draft?.questions,
    decisionAnswers, candidatePassportAnswers, passportOverride,
  }), candidateAddressStatements(draft?.questions, answers));
  platformFacts.ownedAddressFields = ownedAddressTwinFields(draft?.questions);
  // The answers the CV gives to the open text questions (owner decisions 2026-11-10,
  // assistedApplicationCvAnswers.js), checked against the CV again on every read: form-only too.
  platformFacts.cvAnswers = verifiedCvAnswers(draft?.questions, draft?.factSources?.text, draft?.profile || profile);
  // The decision engine's choices for the questions no rule and no CV answer cover (2026-11-10,
  // assistedApplicationDecisionAnswers.js), checked again on every read: form-only as well.
  platformFacts.decisionAnswers = decisionAnswers;
  return { identity, profile, answers, overrides, personal, platformFacts,
    candidateAnswerDefaultSuppressionIds: answerProjection.suppressDefaultQuestionIds,
    candidateAnswerSuppressedQuestionContracts: answerProjection.suppressedAnswerContracts };
}

/**
 * The candidate's form of address as of now. What the CV says is a default, never a rule; the candidate's
 * own word comes first, in this order:
 *  1. the field they corrected on the review page, even emptied (`has`, not truthiness), whatever an older
 *     answer says: `answers.salutation` «Monsieur» with `formOverrides.salutation` «» gives «». It holds
 *     across rounds, and a draft written afterwards does not ask the question again (lib/draft.mjs): the
 *     older answer would otherwise come back with the question (review of #12348);
 *  2. their answer to the question;
 *  3. only where they touched neither, the gender the CV explicitly states in its own words or the locale-aware
 *     default for an unambiguous first name. Unknown and ambiguous names leave the field blank.
 */
function salutationNow({ answers, overrides, cvGender, locale }) {
  if (has(overrides, 'salutation')) return overrides.salutation;
  return clean(answers.salutation, 40) || salutationFor(cvGender, locale);
}

/**
 * The fact sources a gate run reads, with the candidate's permit status of now
 * (decision 8). A draft written before the status existed has no
 * `permitStatus` in its sources and is judged as it was.
 */
export function factSourcesNow({ order, draft, flow }, sources = draft?.factSources || {}) {
  if (typeof sources?.permitStatus !== 'string') return sources;
  return { ...sources, permitStatus: candidateWithEdits({ order, draft, flow }).profile.permitStatus };
}

/** The form fields with the candidate's changes (review page, handoff kit, owner queue). */
export function formAnswersWithEdits({ order, draft, flow, locale: requestedLocale }) {
  if (!draft) return [];
  const locale = candidateLocaleOf(requestedLocale, order);
  const { identity, profile, answers, personal } = candidateWithEdits({ order, draft, flow, locale });
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  return buildFormAnswers({
    identity,
    profile,
    documents: { motivationShort: motivation.motivationShort, whyCompany: motivation.whyCompany },
    answers,
    locale,
    personal,
  });
}

/** Why a field cannot be changed here: the alias, or a question that asks it. */
function lockReason(key, draft) {
  if (key === 'email') return 'alias';
  const answerId = EDITABLE_FIELDS[key]?.answerId;
  if (answerId && (draft?.questions || []).some((question) => question.id === answerId)) return 'question';
  return EDITABLE_FIELDS[key] ? null : 'fixed';
}

/** The field's rule with its message in the candidate's language. */
export function fieldRule(key, locale = 'it') {
  const spec = EDITABLE_FIELDS[key];
  if (!spec) return null;
  return { ...spec.rule, message: spec.message ? say(spec.message, locale) : '' };
}

/** How the page shows a field: editable or not (and why), with the rule. */
export function fieldView(field, { draft, flow = {}, locale = 'it' }) {
  const lock = lockReason(field.key, draft);
  const spec = EDITABLE_FIELDS[field.key];
  // The review page may show an older candidate-confirmed permit beside a
  // fresh portal question. Localize that candidate-facing value, but leave
  // formAnswersWithEdits untouched: the runner still receives the source
  // value and the portal question remains the authority for its answer.
  const confirmedPermit = field.key === 'workPermit'
    && typeof flow?.formOverrides?.workPermit === 'string'
    && flow.formOverrides.workPermit.trim();
  const value = confirmedPermit ? permitLabel(field.value, locale) : field.value;
  const view = {
    key: field.key,
    // The form of address and the civil status are named here, in the candidate's language, as their lists are.
    label: personalFieldLabel(field.key, locale) || field.label,
    value,
    editable: !lock,
    locked: lock === 'alias' || lock === 'question' ? lock : null,
    required: Boolean(spec?.required),
    inLetter: Boolean(spec?.inLetter) || field.key === 'email',
    inCv: Boolean(spec?.inCv),
    validation: lock ? null : fieldRule(field.key, locale),
  };
  // The permit status is chosen, never typed (decision 2): the six options in the candidate's language. A value
  // that is none of them (the CV's own words, an older text) stays shown and selected; no status is pre-selected.
  // So are the form of address and the civil status.
  if (!lock && CHOICES[spec?.choice]) {
    const options = CHOICES[spec.choice].options(locale);
    const selected = String(value || '').trim();
    view.options = selected && !options.includes(selected) ? [selected, ...options] : options;
  }
  return view;
}

function checkField(key, text, locale, todayIso) {
  const spec = EDITABLE_FIELDS[key];
  if (!text) return spec.required ? say('required', locale) : '';
  if (text.length > spec.rule.maxLength) return say('tooLong', locale);
  const question = { type: 'text', required: false, validation: fieldRule(key, locale) };
  const result = validateAnswer(text, question);
  if (!result.ok) return answerMessage(result, question, locale);
  // Only a text that is there is held to its list: an emptied field is accepted (above), never «not an option».
  const list = CHOICES[spec.choice];
  if (list && text && !list.valid(text)) return answerMessage({ ok: false, reason: 'not_an_option', message: '' }, {}, locale);
  if (spec.birthDate) {
    const iso = isoDateOf(text);
    if (!iso || iso > todayIso) return say('birthDate', locale);
  }
  return '';
}

function checkText(key, text, locale) {
  const { min, max } = TEXT_LIMITS[key];
  if (text.length < min) return say('tooShort', locale);
  if (text.length > max) return say('tooLong', locale);
  return '';
}

const signatureOf = (identity) => [identity.name, identity.email, identity.phone].filter(Boolean).join('\n');

/**
 * What an edit request changes, checked the same way as on the page. Only
 * what differs from what the candidate saw is kept.
 * @param {{coverLetterText?:string, emailSubject?:string, emailBody?:string, fields?:Record<string,string>}} raw
 * @returns {{errors:Record<string,string>, changed:string[], overrides:object, draftPatch:object, identityChanged:boolean, candidateText:string}}
 */
export function planCandidateEdits(raw, { order, draft, flow, locale = 'it', nowMs = Date.now() }) {
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  const errors = {};
  const changed = [];
  const draftPatch = {};
  const overrides = {};
  const written = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const shown = new Map(formAnswersWithEdits({ order, draft, flow, locale })
    .map((field) => fieldView(field, { draft, flow, locale }))
    .map((field) => [field.key, field.value]));
  const roundTexts = {};
  for (const [key, value] of Object.entries(input.fields && typeof input.fields === 'object' ? input.fields : {})) {
    if (!shown.has(key) || typeof value !== 'string') continue;
    const text = clean(value, 2000);
    if (text === clean(shown.get(key), 2000)) continue;
    const lock = lockReason(key, draft);
    if (lock) {
      errors[key] = say(lock === 'question' ? 'question' : 'alias', locale);
      continue;
    }
    const problem = checkField(key, text, locale, todayIso);
    if (problem) {
      errors[key] = problem;
      continue;
    }
    if (EDITABLE_FIELDS[key].perRound) roundTexts[key] = text;
    else overrides[key] = text;
    written.push(text);
  }
  if (Object.keys(overrides).length) changed.push('fields');
  if (Object.keys(roundTexts).length) {
    const present = new Set((draft.formAnswers || []).map((field) => field.key));
    draftPatch.formAnswers = [
      ...(draft.formAnswers || []).map((field) => (has(roundTexts, field.key) ? { ...field, value: roundTexts[field.key] } : field)),
      ...Object.entries(roundTexts).filter(([key]) => !present.has(key)).map(([key, value]) => ({ key, label: key, value, needsConfirmation: false, note: '' })),
    ];
    changed.push('texts');
  }

  if (typeof input.coverLetterText === 'string') {
    const letter = parseLetterText(cleanBlock(input.coverLetterText, TEXT_LIMITS.coverLetterText.max + 1));
    const text = letterText(letter);
    if (text !== letterText(parseLetterText(draft.coverLetter?.text || ''))) {
      const problem = checkText('coverLetterText', text, locale);
      if (problem) errors.coverLetterText = problem;
      else {
        draftPatch.coverLetter = { ...(draft.coverLetter || {}), ...letter, text };
        changed.push('coverLetter');
        written.push(text);
      }
    }
  }

  // The e-mail exists only when the application leaves by e-mail.
  const email = draft.channel?.type === 'email' ? { ...(draft.applicationEmail || {}) } : null;
  if (email) {
    let emailChanged = false;
    if (typeof input.emailSubject === 'string') {
      const subject = clean(input.emailSubject, TEXT_LIMITS.emailSubject.max + 1);
      if (subject !== clean(email.subject, TEXT_LIMITS.emailSubject.max + 1)) {
        const problem = checkText('emailSubject', subject, locale);
        if (problem) errors.emailSubject = problem;
        else { email.subject = subject; emailChanged = true; written.push(subject); }
      }
    }
    if (typeof input.emailBody === 'string') {
      const body = cleanBlock(input.emailBody, TEXT_LIMITS.emailBody.max + 1);
      if (body !== cleanBlock(email.body, TEXT_LIMITS.emailBody.max + 1)) {
        const problem = checkText('emailBody', body, locale);
        if (problem) errors.emailBody = problem;
        else { email.body = body; emailChanged = true; written.push(body); }
      }
    }
    // A new name or phone also updates the signature we wrote under the
    // e-mail: found in the e-mail as drafted, written under the e-mail as
    // saved, so a rewritten body never leaves without the contact details.
    const before = candidateWithEdits({ order, draft, flow }).identity;
    const after = candidateWithEdits({ order, draft, flow: { ...flow, formOverrides: { ...(flow?.formOverrides || {}), ...overrides } } }).identity;
    const oldSignature = signatureOf(before);
    const newSignature = signatureOf(after);
    if (oldSignature !== newSignature && oldSignature && String(draft.applicationEmail?.body || '').endsWith(oldSignature)) {
      const body = String(email.body || '');
      if (body.endsWith(oldSignature)) email.body = `${body.slice(0, -oldSignature.length)}${newSignature}`;
      else if (!body.endsWith(newSignature)) email.body = `${body.replace(/\s+$/, '')}\n\n${newSignature}`;
      emailChanged = true;
    }
    if (emailChanged) {
      draftPatch.applicationEmail = email;
      changed.push('email');
    }
  }

  const identityChanged = ['firstName', 'lastName', 'phone', 'location'].some((key) => has(overrides, key));
  return {
    errors,
    changed: Object.keys(errors).length ? [] : changed,
    overrides,
    draftPatch,
    identityChanged,
    candidateText: written.join('\n'),
  };
}
