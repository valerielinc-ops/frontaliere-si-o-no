import { describe, expect, it } from 'vitest';
import { guardPlan, holdsValue, planSystemPrompt, PLAN_SCHEMA, questionFromLabel } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, findButton } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { candidateForForm, slugId, WAVE1_CHANNELS } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { personalValuesOf } from '../scripts/assisted-application/lib/secure-run.mjs';

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
    // The country the plan got wrong is not left blank either: it is asked too.
    expect(guarded.missingRequired).toEqual([
      expect.objectContaining({ fieldId: 'f2', type: 'choice', options: ['G', 'B'] }),
      expect.objectContaining({ fieldId: 'f4', question: 'Country', type: 'choice', options: ['Switzerland', 'Italy'] }),
    ]);
  });

  it('keeps sensitive answers that come from the candidate', () => {
    const guarded = guardPlan({ actions: [{ fieldId: 'f2', action: 'select', value: 'G', document: 'none', source: 'answers' }], missingRequired: [] }, fields);
    expect(guarded.actions).toHaveLength(1);
    // Only the required fields this partial plan leaves out are asked.
    expect(guarded.missingRequired.map((item) => item.fieldId)).toEqual(['f1', 'f4', 'f5']);
  });

  it('lets a required demographic question be declined, and checks values against the candidate data', () => {
    const gender = { id: 'g1', kind: 'select', label: 'Geschlecht* (erforderlich)', required: true, options: [{ label: 'Männlich' }, { label: 'Weiblich' }, { label: 'Keine Angabe' }] };
    const declined = guardPlan({ actions: [{ fieldId: 'g1', action: 'select', value: 'Keine Angabe', document: 'none', source: 'rule' }], missingRequired: [] }, [gender]);
    expect(declined).toEqual({ actions: [expect.objectContaining({ value: 'Keine Angabe' })], missingRequired: [] });
    // "profile" claimed as the source, but the value is nowhere in the candidate's data.
    const invented = guardPlan(
      { actions: [{ fieldId: 'g1', action: 'select', value: 'Weiblich', document: 'none', source: 'profile' }], missingRequired: [] },
      [gender],
      { answers: {}, profile: { headline: 'Infermiera' }, portalQuestionsAnswered: [] },
    );
    expect(invented.actions).toEqual([]);
    expect(invented.missingRequired).toEqual([expect.objectContaining({ fieldId: 'g1', question: 'Geschlecht', options: ['Männlich', 'Weiblich', 'Keine Angabe'] })]);
    expect(questionFromLabel('Do you have a working permit?*')).toBe('Do you have a working permit?');
  });

  it('never takes an empty answer as the candidate’s: a required field stays a question', () => {
    const fields = [
      { id: 'f1', kind: 'text', label: 'Nationality', required: true },
      { id: 'f2', kind: 'text', label: 'Stadt', required: true },
      { id: 'f3', kind: 'text', label: 'Zweiter Vorname', required: false },
    ];
    const candidate = { answers: {}, profile: { nationality: '', city: '' }, portalQuestionsAnswered: [] };
    const plan = {
      actions: [
        { fieldId: 'f1', action: 'fill', source: 'profile', value: '' },
        { fieldId: 'f2', action: 'fill', source: 'profile', value: '  ' },
        { fieldId: 'f3', action: 'fill', source: 'rule', value: '' },
      ],
      missingRequired: [],
    };
    const guarded = guardPlan(plan, fields, candidate);
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired.map((item: any) => item.fieldId)).toEqual(['f1', 'f2']);
    expect(guarded.missingRequired[0]).toMatchObject({ question: 'Nationality', type: 'text' });
  });

  it('turns a required field the plan skips or omits into a question, unless the page already holds a value', () => {
    const fields = [
      { id: 'f1', kind: 'text', label: 'Nationality', required: true, value: '' },
      { id: 'f2', kind: 'text', label: 'Telefon', required: true, value: '' },
      { id: 'f3', kind: 'text', label: 'E-Mail', required: true, value: 'c-abcdefghjk@candidature.frontaliereticino.ch' },
      { id: 'f4', kind: 'listbox', label: 'Land', required: true, value: 'Select One' },
      { id: 'f5', kind: 'select', label: 'Anrede', required: true, value: '-1', options: [{ value: '-1', label: 'Bitte wählen' }, { value: 'f', label: 'Frau' }] },
      { id: 'f6', kind: 'checkbox', label: 'Datenschutz', required: true, checked: false },
      { id: 'f7', kind: 'text', label: 'Zweiter Vorname', required: false, value: '' },
    ];
    const plan = {
      actions: [
        { fieldId: 'f1', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f3', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f4', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f6', action: 'check', source: 'consent', value: '' },
      ],
      missingRequired: [],
    };
    const guarded = guardPlan(plan, fields, { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(guarded.missingRequired.map((item: any) => item.fieldId)).toEqual(['f1', 'f2', 'f4', 'f5']);
    expect(guarded.actions).toEqual([
      { fieldId: 'f3', action: 'skip', source: 'rule', value: '' },
      { fieldId: 'f6', action: 'check', source: 'consent', value: '' },
    ]);
    // What the page holds after the action counts: a dropdown set to its prompt, a required box unticked.
    const projected = guardPlan({
      actions: [
        { fieldId: 'p1', action: 'select', source: 'profile', value: 'Select One' },
        { fieldId: 'p2', action: 'uncheck', source: 'consent', value: '' },
        { fieldId: 'p3', action: 'uncheck', source: 'consent', value: '' },
      ],
      missingRequired: [],
    }, [
      { id: 'p1', kind: 'select', label: 'Country', required: true, value: '', options: [{ value: '', label: 'Select One' }, { value: 'ch', label: 'Switzerland' }] },
      { id: 'p2', kind: 'checkbox', label: 'Datenschutz', required: true, checked: true },
      { id: 'p3', kind: 'checkbox', label: 'Newsletter', required: false, checked: true },
    ], { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(projected.actions).toEqual([{ fieldId: 'p3', action: 'uncheck', source: 'consent', value: '' }]);
    expect(projected.missingRequired.map((item: any) => item.fieldId)).toEqual(['p1', 'p2']);
    expect(holdsValue({ kind: 'select', value: 'f', options: [{ value: 'f', label: 'Frau' }] })).toBe(true);
    expect(holdsValue({ kind: 'listbox', value: 'Italien' })).toBe(true);
    expect(holdsValue({ kind: 'text', value: '-- Seleziona --' })).toBe(false);
    expect(holdsValue({ kind: 'file', value: '' })).toBe(false);
  });

  it('asks each missing field once and never a field the plan already answers', () => {
    const guarded = guardPlan({
      actions: [{ fieldId: 'f1', action: 'fill', value: 'Luca', document: 'none', source: 'identity' }],
      missingRequired: [
        { fieldId: 'f2', question: 'Permesso?', why: '', type: 'choice', options: ['G', 'B'] },
        { fieldId: 'f2', question: 'Permesso di lavoro?', why: '', type: 'choice', options: ['G', 'B'] },
        { fieldId: 'f1', question: 'Nome?', why: '', type: 'text', options: [] },
      ],
    }, fields);
    expect(guarded.missingRequired.map((item) => item.fieldId)).toEqual(['f2', 'f4', 'f5']);
    expect(guarded.missingRequired[0].question).toBe('Permesso?');
    // A field the plan skips and also lists as missing is still asked, with the plan's question.
    const skipped = guardPlan({
      actions: [{ fieldId: 'f4', action: 'skip', value: '', document: 'none', source: 'identity' }],
      missingRequired: [{ fieldId: 'f4', question: 'In quale Paese vivi?', why: '', type: 'choice', options: ['Switzerland', 'Italy'] }],
    }, fields);
    expect(skipped.missingRequired.filter((item) => item.fieldId === 'f4')).toEqual([expect.objectContaining({ question: 'In quale Paese vivi?' })]);
    expect(skipped.actions).toEqual([]);
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
      profile: {
        location: 'Como', workPermit: '', experience: [{ role: 'Infermiera', employer: 'Clinica' }],
        address: { street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' }, nationality: 'italiana',
      },
      answers: { work_permit: 'G', portal_start_date: '1.12.2026' },
      draft: { formAnswers: [{ key: 'motivationShort', value: 'Motivo' }], coverLetter: { text: 'Lettera' } },
      portalQuestions: [{ id: 'portal_start_date', question: 'Start date?' }],
    });
    expect(candidate.identity).toMatchObject({ firstName: 'Maria Anna', lastName: 'Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch' });
    expect(candidate.identity.address).toEqual({ street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' });
    expect(candidate.profile).toMatchObject({ nationality: 'italiana', dateOfBirth: '' });
    expect(candidate.portalQuestionsAnswered).toEqual([{ question: 'Start date?', answer: '1.12.2026' }]);
    expect(candidate.texts).toMatchObject({ motivationShort: 'Motivo', coverLetter: 'Lettera' });
  });

  it('masks the address, birth date and nationality read from the CV in the Actions log', () => {
    const profile = { address: { street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' }, dateOfBirth: '01.01.1990', nationality: 'italiana' };
    expect(personalValuesOf({}, profile)).toEqual(expect.arrayContaining(['Via Roma 1', '22100', 'Como', '01.01.1990', 'italiana']));
  });

  it('recognises next, submit, confirmation and validation in four languages', () => {
    for (const text of ['Next', 'Weiter', 'Avanti', 'Suivant', 'Save and continue']) expect(NEXT_RE.test(text)).toBe(true);
    for (const text of ['Submit application', 'Bewerbung absenden', 'Invia candidatura', 'Envoyer ma candidature', 'Postuler']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Thank you for applying!', 'Vielen Dank für Ihre Bewerbung', 'La candidatura è stata inviata', 'Votre candidature a bien été envoyée']) expect(CONFIRM_RE.test(text)).toBe(true);
    expect(VALIDATION_RE.test('Dieses Feld ist ein Pflichtfeld')).toBe(true);
    expect(findButton([{ id: 'b1', text: 'Cancel' }, { id: 'b2', text: 'Weiter' }], NEXT_RE)).toEqual({ id: 'b2', text: 'Weiter' });
    // A disabled submit (required fields still empty) is not clicked, but the runner can see it.
    const disabled = [{ id: 'b3', text: 'Bewerbung senden', disabled: true }];
    expect(findButton(disabled, SUBMIT_RE)).toBeNull();
    expect(findButton(disabled, SUBMIT_RE, { includeDisabled: true })).toEqual(disabled[0]);
    expect(slugId('Wann können Sie beginnen?')).toBe('wann_konnen_sie_beginnen');
    expect(WAVE1_CHANNELS.has('workday')).toBe(true);
    expect(WAVE1_CHANNELS.has('linkedin')).toBe(false);
  });
});
