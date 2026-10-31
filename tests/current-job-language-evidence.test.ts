import { describe, expect, it } from 'vitest';
import { currentJobLanguageEvidence } from '../functions/src/lib/currentJobLanguageEvidence.js';
const now = Date.now(); const hash = 'a'.repeat(64); const job = { id: 'target', url: 'https://example.test/target/' };
const profile = { languages: [{ language: 'en', level: 'A2' }, { language: 'de', level: 'B2' }] };
const record = (label = 'What is your English proficiency level?', extra: any = {}) => ({ id: 'fixture', category: 'language', scope: 'job', unit: 'CEFR_or_stated_level', answer: 'C1',
  question: { question: label, type: 'text', originalNativeContract: { question: label, kind: 'text', context: '', section: '', options: [], ownedScopes: [] } },
  provenance: { actor: 'candidate', confirmedAt: now, cvHash: hash, jobId: job.id, jobUrl: job.url }, ...extra });
describe('current job language evidence without a global fact projection', () => {
  it('makes only the obsolete current-job CV row unknown pending independent adjudication', () => {
    const qa = record(); const original = structuredClone({ profile, qa });
    const result = currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: hash, job });
    expect(result.profile.languages).toEqual([{ language: 'en', level: '' }, { language: 'de', level: 'B2' }]);
    expect(result.deferredCodes).toEqual(['en']); expect(result.conflicts).toEqual([]);
    expect({ profile, qa }).toEqual(original); expect(qa.scope).toBe('job');
  });
  it('keeps full native contextual text for the judge instead of inferring a CEFR fact from its value', () => {
    const qa = record(undefined, { answer: 'Fluent', unit: 'question_specific_text' });
    qa.question.originalNativeContract.section = 'Language skills';
    expect(currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: hash, job }).deferredCodes).toEqual(['en']);
  });
  it.each(['other_job', 'domain', 'future', 'written', 'binary'])('does not neutralize a general CV row with %s evidence', change => {
    const qa: any = record();
    if (change === 'other_job') qa.provenance.jobUrl = 'https://example.test/other/';
    if (change === 'domain') qa.question.originalNativeContract.context = 'Legal drafting for this employer';
    if (change === 'future') qa.question.question = qa.question.originalNativeContract.question = 'What is your English proficiency after training?';
    if (change === 'written') qa.question.question = qa.question.originalNativeContract.question = 'What is your written English proficiency level?';
    if (change === 'binary') { qa.question.type = 'yes_no'; qa.answer = 'Yes'; qa.unit = 'boolean'; }
    const result = currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: hash, job });
    expect(result.profile).toEqual(profile); expect(result.deferredCodes).toEqual([]);
  });
  it.each(['missing_cv', 'changed_cv', 'missing_scope'])('returns unresolved source uncertainty for %s without a false shortfall', change => {
    const qa: any = record(); if (change === 'missing_scope') delete qa.question.originalNativeContract.ownedScopes;
    const result = currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: change === 'missing_cv' ? '' : change === 'changed_cv' ? 'b'.repeat(64) : hash, job });
    expect(result.profile).toEqual(profile); expect(result.conflicts).toEqual([expect.objectContaining({ languageCode: 'en' })]);
  });
  it('keeps an unchanged current explicit A2 available for a genuine C1 shortfall', () => {
    const result = currentJobLanguageEvidence({ profile, answerEvidence: [record(undefined, { answer: 'A2' })], currentCvHash: hash, job });
    expect(result.profile).toEqual(profile); expect(result.deferredCodes).toEqual([]);
  });
  it('projects only the exact independently supported newest record at runtime for this job', () => {
    const qa = record(); const original = structuredClone({ profile, qa });
    const result = currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: hash, job, verifiedAnswerIds: [qa.id] });
    expect(result.profile.languages).toEqual([{ language: 'en', level: 'C1' }, { language: 'de', level: 'B2' }]);
    expect(result.deferredCodes).toEqual([]); expect(result.conflicts).toEqual([]);
    expect({ profile, qa }).toEqual(original); expect(qa.scope).toBe('job');
    expect(currentJobLanguageEvidence({ profile, answerEvidence: [qa], currentCvHash: hash, job, verifiedAnswerIds: ['other'] }).deferredCodes).toEqual(['en']);
  });
  it('does not project an older verified answer or an open-ended level as a closed CEFR fact', () => {
    const old = record(); const current = record(undefined, { id: 'new', provenance: { ...old.provenance, confirmedAt: now + 1 }, answer: 'B1' });
    expect(currentJobLanguageEvidence({ profile, answerEvidence: [old, current], currentCvHash: hash, job, verifiedAnswerIds: [old.id] }).deferredCodes).toEqual(['en']);
    const freeText = record(undefined, { answer: 'Fluent', unit: 'question_specific_text' });
    expect(currentJobLanguageEvidence({ profile, answerEvidence: [freeText], currentCvHash: hash, job, verifiedAnswerIds: [freeText.id] }).deferredCodes).toEqual(['en']);
  });
  it.each([0, 1])('does not overwrite a tied/newer contradictory candidate-wide fact (delta=%i)', delta => {
    const qa = record(); const candidate = { ...qa, id: 'portable', scope: 'candidate', answer: 'A2',
      question: { question: qa.question.question, type: 'text' }, provenance: { ...qa.provenance, confirmedAt: now + delta } };
    for (const evidence of [[qa, candidate], [candidate, qa]]) {
      const result = currentJobLanguageEvidence({ profile, answerEvidence: evidence, currentCvHash: hash, job, verifiedAnswerIds: [qa.id] });
      expect(result.profile).toEqual(profile); expect(result.conflicts).toEqual([{ languageCode: 'en', reason: 'conflicting_current_portable_confirmation' }]);
    }
  });
});
