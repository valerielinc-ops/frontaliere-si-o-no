import { describe, expect, it } from 'vitest';
import { operationalAnswerForOption, isOperationalDefaultValue, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { validateAnswer } from '../functions/src/lib/answerRules.js';

const options = ['---', 'Nessuno / Rapporto di lavoro già terminato', '6 mesi', '5 mesi', '4 mesi', '3 mesi', '2 mesi', '1 mesi', 'Meno di 1 mese'];
const question = { id: 'notice', source: 'portal', question: 'Attuale periodo di preavviso', applicationQuestion: 'Attuale periodo di preavviso *', type: 'choice', required: true, options, applicationOptions: options };
const field = { id: 'native-notice', kind: 'select', label: question.applicationQuestion, required: true, options: options.map((label, i) => ({ label, value: `option-${i}` })) };

describe('notice duration projection onto the native catalogue', () => {
  it.each([
    ['3 months', '3 mesi'], ['3months', '3 mesi'], ['2 months', '2 mesi'], ['two months', '2 mesi'],
    ['2 Monate', '2 mesi'], ['deux mois', '2 mesi'], ['7 giorni', 'Meno di 1 mese'], ['27 days', 'Meno di 1 mese'],
  ])('projects %s without replacing the saved answer', (answer, expected) => {
    const saved = { notice: answer };
    const projection = withOperationalQuestionAnswers([question], saved);
    expect(projection.answers.notice).toBe(expected);
    expect(projection.defaults).toEqual({});
    expect(saved.notice).toBe(answer);
    expect(validateAnswer(expected, question).ok).toBe(true);
    const candidate = candidateForForm({ identity: {}, answers: saved, draft: {}, portalQuestions: [question] });
    expect(candidateAnswerForField(candidate, field)).toMatchObject({ value: expected, source: 'answers' });
    const guarded = guardPlan({ actions: [], missingRequired: [] }, [field], candidate);
    expect(guarded.missingRequired).toEqual([]);
    expect(guarded.actions).toContainEqual(expect.objectContaining({ fieldId: field.id, value: expected, source: 'answers' }));
  });

  it.each([
    ['Notice period', 'less than one month'], ['Kündigungsfrist', 'Weniger als einen Monat'],
    ['Délai de préavis', "Moins d’un mois"], ['Periodo di preavviso', 'Meno di un mese'],
  ])('recognizes only an explicit strict range in %s', (label, range) => {
    expect(operationalAnswerForOption({ question: label, type: 'choice', options: [range, '3 months'] }, '7 days')).toBe(range);
  });

  it.each(['0 days', '28 days', '30 days', '-3 months', '−3 months', '+3 months', '3+ months', '3 months+', '3½ months', '1½ months', '~3 months', '<3 months', '3–4 months', 'maximum 3 weeks', '2026-11-01'])('does not reinterpret %s', answer => {
    expect(operationalAnswerForOption(question, answer)).toBeNull();
    expect(withOperationalQuestionAnswers([question], { notice: answer }).answers.notice).toBe(answer);
  });

  it('rejects duplicate duration meanings and unrelated or conditional questions', () => {
    expect(operationalAnswerForOption({ ...question, options: ['3 mesi', 'three months'] }, '3 months')).toBeNull();
    expect(operationalAnswerForOption({ ...question, options: ['3+ months'] }, '3 months')).toBeNull();
    expect(operationalAnswerForOption({ ...question, options: ['Meno di 1 mese', 'Less than one month'] }, '7 days')).toBeNull();
    for (const label of ['Experience in months', 'Can you confirm a notice period of maximum 3 weeks?', 'Available from date', 'Work permit duration']) {
      expect(operationalAnswerForOption({ ...question, question: label, applicationQuestion: label }, '3 months')).toBeNull();
    }
  });

  it.each(['3+ months', '3 months+', '~3 months', '2.5 months', '3-4 months', 'about 3 months', '3½ months'])('does not authorize a nonexact policy action: %s', answer => {
    expect(isOperationalDefaultValue({ question: 'Notice period', type: 'text' }, answer)).toBe(false);
    expect(isOperationalDefaultValue({ question: 'Notice period', type: 'choice', options: ['3 months', answer] }, answer)).toBe(false);
  });

  it('validates canonical default equivalence against this exact field', () => {
    expect(isOperationalDefaultValue({ question: 'Notice period', type: 'text' }, '3months')).toBe(true);
    expect(isOperationalDefaultValue({ question: 'Notice period', type: 'text', validation: { pattern: '^3 months$' } }, '3months')).toBe(false);
    expect(isOperationalDefaultValue({ question: 'Notice period', type: 'choice', options: ['3 mesi'] }, '3 months')).toBe(false);
  });

  it('keeps the owner preference separate from explicit answers and CV facts', () => {
    const automatic = withOperationalQuestionAnswers([question], {});
    expect(automatic.answers.notice).toBe('3 mesi');
    expect(automatic.defaults.notice.source).toBe('policy_default');
    expect(withOperationalQuestionAnswers([question], { notice: '2 months' }).answers.notice).toBe('2 mesi');
    const original = { answers: { notice: '7 giorni' }, questionAnswers: { notice_period: '7 giorni' } };
    const before = structuredClone(original);
    candidateWithEdits({ order: {}, draft: { questions: [question] }, flow: original });
    expect(original).toEqual(before);
    const defaultOnly = candidateWithEdits({ order: {}, draft: { questions: [question], portalAnswers: { answers: [{ question: question.question, answer: '3 months', source: 'policy_default' }] } }, flow: {} });
    expect(defaultOnly.answers).toEqual({});
    expect(defaultOnly.profile.availability || '').toBe('');
  });
});
