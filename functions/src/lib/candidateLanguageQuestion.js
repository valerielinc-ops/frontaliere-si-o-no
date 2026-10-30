/** Complete language-question grammar shared by source attestation and native proof selection. No candidate state. */
import { isLanguageAbilityQuestion, isLanguageNameOnly, languageCodesIn } from './languageFacts.js';

export const LANGUAGE_LEVEL_RE = /\b(?:level|proficiency|fluency|fluent|niveau|livello|grado|kenntnis|kenntnisse|maitrise|maîtrise)\b/i;
export const LANGUAGE_MODALITY_RE = /\b(?:written|schriftlich|ecrit|écrit|scritto|scritta)\b/i;
export const LANGUAGE_ORAL_RE = /\b(?:oral|spoken|muendlich|mündlich|parlato|parlata|parle|parlé)\b/i;

export function normalizeCandidateQuestionValue(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function isGeneralCandidateLanguageQuestion(value) {
  const text = normalizeCandidateQuestionValue(value).split(' ').map(word => languageCodesIn(word).length === 1 && isLanguageNameOnly(word) ? 'language_target' : word).join(' ');
  return /^(?:what is your (?:current )?(?:(?:written|spoken|oral) )?language_target (?:proficiency(?: level)?|fluency level|level)|what is your (?:current )?level of language_target|do you speak language_target(?: if so how would you describe your proficiency level)?|qual e il tuo (?:attuale )?livello di language_target|parli language_target|wie ist (?:ihr|dein) (?:aktuelles )?niveau in language_target|sprechen sie language_target|quel est votre niveau (?:actuel )?(?:en|de) language_target|parlez vous language_target)$/.test(text);
}

/** A portable level has no written/oral, future, employer or hidden-field qualifier. */
export function isPortableCandidateLanguageQuestion(question) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
  const text = String(question.question || '');
  const normalized = normalizeCandidateQuestionValue(text);
  const options = (Array.isArray(question.options) ? question.options : [])
    .flatMap(option => typeof option === 'string' ? [option] : [option?.label, option?.value])
    .map(normalizeCandidateQuestionValue).filter(Boolean);
  return languageCodesIn(text).length === 1 && isLanguageAbilityQuestion(text) && isGeneralCandidateLanguageQuestion(text)
    && LANGUAGE_LEVEL_RE.test(normalized) && !LANGUAGE_MODALITY_RE.test(normalized) && !LANGUAGE_ORAL_RE.test(normalized)
    && ['text', 'choice'].includes(question.type) && !options.some(option => /^(?:yes|no|si|ja|nein|oui|non|true|false)$/.test(option))
    && !question.context && !question.section && !question.autocomplete && !Object.hasOwn(question, 'addressContext')
    && question.source !== 'policy_default'
    && (!question.applicationQuestion || normalizeCandidateQuestionValue(question.applicationQuestion) === normalized);
}
