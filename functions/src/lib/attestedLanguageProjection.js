/** Runtime projection only: a confirmation bound to these CV bytes can correct the same general language fact. */
import { isPortableCandidateLanguageQuestion } from './candidateLanguageQuestion.js';
import { isLanguageNameOnly, languageCodeOf, languageCodesIn } from './languageFacts.js';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const level = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const accepted = value => /^(?:[abc][12]|native|mother tongue|madrelingua|muttersprache|langue maternelle)$/.test(level(value));
const generalRow = row => isLanguageNameOnly(typeof row === 'string' ? row : row?.language)
  && !row?.modality && !row?.skill && !row?.context;
const codeOf = value => { const code = languageCodeOf(value); if (code) return code; const codes = languageCodesIn(value); return codes.length === 1 ? codes[0] : ''; };

export function projectAttestedLanguageFacts({ profile = {}, answerEvidence = [], currentCvHash = '' } = {}) {
  const projected = { ...profile, languages: (Array.isArray(profile.languages) ? profile.languages : []).map(row => row && typeof row === 'object' ? { ...row } : row) };
  const conflicts = [], facts = new Map();
  for (const record of Array.isArray(answerEvidence) ? answerEvidence : []) {
    if (record?.category !== 'language' || record.unit !== 'CEFR_or_stated_level' || record.scope !== 'candidate'
      || !['candidate', 'owner'].includes(record.provenance?.actor) || !Number.isFinite(record.provenance?.confirmedAt)
      || record.provenance.confirmedAt <= 0 || !accepted(record.answer) || !isPortableCandidateLanguageQuestion(record.question)) continue;
    const language = codeOf(record.question.question);
    if (language) facts.set(language, [...facts.get(language) || [], record]);
  }
  for (const [languageCode, records] of facts) {
    const newest = Math.max(...records.map(record => record.provenance.confirmedAt));
    const current = records.filter(record => record.provenance.confirmedAt === newest);
    const declarations = new Set(current.map(record => level(record.answer)));
    if (declarations.size !== 1) { conflicts.push({ languageCode, reason: 'conflicting_confirmations' }); continue; }
    if (new Set(current.map(record => record.provenance.cvHash || '')).size !== 1) {
      conflicts.push({ languageCode, reason: 'conflicting_cv_bindings' }); continue;
    }
    const record = current[0];
    const indices = projected.languages.map((row, index) => generalRow(row) && codeOf(typeof row === 'string' ? row : row.language) === languageCode ? index : -1).filter(index => index >= 0);
    if (indices.length && indices.every(index => level(projected.languages[index]?.level) === level(record.answer))) continue;
    // Copy/import timestamps and profile.updatedAt never establish factual recency.
    if (!hash(currentCvHash) || !hash(record.provenance.cvHash) || record.provenance.cvHash !== currentCvHash) {
      conflicts.push({ languageCode, reason: 'cv_binding_unknown_or_changed' });
      continue;
    }
    if (indices.length) for (const index of indices) {
      const previous = projected.languages[index];
      projected.languages[index] = { ...(typeof previous === 'object' ? previous : { language: previous }), level: String(record.answer).trim() };
    }
    else projected.languages.push({ language: languageCode, level: String(record.answer).trim() });
  }
  return { profile: projected, conflicts };
}
