import {
  candidateQuestionOptionsFingerprint,
  candidateQuestionTextFingerprint,
} from '../../../functions/src/assistedApplicationCandidateEdits.js';
import { ASSISTED_APPLICATION_RUNNER_EVENT_ARRAY_LIMIT } from '../../../functions/src/assistedApplicationConstants.js';

// Firestore runner events are bounded well below the 1 MiB document ceiling,
// leaving room for metadata and future event fields. The backend consumes at
// most 20 question descriptors, so producers never serialize more than that.
export const MAX_RUNNER_EVENT_BYTES = 512 * 1024;
export const MAX_RUNNER_EVENT_QUESTION_DETAILS = ASSISTED_APPLICATION_RUNNER_EVENT_ARRAY_LIMIT;

/**
 * Candidate-safe question metadata for runner events. Keep the ATS prompt and
 * fingerprints for long prompts or oversized native option lists so
 * translations and bounded payloads preserve the answer ledger's identity.
 */
export function questionDetailsForEvent(rawQuestions, getPortalQuestionKey = () => '') {
  return (Array.isArray(rawQuestions) ? rawQuestions.slice(0, MAX_RUNNER_EVENT_QUESTION_DETAILS) : []).map((question) => {
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

/** Bound the serialized Firestore envelope, not just each question field. */
export function boundRunnerEvent(event, maxBytes = MAX_RUNNER_EVENT_BYTES) {
  const payload = event && typeof event === 'object' ? event : {};
  const encodedBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const boundedPayload = Array.isArray(payload.questionDetails)
    ? { ...payload, questionDetails: payload.questionDetails.slice(0, MAX_RUNNER_EVENT_QUESTION_DETAILS) }
    : payload;
  if (encodedBytes(boundedPayload) <= maxBytes) return boundedPayload;
  if (!Array.isArray(boundedPayload.questionDetails) || boundedPayload.questionDetails.length === 0) {
    throw new RangeError('runner_event_payload_too_large');
  }

  const { questionDetails, ...base } = boundedPayload;
  const selected = [];
  const fits = candidate => encodedBytes({ ...base, questionDetails: candidate }) <= maxBytes;
  if (!fits(selected)) throw new RangeError('runner_event_payload_too_large');
  for (const detail of questionDetails.slice(0, MAX_RUNNER_EVENT_QUESTION_DETAILS)) {
    const candidate = [...selected, detail];
    if (fits(candidate)) selected.push(detail);
  }
  const bounded = selected.length ? { ...base, questionDetails: selected } : base;
  if (encodedBytes(bounded) > maxBytes) throw new RangeError('runner_event_payload_too_large');
  return bounded;
}
