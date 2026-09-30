import { describe, expect, it } from 'vitest';
import { guardPlan, planSystemPrompt, PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, findButton } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { candidateForForm, slugId, WAVE1_CHANNELS } from '../scripts/assisted-application/lib/portal/portal.mjs';

const fields = [
  { id: 'f1', kind: 'text', label: 'First name', required: true },
  { id: 'f2', kind: 'select', label: 'Work permit *', required: true, options: [{ label: 'G' }, { label: 'B' }] },
  { id: 'f3', kind: 'text', label: 'Salary expectation', required: false },
  { id: 'f4', kind: 'select', label: 'Country', required: true, options: [{ label: 'Switzerland' }, { label: 'Italy' }] },
  { id: 'f5', kind: 'file', label: 'Resume/CV', required: true },
];

describe('portal plan guard (career-ops apply rules in code)', () => {
  it('drops invented sensitive answers and turns the required ones into questions', () => {
    const guarded = guardPlan({
      actions: [
        { fieldId: 'f1', action: 'fill', value: 'Luca', document: 'none', source: 'identity' },
        { fieldId: 'f2', action: 'select', value: 'G', document: 'none', source: 'rule' },
        { fieldId: 'f3', action: 'fill', value: 'CHF 90k', document: 'none', source: 'rule' },
        { fieldId: 'f4', action: 'select', value: 'Germany', document: 'none', source: 'profile' },
        { fieldId: 'f5', action: 'upload', value: '', document: 'cv', source: 'documents' },
        { fieldId: 'ghost', action: 'fill', value: 'x', document: 'none', source: 'identity' },
      ],
      missingRequired: [],
    }, fields);
    expect(guarded.actions.map((action) => action.fieldId)).toEqual(['f1', 'f5']);
    expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: 'f2', type: 'choice', options: ['G', 'B'] })]);
  });

  it('keeps sensitive answers that come from the candidate', () => {
    const guarded = guardPlan({ actions: [{ fieldId: 'f2', action: 'select', value: 'G', document: 'none', source: 'answers' }], missingRequired: [] }, fields);
    expect(guarded.actions).toHaveLength(1);
    expect(guarded.missingRequired).toEqual([]);
  });

  it('asks the questions in the candidate’s language and uses a strict schema', () => {
    expect(planSystemPrompt('de')).toContain('written in German for the candidate');
    expect(PLAN_SCHEMA.additionalProperties).toBe(false);
    expect(PLAN_SCHEMA.required).toEqual(['actions', 'missingRequired']);
  });
});

describe('portal runner helpers', () => {
  it('uses the alias as the e-mail and keeps sensitive data only from the candidate', () => {
    const candidate = candidateForForm({
      identity: { name: 'Maria Anna Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '+41 79 000 00 00' },
      profile: { location: 'Como', workPermit: '', experience: [{ role: 'Infermiera', employer: 'Clinica' }] },
      answers: { work_permit: 'G', portal_start_date: '1.12.2026' },
      draft: { formAnswers: [{ key: 'motivationShort', value: 'Motivo' }], coverLetter: { text: 'Lettera' } },
      portalQuestions: [{ id: 'portal_start_date', question: 'Start date?' }],
    });
    expect(candidate.identity).toMatchObject({ firstName: 'Maria Anna', lastName: 'Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch' });
    expect(candidate.portalQuestionsAnswered).toEqual([{ question: 'Start date?', answer: '1.12.2026' }]);
    expect(candidate.texts).toMatchObject({ motivationShort: 'Motivo', coverLetter: 'Lettera' });
  });

  it('recognises next, submit, confirmation and validation in four languages', () => {
    for (const text of ['Next', 'Weiter', 'Avanti', 'Suivant', 'Save and continue']) expect(NEXT_RE.test(text)).toBe(true);
    for (const text of ['Submit application', 'Bewerbung absenden', 'Invia candidatura', 'Envoyer ma candidature', 'Postuler']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Thank you for applying!', 'Vielen Dank für Ihre Bewerbung', 'La candidatura è stata inviata', 'Votre candidature a bien été envoyée']) expect(CONFIRM_RE.test(text)).toBe(true);
    expect(VALIDATION_RE.test('Dieses Feld ist ein Pflichtfeld')).toBe(true);
    expect(findButton([{ id: 'b1', text: 'Cancel' }, { id: 'b2', text: 'Weiter' }], NEXT_RE)).toEqual({ id: 'b2', text: 'Weiter' });
    expect(slugId('Wann können Sie beginnen?')).toBe('wann_konnen_sie_beginnen');
    expect(WAVE1_CHANNELS.has('workday')).toBe(false);
  });
});
