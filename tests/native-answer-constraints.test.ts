import { describe, expect, it } from 'vitest';
import { nativeCvDomainConstraint, typedNativeAnswerConstraint } from '../functions/src/lib/nativeAnswerConstraints.js';

const native = { question: 'Do you need sponsorship?', context: 'Work authorization' };
const booleanRecord = { question: native, answer: false, unit: 'boolean', category: 'work_authorization' };
const claim = (value: string | number | boolean, question = native) => ({ nativeFormContract: question, proposedAnswer: value });
const languageRecord = { scope: 'candidate', question: { question: 'What is your current German level?', type: 'choice', options: ['A2', 'B1', 'B2', 'C1'] }, answer: 'A2', unit: 'CEFR_or_stated_level', category: 'language' };

describe('typed native answer constraints', () => {
  it('preserves actual No polarity instead of reading a printed Yes option', () => {
    const record = { ...booleanRecord, question: { ...native, options: ['Yes', 'No'] } };
    expect(typedNativeAnswerConstraint(claim('Yes'), record)).toBe('contradicts');
    expect(typedNativeAnswerConstraint(claim('No'), record)).toBe('supports');
    expect(typedNativeAnswerConstraint(claim(false), record)).toBe('supports');
  });
  it('does not reuse a different question, subject context or untyped raw value', () => {
    expect(typedNativeAnswerConstraint(claim(false, { ...native, context: 'Spouse authorization' }), booleanRecord)).toBe('unrelated');
    expect(typedNativeAnswerConstraint(claim(false, { ...native, question: 'Do you hold a work permit?' }), booleanRecord)).toBe('unrelated');
    expect(typedNativeAnswerConstraint(claim(false), { ...booleanRecord, answer: { option: 'No' } })).toBe('unknown');
  });
  it('reads a CEFR value only from the actual answer, never the question options', () => {
    const target = { question: 'Do you speak German at C1?', context: 'Languages' };
    expect(typedNativeAnswerConstraint(claim('Yes', target), languageRecord)).toBe('contradicts');
    expect(typedNativeAnswerConstraint(claim('No', target), languageRecord)).toBe('supports');
    expect(typedNativeAnswerConstraint(claim('Yes', target), { ...languageRecord, answer: 'C1' })).toBe('supports');
  });
  it('does not transfer language, future proficiency or a combined-language claim', () => {
    expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you speak English at C1?', context: '' }), languageRecord)).toBe('unrelated');
    expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you speak German and English at C1?', context: '' }), languageRecord)).toBe('contradicts');
    expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you speak German and English at C1?', context: '' }), { ...languageRecord, answer: 'C1' })).toBe('unknown');
    expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you speak German or French at C1?', context: '' }), { ...languageRecord, question: { question: 'What is your current French level?', type: 'choice', options: ['A2', 'B1', 'B2', 'C1'] }, answer: 'C1' })).toBe('supports');
    expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you speak German at C1?', context: '' }), { ...languageRecord, question: { question: 'What German level do you plan to reach after training?' }, answer: 'C1' })).toBe('unrelated');
  });
  it('does not promote scoped oral, future, written, credential or legal-domain facts to general ability', () => {
    for (const source of [
      { ...languageRecord, scope: 'job', question: { question: 'What is your current spoken German level?', type: 'choice' }, answer: 'C1' },
      { ...languageRecord, question: { question: 'What is your German level after training?', type: 'choice' }, answer: 'C1' },
    ]) expect(typedNativeAnswerConstraint(claim('Yes', { question: 'Do you write German at C1?', context: '' }), source)).not.toBe('supports');
    for (const question of ['Do you write legally binding contracts in German at C1?', 'Do you hold a German C1 certificate?']) {
      expect(typedNativeAnswerConstraint(claim('Yes', { question, context: '' }), { ...languageRecord, answer: 'C1' })).not.toBe('supports');
    }
  });
  it('keeps ownership missing, owned, other entity and unknown distinct', () => {
    const record = { ...booleanRecord, question: { ...native, addressContext: { section: 'Personal', owners: ['Candidate'], unknown: false } } };
    expect(typedNativeAnswerConstraint(claim(false), record)).toBe('unrelated');
    expect(typedNativeAnswerConstraint(claim(false, { ...native, addressContext: { section: 'Personal', owners: ['Employer'], unknown: false } } as any), record)).toBe('unrelated');
    expect(typedNativeAnswerConstraint(claim(false, { ...native, addressContext: { section: 'Personal', owners: ['Candidate'], unknown: true } } as any), record)).toBe('unknown');
    expect(typedNativeAnswerConstraint(claim(false, record.question), record)).toBe('supports');
  });
  it('keeps numeric actual values bound to the same owned question and context', () => {
    const question = { question: 'How many years have you worked as a physician?', context: 'Clinical experience' };
    const record = { question, answer: 8, unit: 'question_specific_number', category: 'experience' };
    expect(typedNativeAnswerConstraint(claim(8, question), record)).toBe('supports');
    expect(typedNativeAnswerConstraint(claim(10, question), record)).toBe('contradicts');
    expect(typedNativeAnswerConstraint(claim(8, { ...question, question: 'How many years have you worked as an IT manager?' }), record)).toBe('unrelated');
  });
  it('does not infer a current permit or sponsorship answer from a future status', () => {
    expect(nativeCvDomainConstraint(claim('Yes', { question: 'Do you currently hold a valid Swiss work permit?', context: '' }), { quote: 'Swiss permit application pending', context: '' })).toBe('unverified');
    expect(nativeCvDomainConstraint(claim('No'), { quote: 'I require employer sponsorship.', context: '' })).toBe('unverified');
    expect(nativeCvDomainConstraint(claim('Yes', { question: 'Do you hold a degree?', context: '' }), { quote: 'Degree in computer science', context: '' })).toBe('unknown');
  });
});
