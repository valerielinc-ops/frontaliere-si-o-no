/** Private Admin-produced proof for optional operational portal questions. */
export const PORTAL_NATIVE_CONTRACT_VERSION = 'native-contract-v1';
const OPERATIONAL_TOPICS = new Set(['recruitment_source', 'notice_period', 'preferred_workload', 'whatsapp_contact']);
const text = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

export function provenOptionalOperationalPortalQuestion(question) {
  const proof = question?.portalNativeContract;
  return question?.source === 'portal' && question.required === false && proof?.required === false
    && proof.version === PORTAL_NATIVE_CONTRACT_VERSION && proof.requiredEvidence === 'aria-required:false'
    && OPERATIONAL_TOPICS.has(proof.topic) && Number(proof.observedAt) > 0 && proof.frame === 0
    && Number.isInteger(proof.form) && proof.form >= 0 && Boolean(text(proof.fieldId))
    && text(proof.label) === text(question.applicationQuestion);
}
