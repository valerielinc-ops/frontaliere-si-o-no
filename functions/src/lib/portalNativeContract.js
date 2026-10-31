/** Private Admin-produced proof for optional operational portal questions. */
export const PORTAL_NATIVE_CONTRACT_VERSION = 'native-contract-v1';
const OPERATIONAL_TOPICS = new Set(['recruitment_source', 'notice_period', 'preferred_workload', 'whatsapp_contact']);
const text = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

const canonicalUrl = value => { try { return new URL(String(value || '')).href; } catch { return ''; } };
export function provenOptionalOperationalPortalQuestion(question, draft) {
  const proof = question?.portalNativeContract;
  const applyUrl = canonicalUrl(draft?.channel?.applyUrl || draft?.job?.applyUrl);
  return Boolean(applyUrl) && canonicalUrl(proof?.url) === applyUrl
    && Number.isInteger(Number(draft?.round)) && Number(draft.round) > 0 && Number(proof?.round) === Number(draft.round)
    && question?.source === 'portal' && question.required === false && proof?.required === false
    && proof.version === PORTAL_NATIVE_CONTRACT_VERSION && proof.requiredEvidence === 'aria-required:false'
    && OPERATIONAL_TOPICS.has(proof.topic) && Number(proof.observedAt) > 0 && proof.frame === 0
    && Number.isInteger(proof.form) && proof.form >= 0 && Boolean(text(proof.fieldId))
    && text(proof.label) === text(question.applicationQuestion);
}
