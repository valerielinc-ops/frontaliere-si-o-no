import { describe, expect, it } from 'vitest';
import { SENSITIVE, guardPlan, holdsValue, knownValuesOf, ownConsent, planSystemPrompt, PLAN_SCHEMA, questionFromLabel } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { permitStatement } from '../functions/src/lib/permitStatus.js';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, chooseFiles, findButton } from '../scripts/assisted-application/lib/portal/fill.mjs';
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

  // Giro di prova 2026-10-01: JOIN asks "Che sesso sei?" with an "N/A" option.
  it('reads "sesso" as a demographic question that only "N/A" may answer by rule', () => {
    const sex = { id: 's1', kind: 'select', label: 'Che sesso sei?', required: true, options: [{ label: 'Maschio' }, { label: 'Femmina' }, { label: 'N/A' }] };
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const declined = guardPlan({ actions: [{ fieldId: 's1', action: 'select', value: 'N/A', document: 'none', source: 'rule' }], missingRequired: [] }, [sex], candidate);
    expect(declined.actions).toHaveLength(1);
    const guessed = guardPlan({ actions: [{ fieldId: 's1', action: 'select', value: 'Maschio', document: 'none', source: 'rule' }], missingRequired: [] }, [sex], candidate);
    expect(guessed.actions).toEqual([]);
    expect(guessed.missingRequired.map((item: any) => item.fieldId)).toEqual(['s1']);
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

  it('ticks the application’s own required consent in code when the plan leaves it, and nothing else', () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const fields = [
      { id: 'c1', kind: 'checkbox', label: 'I agree to the Privacy Policy Statement', required: true, checked: false },
      { id: 'c2', kind: 'checkbox', label: 'Newsletter gemäss Datenschutzerklärung abonnieren', required: true, checked: false },
      { id: 'c3', kind: 'checkbox', label: 'I hold a valid work permit and accept the privacy policy', required: true, checked: false },
      { id: 'c4', kind: 'checkbox', label: 'Datenschutzerklärung gelesen', required: false, checked: false },
      { id: 'c5', kind: 'checkbox', label: 'Ho letto l’informativa privacy e acconsento al trattamento dei dati', required: true, checked: false },
    ];
    // umantis, 2026-10-03: the planner skipped the required privacy box, and the candidate was asked it as a text question.
    const guarded = guardPlan({
      actions: [{ fieldId: 'c1', action: 'skip', source: 'rule', value: '' }, { fieldId: 'c5', action: 'uncheck', source: 'rule', value: '' }],
      missingRequired: [{ fieldId: 'c1', question: 'Accetti l’informativa?', why: '', type: 'yes_no', options: [] }],
    }, fields, candidate);
    expect(guarded.actions.filter((action: any) => action.action === 'check').map((action: any) => [action.fieldId, action.source])).toEqual([['c1', 'consent'], ['c5', 'consent']]);
    // A required marketing box and one that also declares a fact stay questions; an optional box is left alone.
    expect(guarded.missingRequired.map((item: any) => item.fieldId).sort()).toEqual(['c2', 'c3']);
    expect(ownConsent(fields[3])).toBe(false);
    expect(ownConsent({ kind: 'text', label: 'Privacy', required: true })).toBe(false);
    // The choice on what happens to the data afterwards is the planner's, by rule: never kept for other openings.
    expect(planSystemPrompt('it')).toContain('select the option that deletes it');
  });

  // umantis, 2026-10-03: the letter was still at 15% when the CV went in and the send button was reached.
  it('waits for a file the form sends as soon as it is chosen, and only a moment when it sends nothing', async () => {
    const run = async (requests: Array<{ at: number; until: number; method?: string }>) => {
      let clock = 0;
      const handlers: Record<string, Set<(request: any) => void>> = { request: new Set(), requestfinished: new Set(), requestfailed: new Set() };
      const live = requests.map((item) => ({ ...item, method: () => item.method || 'POST', started: false, ended: false }));
      const page = {
        on: (event: string, handler: any) => handlers[event].add(handler),
        off: (event: string, handler: any) => handlers[event].delete(handler),
        waitForTimeout: async (ms: number) => {
          clock += ms;
          for (const request of live) {
            if (!request.started && clock >= request.at) { request.started = true; handlers.request.forEach((handler) => handler(request)); }
            if (request.started && !request.ended && clock >= request.until) { request.ended = true; handlers.requestfinished.forEach((handler) => handler(request)); }
          }
        },
      };
      const chosen: any[] = [];
      await chooseFiles(page as any, { setInputFiles: async (paths: any) => { chosen.push(paths); } } as any, '/tmp/cv.pdf', { now: () => clock });
      return { clock, chosen, listeners: Object.values(handlers).reduce((sum, set) => sum + set.size, 0) };
    };
    // Nothing leaves on the choice (the file goes with the submit): the quiet moment only, and no listener left.
    const plain = await run([]);
    expect(plain.chosen).toEqual(['/tmp/cv.pdf']);
    expect(plain.clock).toBeGreaterThanOrEqual(700);
    expect(plain.clock).toBeLessThan(1200);
    expect(plain.listeners).toBe(0);
    // An upload that starts at once and takes 5 s is waited for.
    const upload = await run([{ at: 150, until: 5000 }]);
    expect(upload.clock).toBeGreaterThanOrEqual(5700);
    expect(upload.clock).toBeLessThan(6500);
    // Sent in two pieces with a short gap: both.
    expect((await run([{ at: 150, until: 2000 }, { at: 2300, until: 4000 }])).clock).toBeGreaterThanOrEqual(4600);
    // A plain GET (an image, a script) is nobody's upload; a request that never ends is not waited for ever.
    expect((await run([{ at: 150, until: 9000, method: 'GET' }])).clock).toBeLessThan(1200);
    const stuck = await run([{ at: 150, until: Infinity }]);
    expect(stuck.clock).toBeGreaterThanOrEqual(45_000);
    expect(stuck.clock).toBeLessThan(47_000);
  });

  it('plans a JOIN date picker from the candidate date and asks when it is absent', () => {
    const date = { id: 'dob', kind: 'date', label: 'Quando sei nato?', required: true, value: '' };
    const candidate = { answers: {}, profile: { dateOfBirth: '12.05.1990' }, portalQuestionsAnswered: [] };
    const filled = guardPlan({ actions: [{ fieldId: 'dob', action: 'fill', value: '1990-05-12', source: 'profile' }], missingRequired: [] }, [date], candidate);
    expect(filled).toEqual({ actions: [expect.objectContaining({ fieldId: 'dob', action: 'fill', value: '1990-05-12' })], missingRequired: [] });
    expect(holdsValue({ ...date, value: '1990-05-12' })).toBe(true);

    const missing = guardPlan({ actions: [], missingRequired: [] }, [date], { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(missing.missingRequired).toEqual([expect.objectContaining({ fieldId: 'dob', type: 'date', question: 'Quando sei nato?' })]);
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
    // Giro di prova 2026-10-01: JOIN's review page ends with «Conferma e applica».
    for (const text of ['Conferma e applica', 'Confirm and apply', 'Bestätigen und bewerben', 'Confirmer et postuler', 'Candidati']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Continua', 'Indietro', 'Modifica', 'Applica filtro']) expect(SUBMIT_RE.test(text)).toBe(false);
    // Review of #10725: the whole label, so a filter control is never the submission.
    for (const text of ['Conferma e applica filtro', 'Confirm and apply filters', 'Bestätigen und bewerben später']) expect(SUBMIT_RE.test(text)).toBe(false);
    for (const text of ['Conferma e applica →', 'Confirm and submit']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Thank you for applying!', 'Vielen Dank für Ihre Bewerbung', 'La candidatura è stata inviata', 'Votre candidature a bien été envoyée']) expect(CONFIRM_RE.test(text)).toBe(true);
    // The same thanks in more words (an ATS in English, 2026-10-03).
    for (const text of ['Thank you very much for your application', 'Many thanks for your application!']) expect(CONFIRM_RE.test(text)).toBe(true);
    // JOIN says "du"/"tu".
    for (const text of ['Grazie per esserti candidato!', 'Vielen Dank für deine Bewerbung']) expect(CONFIRM_RE.test(text)).toBe(true);
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

// Owner decisions of 2026-10-03 (P4, decision 9): the planner gets the Swiss status as a sentence, the guard reads
// permit, work-authorisation, nationality and citizenship fields in four languages, and a code rule picks the one
// option that says exactly the candidate's status.
describe('portal: the candidate’s Swiss status and nationality', () => {
  const identity = { name: 'Giulia Verdi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '+39 333 000 0000' };
  const candidate = (profile: Record<string, any> = {}, answers: Record<string, string> = {}, portalQuestions: any[] = []) => candidateForForm({ identity, profile, answers, portalQuestions, language: 'de' });
  const select = (fieldId: string, value: string, source = 'rule') => ({ fieldId, action: 'select', value, document: 'none', source, evidence: '' });
  const permitField = (label: string, options: string[]) => ({ id: 'p1', kind: 'select', label, required: true, options: options.map((option) => ({ label: option })) });

  it('reads permit, work-authorisation, nationality and citizenship fields as sensitive, never a licence or a country', () => {
    for (const label of ['Nazionalità', 'Cittadinanza', 'Arbeitserlaubnis', 'Are you legally authorised to work in Switzerland?', 'Do you have the right to work in Switzerland?',
      'Will you require sponsorship?', 'Avez-vous un permis de travail valable en Suisse ?', 'Staatsangehörigkeit', 'Citizenship', 'Qual è il suo stato di autorizzazione al lavoro per Svizzera?']) {
      expect([label, SENSITIVE.test(label)]).toEqual([label, true]);
    }
    for (const label of ['Permis de conduire', 'Country']) expect([label, SENSITIVE.test(label)]).toEqual([label, false]);
  });

  it('never ticks a consent that also declares a work authorisation or a citizenship', () => {
    const box = (label: string) => ownConsent({ kind: 'checkbox', required: true, label });
    expect(box('Ich habe eine gültige Arbeitserlaubnis und akzeptiere die Datenschutzerklärung')).toBe(false);
    expect(box('I am authorised to work in Switzerland and accept the privacy policy')).toBe(false);
    expect(box('Ho la cittadinanza svizzera e accetto l’informativa privacy')).toBe(false);
    expect(box('Ho letto l’informativa privacy e acconsento al trattamento dei dati')).toBe(true);
    expect(box('Do il permesso al trattamento dei dati')).toBe(true);
  });

  it('picks the one option that says exactly the status the candidate chose, whatever the plan chose', () => {
    const field = permitField('Arbeitsbewilligung *', ['B (Aufenthalter)', 'C (Niedergelassene)', 'G (Grenzgänger)', 'Schweizer/in']);
    const picked = guardPlan({ actions: [select('p1', 'B (Aufenthalter)')], missingRequired: [] }, [field], candidate({ permitStatus: 'permit_g' }));
    expect(picked).toEqual({ actions: [select('p1', 'G (Grenzgänger)')], missingRequired: [] });
    const asked = guardPlan({ actions: [], missingRequired: [{ fieldId: 'p1', question: 'Bewilligung?', why: '', type: 'choice', options: [] }] }, [field], candidate({ permitStatus: 'permit_g' }));
    expect(asked).toEqual({ actions: [select('p1', 'G (Grenzgänger)')], missingRequired: [] });
    // «none» is a status too: the option that says no permit is held.
    const none = guardPlan({ actions: [], missingRequired: [] }, [permitField('Bewilligung', ['Keine', 'B', 'G'])], candidate({ permitStatus: 'none' }));
    expect(none.actions).toEqual([select('p1', 'Keine')]);
    // A field that asks what the candidate needs is never answered by the code, nor two options that say the same.
    expect(guardPlan({ actions: [], missingRequired: [] }, [permitField('Welche Bewilligung benötigen Sie?', ['Keine', 'B', 'G'])], candidate({ permitStatus: 'none' })).actions).toEqual([]);
    expect(guardPlan({ actions: [], missingRequired: [] }, [permitField('Bewilligung', ['G (Grenzgänger)', 'Ausweis G EU/EFTA'])], candidate({ permitStatus: 'permit_g' })).actions).toEqual([]);
  });

  it('keeps a permit answer only when it names the candidate’s own status, never a «Ja» that occurs in the data', () => {
    const question = 'Haben Sie eine gültige Arbeitsbewilligung?';
    const yesNo = permitField(question, ['Ja', 'Nein']);
    // «Ja» answers another question of the candidate: the substring rule read it as backing this one.
    for (const permitStatus of ['none', 'permit_b']) {
      const guarded = guardPlan({ actions: [select('p1', 'Ja', 'answers')], missingRequired: [] }, [yesNo], candidate({ permitStatus }, { portal_fuehrerschein: 'Ja' }));
      expect([permitStatus, guarded.actions, guarded.missingRequired.map((item: any) => item.fieldId)]).toEqual([permitStatus, [], ['p1']]);
    }
    // The candidate's own answer to this very question.
    const answered = candidate({ permitStatus: 'none' }, { portal_bewilligung: 'Ja' }, [{ id: 'portal_bewilligung', question }]);
    expect(guardPlan({ actions: [select('p1', 'Ja', 'answers')], missingRequired: [] }, [yesNo], answered).actions).toEqual([select('p1', 'Ja', 'answers')]);
    // Nothing chosen: only the CV's own words.
    const gb = permitField('Work permit', ['G', 'B']);
    expect(guardPlan({ actions: [select('p1', 'G', 'profile')], missingRequired: [] }, [gb], candidate({ workPermit: 'Permesso G' })).actions).toEqual([select('p1', 'G', 'profile')]);
    expect(guardPlan({ actions: [select('p1', 'G', 'profile')], missingRequired: [] }, [gb], candidate({})).missingRequired.map((item: any) => item.fieldId)).toEqual(['p1']);
    // A text field filled with the candidate's own statement.
    const text = { id: 't1', kind: 'text', label: 'Aufenthaltsstatus', required: true };
    const fill = { fieldId: 't1', action: 'fill', value: permitStatement('permit_b', 'de'), document: 'none', source: 'profile', evidence: '' };
    expect(guardPlan({ actions: [fill], missingRequired: [] }, [text], candidate({ permitStatus: 'permit_b' })).actions).toEqual([fill]);
  });

  it('keeps a nationality only when it names the one the candidate gave, Swiss for the status «swiss»', () => {
    const field = { id: 'n1', kind: 'select', label: 'Nationalität', required: true, options: [{ label: 'Italien' }, { label: 'Deutschland' }, { label: 'Schweiz' }] };
    expect(guardPlan({ actions: [select('n1', 'Italien', 'profile')], missingRequired: [] }, [field], candidate({ nationality: 'italiana' })).actions).toEqual([select('n1', 'Italien', 'profile')]);
    expect(guardPlan({ actions: [select('n1', 'Deutschland', 'profile')], missingRequired: [] }, [field], candidate({ nationality: 'italiana' })).missingRequired.map((item: any) => item.fieldId)).toEqual(['n1']);
    expect(guardPlan({ actions: [select('n1', 'Schweiz', 'profile')], missingRequired: [] }, [field], candidate({ permitStatus: 'swiss' })).actions).toEqual([select('n1', 'Schweiz', 'profile')]);
  });

  it('gives the planner the status as a sentence outside the data the substring rule reads, and the birth date as the portals read it', () => {
    const form = candidateForForm({
      identity, profile: { permitStatus: 'permit_b', workPermit: 'Permesso G', dateOfBirth: '14. März 2010' }, answers: { work_permit: 'x', salary_expectation: 'CHF 80k' }, language: 'de',
    });
    expect(form.swissStatus).toEqual({ code: 'permit_b', statement: 'Ich habe eine heute gültige Aufenthaltsbewilligung B.' });
    expect(form.profile).toMatchObject({ workPermit: '', dateOfBirth: '2010-03-14' });
    expect(form.answers).toEqual({ salary_expectation: 'CHF 80k' });
    const known = knownValuesOf(form);
    expect(known).not.toContain('aufenthaltsbewilligung');
    expect(known).not.toContain('permesso g');
    expect(planSystemPrompt('it')).toContain('swissStatus.statement is the candidate\'s own statement of their Swiss status today');
  });
});
