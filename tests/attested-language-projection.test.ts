import { describe, expect, it } from 'vitest';
import { projectAttestedLanguageFacts } from '../functions/src/lib/attestedLanguageProjection.js';
const cvHash = 'a'.repeat(64), otherHash = 'b'.repeat(64), now = Date.now();
const profile = { languages: [{ language: 'English', level: 'A2' }, { language: 'German', level: 'B2' }] };
const proof = { id: 'synthetic', question: { id: 'english', question: 'What is your English proficiency level?', type: 'text' }, answer: 'C1', category: 'language', unit: 'CEFR_or_stated_level', scope: 'candidate', provenance: { actor: 'candidate', confirmedAt: now, cvHash } };
describe('attested general language facts against actual CV bytes', () => {
  it('projects the current C1 over A2 from the same CV without mutating its stored profile', () => {
    const result = projectAttestedLanguageFacts({ profile, answerEvidence: [proof], currentCvHash: cvHash });
    expect(result.conflicts).toEqual([]);
    expect(result.profile.languages).toEqual([{ language: 'English', level: 'C1' }, { language: 'German', level: 'B2' }]);
    expect(profile.languages[0].level).toBe('A2');
  });
  it('does not make a later byte-identical copy or profile parsing timestamp factually newer', () => {
    const result = projectAttestedLanguageFacts({ profile: { ...profile, updatedAt: now + 1000, cvUploadedAt: now + 2000 }, answerEvidence: [proof], currentCvHash: cvHash });
    expect(result.profile.languages[0].level).toBe('C1');
    expect(result.conflicts).toEqual([]);
  });
  it.each([otherHash, '', undefined])('does not override a conflicting CV when its binding is different or unknown: %s', currentCvHash => {
    const result = projectAttestedLanguageFacts({ profile, answerEvidence: [proof], currentCvHash });
    expect(result.profile.languages[0].level).toBe('A2');
    expect(result.conflicts).toEqual([{ languageCode: 'en', reason: 'cv_binding_unknown_or_changed' }]);
  });
  it.each([{ scope: 'job' }, { unit: 'boolean', answer: 'Yes' }, { question: { ...proof.question, question: 'What is your written English proficiency level?' } }, { question: { ...proof.question, question: 'What is your English proficiency level after training?' } }, { question: { ...proof.question, context: 'For this employer' } }])('does not transfer a nonportable declaration into another target profile: %j', patch => {
    const result = projectAttestedLanguageFacts({ profile, answerEvidence: [{ ...proof, ...patch }], currentCvHash: cvHash });
    expect(result).toEqual({ profile, conflicts: [] });
  });
  it('does not choose arbitrarily between conflicting simultaneous confirmations', () => {
    const result = projectAttestedLanguageFacts({ profile, answerEvidence: [proof, { ...proof, answer: 'B1' }], currentCvHash: cvHash });
    expect(result.conflicts).toEqual([{ languageCode: 'en', reason: 'conflicting_confirmations' }]);
    expect(result.profile.languages[0].level).toBe('A2');
  });
});
