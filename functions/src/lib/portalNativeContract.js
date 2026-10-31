import { hasConsentContradiction, privacySemanticIdentifiers } from './applicationConsent.js';

/** Private Admin-produced proof for optional operational portal questions. */
export const PORTAL_NATIVE_CONTRACT_VERSION = 'native-contract-v1';
const OPERATIONAL_TOPICS = new Set(['recruitment_source', 'notice_period', 'preferred_workload', 'whatsapp_contact', 'privacy_review_ack']);
const text = value => ['string', 'number'].includes(typeof value) ? String(value).normalize('NFC').replace(/\s+/g, ' ').trim() : '';

const canonicalUrl = value => { try { return new URL(String(value || '')).href; } catch { return ''; } };
export function provenOptionalOperationalPortalQuestion(question, draft) {
  const proof = question?.portalNativeContract;
  const applyUrl = canonicalUrl(draft?.channel?.applyUrl || draft?.job?.applyUrl);
  const privacyText = [question?.applicationQuestion, question?.question, proof?.label,
    ...(Array.isArray(question?.labels) ? question.labels : []), ...(Array.isArray(proof?.labels) ? proof.labels : [])]
    .map(text).filter(Boolean).join(' ');
  const privacyIdentifiers = privacySemanticIdentifiers(question, proof);
  const privacyContractSafe = proof?.topic !== 'privacy_review_ack'
    || !hasConsentContradiction(privacyText, question, proof, ...privacyIdentifiers);
  return Boolean(applyUrl) && canonicalUrl(proof?.url) === applyUrl
    && Number.isInteger(Number(draft?.round)) && Number(draft.round) > 0 && Number(proof?.round) === Number(draft.round)
    && question?.source === 'portal' && question.required === false && proof?.required === false
    && proof.version === PORTAL_NATIVE_CONTRACT_VERSION && proof.requiredEvidence === 'aria-required:false'
    && OPERATIONAL_TOPICS.has(proof.topic) && Number(proof.observedAt) > 0 && proof.frame === 0
    && Number.isInteger(proof.form) && proof.form >= 0 && Boolean(text(proof.fieldId))
    && text(proof.label) === text(question.applicationQuestion) && privacyContractSafe;
}
