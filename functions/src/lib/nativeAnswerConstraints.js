/** Typed answer constraints are stronger than an inference about a printed option. */
import { addressContextContract } from './addressContextContract.js';
import { isGeneralCandidateLanguageQuestion, isPortableCandidateLanguageQuestion, LANGUAGE_MODALITY_RE, LANGUAGE_ORAL_RE } from './candidateLanguageQuestion.js';
import { conciergeProposalEligibility } from '../assistedApplicationFitNotice.js';
import { isLanguageAbilityQuestion, isLanguageContextLabel, isLanguageNameOnly, languageCodesIn } from './languageFacts.js';
import { asksHeldStatus, EXPECTATION_RE, isPermitField } from './permitStatus.js';

const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const booleanValue = value => {
  if (typeof value === 'boolean') return value;
  const text = normalized(value);
  if (['yes', 'true', 'ja', 'oui', 'sì', 'si'].includes(text)) return true;
  if (['no', 'false', 'nein', 'non'].includes(text)) return false;
  return null;
};
const AMBIGUOUS_OPTION = Symbol('ambiguous native option');
function nativeOptionScalar(value, question) {
  if (typeof value === 'boolean' || !Array.isArray(question?.optionValues)) return value;
  const text = normalized(value);
  const matches = question.optionValues.filter(option => option && (normalized(option.label) === text
    || (Object.hasOwn(option, 'value') && normalized(option.value) === text)));
  if (matches.length > 1) return AMBIGUOUS_OPTION;
  return matches.length === 1 && typeof matches[0].label === 'string' ? matches[0].label : value;
}
const cefr = value => /^[ABC][12]$/u.test(String(value ?? '').trim().toUpperCase()) ? String(value).trim().toUpperCase() : '';
const questionText = question => String(question?.applicationQuestion || question?.question || '');
function originalQuestion(record) {
  const question = record.question || {};
  if (!Object.hasOwn(question, 'originalNativeContract')) return question;
  const original = question.originalNativeContract;
  if (!original || typeof original !== 'object' || Array.isArray(original) || !original.question) return null;
  return { ...question, ...original, applicationQuestion: original.question };
}
const context = question => [question?.context, question?.section, question?.autocomplete].map(normalized).join('\n');

const ownershipKeys = ['ownConsentText', 'ownConsentQuestionLabels', 'ownConsentLinks', 'ownConsentOwnerKey',
  'ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'consentOwnershipUnknown',
  'metadataComplete', 'questionOwned', 'ownershipUnknown'];
function ownedContractState(question) {
  const address = addressContextContract(question);
  if (address === null || address?.unknown || question?.ownershipUnknown === true
    || question?.metadataComplete === false || question?.questionOwned === false || question?.consentOwnershipUnknown === true
    || question?.ownConsentMetadataComplete === false || question?.ownConsentQuestionOwned === false) return null;
  return { address, flags: Object.fromEntries(ownershipKeys.filter(key => Object.hasOwn(question || {}, key)).map(key => [key, question[key]])) };
}
export function sameNativeQuestion(claim, record) {
  return normalized(questionText(originalQuestion(record))) === normalized(claim.nativeFormContract?.question);
}

/** Only complete personal, unqualified level questions may use a portable scalar fact. */
function portableTarget(question) {
  if (question.autocomplete || [question.context, question.section].some(value => value && !isLanguageContextLabel(value))) return false;
  const owned = ownedContractState(question);
  if (!owned) return false;
  if (owned.address && [owned.address.section, ...owned.address.owners].some(value => value
    && !isLanguageContextLabel(value) && !/^(?:personal (?:information|data|details)|candidate(?: information)?|applicant(?: information)?|dati personali|informazioni personali|persönliche (?:daten|angaben)|informations personnelles)$/iu.test(String(value).trim()))) return false;
  let text = String(question.question || '');
  if (LANGUAGE_MODALITY_RE.test(text) || LANGUAGE_ORAL_RE.test(text)) return false;
  const names = [...text.matchAll(/\p{L}+/gu)].filter(word => isLanguageNameOnly(word[0]));
  if (names.length > 1) {
    const bridges = names.slice(1).map((word, index) => text.slice(names[index].index + names[index][0].length, word.index).trim());
    if (!(bridges.every(value => /^(?:and|und|et|e|&)$/iu.test(value)) || bridges.every(value => /^(?:or|oder|ou|o)$/iu.test(value)))) return false;
    text = text.slice(0, names[0].index) + names[0][0] + text.slice(names.at(-1).index + names.at(-1)[0].length);
  }
  text = text.replace(/\b(?:at(?:\s+least)?|level|niveau|livello)\s+[ABC][12]\b/giu, ' ')
    .replace(/\b[ABC][12]\b/giu, ' ').replace(/\s+/gu, ' ').trim();
  return isGeneralCandidateLanguageQuestion(text);
}

/** supports / contradicts / unknown / unrelated, never an invented candidate gap. */
export function typedNativeAnswerConstraint(claim, record) {
  const native = claim.nativeFormContract || {};
  const original = originalQuestion(record);
  if (!original) return 'unknown';
  const actual = record.answer;
  const sourceOwnership = ownedContractState(original); const targetOwnership = ownedContractState(native);
  if (!sourceOwnership || !targetOwnership) return 'unknown';
  const exact = sameNativeQuestion(claim, record) && context(original) === context(native)
    && JSON.stringify(sourceOwnership) === JSON.stringify(targetOwnership);
  if (actual === null || typeof actual === 'object') return 'unknown';
  if (!exact && record.category === 'language' && ['CEFR', 'CEFR_or_stated_level'].includes(record.unit)) {
    if (record.scope !== 'candidate' || !isPortableCandidateLanguageQuestion(original) || !portableTarget(native)) return 'unrelated';
    const sourceQuestion = `${questionText(original)} ${original.context || ''}`;
    const nativeQuestion = `${native.question || ''} ${native.context || ''}`;
    const sourceCodes = languageCodesIn(sourceQuestion); const targetCodes = languageCodesIn(nativeQuestion);
    if (sourceCodes.length !== 1 || !targetCodes.includes(sourceCodes[0])
      || !isLanguageAbilityQuestion(sourceQuestion) || !isLanguageAbilityQuestion(nativeQuestion)) return 'unrelated';
    const held = cefr(actual);
    if (!held) return 'unknown';
    const directLevel = cefr(claim.proposedAnswer);
    if (directLevel) return targetCodes.length === 1 ? (directLevel === held ? 'supports' : 'contradicts') : 'unknown';
    const value = booleanValue(claim.proposedAnswer);
    if (value === null) return 'unknown';
    // Reuse the server's AND/OR and level guards. One attested language is
    // not a complete language list, so it never proves other languages absent.
    const result = conciergeProposalEligibility({ requirements: [{ requirement: native.question, quote: native.question,
      basis: 'stated', importance: 'high' }] }, { verdict: 'good', matches: [{ index: 0, status: 'met',
      evidence: `${sourceQuestion} Actual current level: ${held}`, evidenceUnverified: false }] },
    { profile: { languagesExplicitList: false, languages: [{ language: sourceCodes[0], level: held }] } });
    const supported = result.status === 'compatible' ? true
      : result.status === 'incompatible' && result.gaps?.some(gap => gap.knownMissing) ? false : null;
    return supported === null ? 'unknown' : value === supported ? 'supports' : 'contradicts';
  }
  if (!exact) return 'unrelated';
  if (record.category === 'language' && cefr(actual) && cefr(claim.proposedAnswer)) return cefr(actual) === cefr(claim.proposedAnswer) ? 'supports' : 'contradicts';
  const actualScalar = nativeOptionScalar(actual, original); const proposedScalar = nativeOptionScalar(claim.proposedAnswer, native);
  if (actualScalar === AMBIGUOUS_OPTION || proposedScalar === AMBIGUOUS_OPTION) return 'unknown';
  if (record.unit === 'boolean' || typeof actual === 'boolean'
    || (booleanValue(actualScalar) !== null && booleanValue(proposedScalar) !== null)) {
    const stated = booleanValue(actualScalar); const proposed = booleanValue(proposedScalar);
    if (stated === null || proposed === null) return 'unknown';
    return stated === proposed ? 'supports' : 'contradicts';
  }
  if (typeof actual === 'number' && typeof claim.proposedAnswer === 'number' && Number.isFinite(actual) && Number.isFinite(claim.proposedAnswer)) {
    return actual === claim.proposedAnswer ? 'supports' : 'contradicts';
  }
  return normalized(actual) && normalized(actual) === normalized(claim.proposedAnswer) ? 'supports' : 'unknown';
}

/** Existing permit-domain rules: a future status never proves a current one. */
export function nativeCvDomainConstraint(claim, source) {
  const nativeQuestion = `${claim.nativeFormContract?.question || ''} ${claim.nativeFormContract?.context || ''}`;
  if (!isPermitField(nativeQuestion)) return 'unknown';
  if (!asksHeldStatus(nativeQuestion)) return 'unverified';
  return EXPECTATION_RE.test(`${source.quote}\n${source.context || ''}`) ? 'unverified' : 'unknown';
}
