/** Typed answer constraints are stronger than an inference about a printed option. */
import { isLanguageAbilityQuestion, languageCodesIn } from './languageFacts.js';
import { asksHeldStatus, EXPECTATION_RE, isPermitField } from './permitStatus.js';

const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const booleanValue = value => {
  if (typeof value === 'boolean') return value;
  const text = normalized(value);
  if (['yes', 'true', 'ja', 'oui', 'sì', 'si'].includes(text)) return true;
  if (['no', 'false', 'nein', 'non'].includes(text)) return false;
  return null;
};
const cefr = value => ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(String(value ?? '').trim().toUpperCase());
const questionText = question => String(question?.applicationQuestion || question?.question || '');
const context = question => [question?.context, question?.section, question?.autocomplete].map(normalized).join('\n');

/** supports / contradicts / unknown / unrelated, never an invented candidate gap. */
export function typedNativeAnswerConstraint(claim, record) {
  const native = claim.nativeFormContract || {};
  const original = record.question || {};
  const actual = record.answer;
  if (actual === null || typeof actual === 'object') return 'unknown';
  if (record.category === 'language' && ['CEFR', 'CEFR_or_stated_level'].includes(record.unit)) {
    const sourceQuestion = `${questionText(original)} ${original.context || ''}`;
    const nativeQuestion = `${native.question || ''} ${native.context || ''}`;
    const sourceCodes = languageCodesIn(sourceQuestion); const targetCodes = languageCodesIn(nativeQuestion);
    if (sourceCodes.length !== 1 || targetCodes.length !== 1 || sourceCodes[0] !== targetCodes[0]
      || !isLanguageAbilityQuestion(sourceQuestion) || !isLanguageAbilityQuestion(nativeQuestion)) return 'unrelated';
    const held = cefr(actual);
    if (held < 0) return 'unknown';
    const valueRank = cefr(claim.proposedAnswer);
    if (valueRank >= 0) return valueRank === held ? 'supports' : 'contradicts';
    const value = booleanValue(claim.proposedAnswer);
    const levels = [...new Set([...nativeQuestion.matchAll(/\b[ABC][12]\b/giu)].map(match => cefr(match[0])))];
    if (value === null || levels.length !== 1) return 'unknown';
    return value === (held >= levels[0]) ? 'supports' : 'contradicts';
  }
  if (normalized(questionText(original)) !== normalized(native.question) || context(original) !== context(native)) return 'unrelated';
  if (record.unit === 'boolean' || typeof actual === 'boolean') {
    const stated = booleanValue(actual); const proposed = booleanValue(claim.proposedAnswer);
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
