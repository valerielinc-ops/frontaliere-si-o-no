/** Current-job declarations can defer an obsolete CV shortfall without becoming portable/global facts. */
import { isGeneralCandidateLanguageQuestion, isPortableCandidateLanguageQuestion, LANGUAGE_MODALITY_RE, LANGUAGE_ORAL_RE } from './candidateLanguageQuestion.js';
import { isLanguageNameOnly, languageCodeOf, languageCodesIn } from './languageFacts.js';
import { nativeScopeAllows } from './nativeFormContract.js';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const level = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const accepted = value => /^(?:[abc][12]|native|mother tongue|madrelingua|muttersprache|langue maternelle)$/.test(level(value));
const languageGroupCaption = value => /^(?:languages?|language skills|language proficiency|language knowledge|sprachkenntnisse|sprachen|conoscenze linguistiche|competenze linguistiche|lingue|connaissances linguistiques|competences linguistiques|langues)$/.test(level(value));
const generalQuestion = value => isGeneralCandidateLanguageQuestion(value) && !LANGUAGE_MODALITY_RE.test(value) && !LANGUAGE_ORAL_RE.test(value);
const codeOf = value => { const code = languageCodeOf(value); if (code) return code; const codes = languageCodesIn(value); return codes.length === 1 ? codes[0] : ''; };
const generalRow = row => isLanguageNameOnly(typeof row === 'string' ? row : row?.language) && !row?.modality && !row?.skill && !row?.context;
const sameJob = (source, job) => Boolean(source?.jobUrl && source.jobUrl === String(job?.url || job?.jobUrl || '')
  && (!source.jobId || !String(job?.id || job?.jobId || '') || source.jobId === String(job.id || job.jobId)));

/** Input records have already passed the source/receipt/retention loader. The original CV remains primary. */
export function currentJobLanguageEvidence({ profile = {}, answerEvidence = [], currentCvHash = '', job = {}, verifiedAnswerIds = [] } = {}) {
  const projected = { ...profile, languages: (Array.isArray(profile.languages) ? profile.languages : []).map(row => row && typeof row === 'object' ? { ...row } : row) };
  const deferredCodes = new Set(); const conflicts = []; const candidates = new Map();
  const verifiedIds = new Set((Array.isArray(verifiedAnswerIds) ? verifiedAnswerIds : []).filter(id => typeof id === 'string' && id));
  const portable = (Array.isArray(answerEvidence) ? answerEvidence : []).filter(record => record?.category === 'language'
    && record.scope === 'candidate' && record.unit === 'CEFR_or_stated_level' && accepted(record.answer)
    && ['candidate', 'owner'].includes(record.provenance?.actor) && Number.isFinite(record.provenance?.confirmedAt)
    && record.provenance.confirmedAt > 0 && isPortableCandidateLanguageQuestion(record.question));
  for (const record of Array.isArray(answerEvidence) ? answerEvidence : []) {
    const question = record?.question; const native = question?.originalNativeContract;
    if (record?.category !== 'language' || record.scope !== 'job' || !['CEFR_or_stated_level', 'question_specific_text'].includes(record.unit)
      || !['candidate', 'owner'].includes(record.provenance?.actor) || !Number.isFinite(record.provenance?.confirmedAt)
      || record.provenance.confirmedAt <= 0 || !sameJob(record.provenance, job) || typeof record.answer !== 'string' || !record.answer.trim()
      || !['text', 'choice'].includes(question?.type) || !generalQuestion(question?.question || '')
      || !native || !generalQuestion(native.question || '') || ['checkbox', 'radio_group_binary'].includes(native.kind)) continue;
    const code = codeOf(question.question);
    if (!code || codeOf(native.question) !== code) continue;
    const graph = native.ownedScopes ?? native.nativeOwnedScopes;
    if (!Array.isArray(graph)) { conflicts.push({ languageCode: code, reason: 'native_scope_unverified' }); continue; }
    // A legal/domain/future or modal context does not become a general language assertion.
    const ownScope = value => languageGroupCaption(value) || generalQuestion(value) && codeOf(value) === code || isLanguageNameOnly(value) && codeOf(value) === code;
    if (!nativeScopeAllows(native, ownScope)) continue;
    if (!nativeScopeAllows({ ...native, context: [native.context, question.context].filter(Boolean).join(' · '),
      section: [native.section, question.section].filter(Boolean).join(' · ') }, ownScope)) {
      conflicts.push({ languageCode: code, reason: 'candidate_scope_unverified' }); continue;
    }
    candidates.set(code, [...candidates.get(code) || [], record]);
  }
  for (const [languageCode, records] of candidates) {
    const newest = Math.max(...records.map(record => record.provenance.confirmedAt));
    const current = records.filter(record => record.provenance.confirmedAt === newest);
    if (new Set(current.map(record => level(record.answer))).size !== 1 || new Set(current.map(record => record.provenance.cvHash || '')).size !== 1) {
      conflicts.push({ languageCode, reason: 'conflicting_confirmations' }); continue;
    }
    const record = current.find(item => verifiedIds.has(item.id)) || current[0];
    if (portable.some(item => codeOf(item.question.question) === languageCode && item.provenance.confirmedAt >= newest
      && (level(item.answer) !== level(record.answer) || item.provenance.cvHash !== record.provenance.cvHash))) {
      conflicts.push({ languageCode, reason: 'conflicting_current_portable_confirmation' }); continue;
    }
    const indices = projected.languages.map((row, index) => generalRow(row) && codeOf(typeof row === 'string' ? row : row.language) === languageCode ? index : -1).filter(index => index >= 0);
    if (accepted(record.answer) && indices.length && indices.every(index => level(projected.languages[index]?.level) === level(record.answer))) continue;
    if (!hash(currentCvHash) || !hash(record.provenance.cvHash) || record.provenance.cvHash !== currentCvHash) {
      conflicts.push({ languageCode, reason: 'cv_binding_unknown_or_changed' }); continue;
    }
    if (verifiedIds.has(record.id) && accepted(record.answer)) {
      // The caller binds these exact IDs to supported independent witness units for this job.
      // This runtime-only projection grants no portability and never changes the original CV catalog.
      for (const index of indices) projected.languages[index] = { ...(typeof projected.languages[index] === 'object' ? projected.languages[index] : { language: languageCode }), level: record.answer.trim() };
      if (!indices.length) projected.languages.push({ language: languageCode, level: record.answer.trim() });
      continue;
    }
    // UNKNOWN is not C1. The matcher and independent judge must establish any positive claim
    // from the complete current-job Q/A, while the unchanged original CV remains in its catalog.
    for (const index of indices) projected.languages[index] = { language: languageCode, level: '' };
    if (!indices.length) projected.languages.push({ language: languageCode, level: '' });
    deferredCodes.add(languageCode);
  }
  return { profile: projected, deferredCodes: [...deferredCodes].sort(), conflicts };
}
