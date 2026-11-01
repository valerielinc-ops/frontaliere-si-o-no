import {
  candidateQuestionOptionsFingerprint,
  candidateQuestionTextFingerprint,
} from '../../../functions/src/assistedApplicationCandidateEdits.js';

/**
 * Candidate-safe question metadata for runner events. Keep the ATS prompt and
 * fingerprints for long prompts or oversized native option lists so
 * translations and bounded payloads preserve the answer ledger's identity.
 */
export function questionDetailsForEvent(rawQuestions, getPortalQuestionKey = () => '') {
  return (Array.isArray(rawQuestions) ? rawQuestions : []).map((question) => {
    if (!question || typeof question !== 'object') return null;
    const id = typeof question.id === 'string' || typeof question.id === 'number' ? String(question.id).trim() : '';
    const label = String(question.question || '').trim();
    if (!id || !label) return null;
    const result = { id, question: label.slice(0, 240) };
    const applicationQuestion = String(question.applicationQuestion || question.portalQuestion || '').trim();
    if (applicationQuestion) result.applicationQuestion = applicationQuestion.slice(0, 240);
    const questionIdentityFingerprint = candidateQuestionTextFingerprint(question);
    if (questionIdentityFingerprint) result.questionIdentityFingerprint = questionIdentityFingerprint;
    for (const key of ['context', 'section']) {
      const value = String(question[key] || '').trim();
      if (value) result[key] = value.slice(0, 240);
    }
    const autocomplete = String(question.autocomplete || '').trim();
    if (autocomplete) result.autocomplete = autocomplete.slice(0, 100);
    const type = String(question.type || '').trim();
    if (type) result.type = type.slice(0, 40);
    const semanticKey = getPortalQuestionKey(question);
    if (semanticKey) result.semanticKey = semanticKey.slice(0, 500);
    const applicationOptionsFingerprint = candidateQuestionOptionsFingerprint(question);
    if (applicationOptionsFingerprint) result.applicationOptionsFingerprint = applicationOptionsFingerprint;
    if (Array.isArray(question.options) && question.options.length) {
      result.options = question.options.slice(0, 40).map((option) => {
        if (typeof option === 'string') return option.slice(0, 160);
        if (!option || typeof option !== 'object') return String(option ?? '').slice(0, 160);
        return {
          ...(option.label ? { label: String(option.label).slice(0, 160) } : {}),
          ...(option.value ? { value: String(option.value).slice(0, 160) } : {}),
        };
      });
    }
    if (Array.isArray(question.applicationOptions) && question.applicationOptions.length) {
      result.applicationOptions = question.applicationOptions.slice(0, 40).map((option) => {
        if (typeof option === 'string') return option.slice(0, 160);
        if (!option || typeof option !== 'object') return String(option ?? '').slice(0, 160);
        return {
          ...(option.label ? { label: String(option.label).slice(0, 160) } : {}),
          ...(option.value ? { value: String(option.value).slice(0, 160) } : {}),
        };
      });
    }
    return result;
  }).filter(Boolean);
}
