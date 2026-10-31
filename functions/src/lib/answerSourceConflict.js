import { qualificationCounterContextHash } from './qualificationCounterContext.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** A withdrawn known property is uncertainty, never an old value or a positive declaration. */
export function answerConflictMetadata(record, reason, at, { key = record?.key, scope = record?.scope || record?.conflict?.scope } = {}) {
  if (!record || !['candidate', 'job'].includes(scope)) return null;
  if (record.cleared && record.conflict) {
    const { key: conflictKey, property, languageCode, cvHash } = record.conflict;
    return { key: conflictKey, property, languageCode, scope, cvHash, reason, at };
  }
  const language = /^language_([a-z]{2})_any_proficiency$/.exec(key || '');
  const fact = object(record.fact);
  const typed = ['birth_date', 'experience_duration', 'credential_held', 'permit_status'].includes(fact.type)
    && ['subject', 'unit', 'relation'].every(field => typeof fact[field] === 'string' && fact[field].length <= 100);
  if (scope === 'candidate' && !language && !typed) return null;
  return { key, property: language ? 'language_proficiency' : typed
    ? [fact.type, fact.subject, fact.unit, fact.relation, fact.jurisdiction || ''].join('|') : record.question?.originalNativeContract
      ? `native_contract_sha256:${qualificationCounterContextHash(record.question.originalNativeContract)}` : 'question_answer',
    languageCode: language ? language[1] : '', scope,
    cvHash: /^[a-f0-9]{64}$/.test(record.provenance?.cvHash || '') ? record.provenance.cvHash : '', reason, at };
}
