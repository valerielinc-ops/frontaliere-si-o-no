/**
 * A candidate's «I don't know» in the four languages: an answer that states no fact. Shared by the candidate's
 * edits (assistedApplicationCandidateEdits.js) and the platform facts (assistedApplicationPlatformDefaults.js),
 * which cannot import each other.
 */

function normalizeUnknownValue(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export const UNKNOWN_ANSWER_VALUES = new Set([
  'unknown', 'not known', 'not sure', 'i do not know', 'i don t know', 'i dont know', 'dont know', 'no idea',
  'non lo so', 'non so', 'non conosco', 'keine angabe', 'weiss nicht', 'weiß nicht', 'ich weiss es nicht', 'ich weiß es nicht', 'nicht bekannt',
  'je ne sais pas', 'je ne sais plus', 'inconnu', 'inconnue', 'non renseigne', 'non renseignee',
]);

export function isUnknownAnswer(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every(isUnknownAnswer);
  return typeof value === 'string' && UNKNOWN_ANSWER_VALUES.has(normalizeUnknownValue(value));
}
