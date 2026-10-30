import { describe, expect, it } from 'vitest';
import { isGeneralCandidateLanguageQuestion, isPortableCandidateLanguageQuestion } from '../functions/src/lib/candidateLanguageQuestion.js';

describe('pure language-question portability contract', () => {
  it.each(['What is your English proficiency level?', 'Qual è il tuo livello di inglese?', 'Wie ist Ihr Niveau in Englisch?', 'Quel est votre niveau en anglais?'])('recognises only the complete general level question: %s', question => {
    expect(isPortableCandidateLanguageQuestion({ question, type: 'text' })).toBe(true);
  });
  it.each(['What is your written English proficiency level?', 'What is your spoken English proficiency level?'])('keeps modality grammar separate from global portability: %s', question => {
    expect(isGeneralCandidateLanguageQuestion(question)).toBe(true);
    expect(isPortableCandidateLanguageQuestion({ question, type: 'text' })).toBe(false);
  });
  it.each(['What is your English proficiency level after training?', 'What is your written English proficiency in legal drafting?', 'Is your English proficiency sufficient to negotiate legal contracts?', 'What is your desired English proficiency level?'])('never silently drops a qualifier: %s', question => {
    expect(isPortableCandidateLanguageQuestion({ question, type: 'text' })).toBe(false);
  });
  it.each([{ context: 'Written translations' }, { section: 'Employer requirements' }, { autocomplete: 'other' }, { addressContext: { section: '', owners: [], unknown: false } }, { applicationQuestion: 'What is your English level for legal negotiation?' }, { source: 'policy_default' }, { type: 'yes_no' }, { type: 'choice', options: ['Yes', 'No'] }])('does not erase field metadata or a binary scale: %j', metadata => {
    expect(isPortableCandidateLanguageQuestion({ question: 'What is your English proficiency level?', type: 'text', ...metadata })).toBe(false);
  });
});
