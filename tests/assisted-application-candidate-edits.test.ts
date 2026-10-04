import { describe, expect, it } from 'vitest';
import {
  candidateWithEdits,
  factSourcesNow,
  fieldView,
  formAnswersWithEdits,
  planCandidateEdits,
} from '../functions/src/assistedApplicationCandidateEdits.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

const LETTER = [
  'Gentili Signore e Signori,',
  'Mi candido per il posto di infermiera: ho lavorato sei anni in reparto e ho assistito 30 persone al giorno.',
  'Conosco bene il lavoro a turni e la documentazione clinica. Sarei felice di presentarmi di persona.',
  'Cordiali saluti',
].join('\n\n');

const order = { applicantName: 'Maria Rossi', applicantEmail: 'maria@example.com', applicantPhone: '+41 79 123 45 67', candidateAlias: { active: true, address: 'maria.rossi.k7p2@candidature.frontaliereticino.ch' } };

function draft(extra: Record<string, any> = {}) {
  return {
    status: 'ready',
    round: 1,
    profile: { fullName: 'Maria Rossi', location: 'Como', linkedin: '', languages: [{ language: 'Italiano', level: 'madrelingua' }], workPermit: 'G' },
    channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply' },
    coverLetter: { subject: 'Candidatura', salutation: 'Gentili Signore e Signori,', paragraphs: [], closing: 'Cordiali saluti', text: LETTER },
    applicationEmail: { to: '', subject: 'Candidatura infermiera', body: 'Buongiorno, allego la mia candidatura.\n\nMaria Rossi\nmaria.rossi.k7p2@candidature.frontaliereticino.ch\n+41 79 123 45 67' },
    formAnswers: [
      { key: 'motivationShort', label: 'Motivazione', value: 'Mi motiva il reparto.' },
      { key: 'whyCompany', label: 'Perché', value: 'Clinica vicina.' },
    ],
    questions: [],
    ...extra,
  };
}

const plan = (raw: any, options: Record<string, any> = {}) => planCandidateEdits(raw, { order, draft: draft(options.draft), flow: options.flow || { answers: {} }, locale: 'it' });

describe('candidate edits', () => {
  it('reads the candidate with their corrections over the order and the CV', () => {
    const flow = { answers: {}, formOverrides: { firstName: 'Maria Luisa', lastName: 'Rossi', phone: '+41 91 000 00 00', location: 'Varese', languages: 'Italiano C2, Tedesco B2', salary: 'CHF 80k', unknown: 'x' } };
    const edited = candidateWithEdits({ order, draft: draft(), flow });
    expect(edited.identity).toMatchObject({ name: 'Maria Luisa Rossi', firstName: 'Maria Luisa', lastName: 'Rossi', phone: '+41 91 000 00 00', email: 'maria.rossi.k7p2@candidature.frontaliereticino.ch' });
    expect(edited.profile).toMatchObject({ location: 'Varese', languages: [{ language: 'Italiano C2', level: '' }, { language: 'Tedesco B2', level: '' }] });
    expect(edited.answers).toEqual({ salary_expectation: 'CHF 80k' });
    expect(edited.overrides).not.toHaveProperty('unknown');
    // A correction replaces an older answer; a question the draft asks again wins over it.
    const stale = { answers: { work_permit: 'old', availability: 'old', salary_expectation: 'old' }, formOverrides: { workPermit: 'new', availability: 'soon', salary: '90000' } };
    expect(candidateWithEdits({ order, draft: draft(), flow: stale }).answers).toEqual({ work_permit: 'new', availability: 'soon', salary_expectation: '90000' });
    const asking = draft({ questions: [{ id: 'salary_expectation', question: 'Pretese?', type: 'text', required: true }] });
    expect(candidateWithEdits({ order, draft: asking, flow: { ...flow, answers: { salary_expectation: 'CHF 90k' } } }).answers.salary_expectation).toBe('CHF 90k');
    const fields = Object.fromEntries(formAnswersWithEdits({ order, draft: draft(), flow }).map((field) => [field.key, field.value]));
    expect(fields).toMatchObject({ firstName: 'Maria Luisa', lastName: 'Rossi', phone: '+41 91 000 00 00', location: 'Varese', salary: 'CHF 80k', motivationShort: 'Mi motiva il reparto.' });
  });

  it('keeps the alias and the fields a question asks locked, with the reason', () => {
    const current = draft({ questions: [{ id: 'work_permit', question: 'Permesso?', type: 'choice', options: ['G'], required: true }] });
    const views = Object.fromEntries(formAnswersWithEdits({ order, draft: current, flow: {} }).map((field) => [field.key, fieldView(field, { draft: current, locale: 'de' })]));
    expect(views.email).toMatchObject({ editable: false, locked: 'alias', inLetter: true, validation: null });
    expect(views.workPermit).toMatchObject({ editable: false, locked: 'question' });
    expect(views.phone).toMatchObject({ editable: true, inLetter: true, validation: { message: 'Eine Telefonnummer, zum Beispiel +41 91 123 45 67.' } });
    expect(views.firstName).toMatchObject({ editable: true, required: true });

    const refused = planCandidateEdits({ fields: { email: 'maria@gmail.com', workPermit: 'B' } }, { order, draft: current, flow: {}, locale: 'it' });
    expect(refused.errors).toEqual({
      email: 'L’indirizzo della candidatura non si cambia: le risposte del datore arrivano lì e te le inoltriamo.',
      workPermit: 'Si cambia nella domanda qui sopra.',
    });
    expect(refused.changed).toEqual([]);
  });

  it('checks each field with its rule and keeps only what changed', () => {
    const bad = plan({ fields: { phone: 'chiamami', linkedin: 'facebook.com/maria', firstName: '', salary: 'da concordare' } });
    expect(bad.errors).toEqual({
      phone: 'Un numero di telefono, per esempio +41 91 123 45 67.',
      linkedin: 'Il link al tuo profilo LinkedIn, per esempio linkedin.com/in/nome-cognome.',
      firstName: 'Questo campo è obbligatorio.',
      salary: 'Indica un importo, per esempio CHF 80’000 all’anno.',
    });
    const good = plan({ fields: { phone: '+41 91 000 00 00', linkedin: 'https://www.linkedin.com/in/maria-rossi', location: 'Como', firstName: 'Maria' } });
    expect(good.errors).toEqual({});
    // Location and first name were already those: not stored as overrides.
    expect(good.overrides).toEqual({ phone: '+41 91 000 00 00', linkedin: 'https://www.linkedin.com/in/maria-rossi' });
    expect(good).toMatchObject({ changed: ['fields'], identityChanged: true });
    expect(plan({ fields: { location: 'Como' } })).toMatchObject({ changed: [], identityChanged: false });
  });

  it('takes the letter as the candidate wrote it, and the motivation texts of this round', () => {
    const edited = LETTER.replace('30 persone', '20 persone');
    const result = plan({ coverLetterText: `${edited}\n`, fields: { motivationShort: 'Il reparto di geriatria.' } });
    expect(result.errors).toEqual({});
    expect(result.changed).toEqual(['texts', 'coverLetter']);
    expect(result.draftPatch.coverLetter).toMatchObject({
      salutation: 'Gentili Signore e Signori,',
      closing: 'Cordiali saluti',
      subject: 'Candidatura',
      text: edited,
    });
    expect(result.draftPatch.coverLetter.paragraphs).toHaveLength(2);
    expect(result.draftPatch.formAnswers).toEqual([
      { key: 'motivationShort', label: 'Motivazione', value: 'Il reparto di geriatria.' },
      { key: 'whyCompany', label: 'Perché', value: 'Clinica vicina.' },
    ]);
    expect(result.overrides).toEqual({});
    expect(result.candidateText).toContain('20 persone');
    expect(plan({ coverLetterText: 'Troppo corta.' }).errors).toEqual({ coverLetterText: 'Il testo è troppo corto.' });
    expect(plan({ coverLetterText: LETTER }).changed).toEqual([]);
  });

  it('edits the e-mail only when the application leaves by e-mail, and updates the signature', () => {
    // A portal application has no e-mail to the employer: ignored.
    expect(plan({ emailSubject: 'Nuovo oggetto', emailBody: 'Nuovo testo dell’email di candidatura.' })).toMatchObject({ changed: [], errors: {} });

    const email = { draft: { channel: { type: 'email', email: 'hr@clinica.ch' } } };
    const result = plan({ emailSubject: 'Candidatura — Maria Rossi', fields: { phone: '+41 91 000 00 00' } }, email);
    expect(result.errors).toEqual({});
    expect(result.changed).toEqual(['fields', 'email']);
    expect(result.draftPatch.applicationEmail).toEqual({
      to: '',
      subject: 'Candidatura — Maria Rossi',
      body: 'Buongiorno, allego la mia candidatura.\n\nMaria Rossi\nmaria.rossi.k7p2@candidature.frontaliereticino.ch\n+41 91 000 00 00',
    });
    expect(plan({ emailSubject: 'x', emailBody: 'corto' }, email).errors).toEqual({ emailSubject: 'Il testo è troppo corto.', emailBody: 'Il testo è troppo corto.' });

    // A rewritten body and a new name in the same save: the new signature still closes the e-mail.
    const rewritten = plan({ emailBody: 'Buongiorno, vi scrivo per il posto di infermiera in reparto.', fields: { firstName: 'Maria Luisa', phone: '+41 91 000 00 00' } }, email);
    expect(rewritten.errors).toEqual({});
    expect(rewritten.draftPatch.applicationEmail.body).toBe('Buongiorno, vi scrivo per il posto di infermiera in reparto.\n\nMaria Luisa Rossi\nmaria.rossi.k7p2@candidature.frontaliereticino.ch\n+41 91 000 00 00');
  });
});

// Owner decisions of 2026-10-03 (P4): the Swiss status the candidate chose, the birth date and the nationality.
describe('the candidate’s Swiss status and personal data', () => {
  const [IT_SWISS, IT_C, IT_B, , IT_G, IT_NONE] = permitOptions('it');
  const T0 = Date.UTC(2026, 9, 4, 10, 0, 0);
  const asking = () => draft({ questions: [{ id: 'work_permit', question: 'Permesso?', type: 'choice', options: permitOptions('it'), required: false }] });
  const status = (currentDraft: any, flow: any) => candidateWithEdits({ order, draft: currentDraft, flow }).profile.permitStatus;

  it('takes the status the candidate chose: the question asked, else the field, else an older answer; never the CV’s words', () => {
    expect(status(asking(), { answers: { work_permit: IT_B }, formOverrides: { workPermit: IT_C } })).toBe('permit_b');
    expect(status(draft(), { answers: { work_permit: 'Non ancora' }, formOverrides: { workPermit: IT_C } })).toBe('permit_c');
    expect(status(draft(), { answers: { work_permit: IT_G } })).toBe('permit_g');
    // The CV says «G» (draft().profile.workPermit): it is printed as the CV's words, never a status.
    expect(status(draft(), { answers: {} })).toBe('');
    // Asked but not answered yet: the field.
    expect(status(asking(), { answers: {}, formOverrides: { workPermit: IT_C } })).toBe('permit_c');
  });

  it('reads the legacy answers as their status; a permit to come stays as written and is no status', () => {
    for (const [answer, code] of [['G', 'permit_g'], ['none', 'none'], ['Non ancora', 'none'], ['CH', 'swiss'], [permitOptions('de')[2], 'permit_b'], [IT_SWISS, 'swiss'], [IT_NONE, 'none']]) {
      expect([answer, status(draft(), { answers: { work_permit: answer } })]).toEqual([answer, code]);
    }
    expect(status(draft(), { answers: { work_permit: 'Permesso B in rinnovo' } })).toBe('');
    const fields = Object.fromEntries(formAnswersWithEdits({ order, draft: draft(), flow: { answers: { work_permit: 'Permesso B in rinnovo' } } }).map((field) => [field.key, field.value]));
    expect(fields.workPermit).toBe('Permesso B in rinnovo');
  });

  it('brings an availability answered and the corrected birth date and nationality into the profile', () => {
    const edited = candidateWithEdits({ order, draft: draft(), flow: { answers: { availability: '2027-01-01' }, formOverrides: { dateOfBirth: '12.03.1998', nationality: 'italiana' } } });
    expect(edited.profile).toMatchObject({ availability: '2027-01-01', dateOfBirth: '12.03.1998', nationality: 'italiana' });
  });

  it('shows the fields the tailored CV prints, the permit as the six options with the CV’s own words kept first', () => {
    const fields = formAnswersWithEdits({ order, draft: draft(), flow: {} });
    expect(fields.map((field) => field.key)).toEqual(['firstName', 'lastName', 'email', 'phone', 'location', 'linkedin', 'dateOfBirth', 'nationality', 'workPermit', 'availability', 'salary', 'languages', 'motivationShort', 'whyCompany']);
    const views = Object.fromEntries(fields.map((field) => [field.key, fieldView(field, { draft: draft(), locale: 'it' })]));
    // The CV says «G»: shown and selected as written, never replaced by a status.
    expect(views.workPermit).toMatchObject({ editable: true, inCv: true, value: 'G', options: ['G', ...permitOptions('it')] });
    for (const key of ['firstName', 'lastName', 'phone', 'location', 'linkedin', 'languages', 'dateOfBirth', 'nationality', 'availability']) expect([key, views[key].inCv]).toEqual([key, true]);
    for (const key of ['email', 'salary', 'motivationShort', 'whyCompany']) expect([key, views[key].inCv]).toEqual([key, false]);
    expect(views.salary.options).toBeUndefined();
    // A status chosen: the six options, the chosen one shown in the candidate's language, legacy values included.
    const german = formAnswersWithEdits({ order: { ...order, locale: 'de' }, draft: draft(), flow: { answers: { work_permit: 'G' } } });
    const permit = german.find((field) => field.key === 'workPermit')!;
    expect(permit.value).toBe(permitOptions('de')[4]);
    expect(fieldView(permit, { draft: draft(), locale: 'de' }).options).toEqual(permitOptions('de'));
  });

  it('checks a birth date and a permit status, never a value the candidate kept as it was', () => {
    const edits = (fields: Record<string, string>, flow: any = {}) => planCandidateEdits({ fields }, { order, draft: draft(), flow, locale: 'it', nowMs: T0 });
    for (const value of ['31.02.1998', '05.10.2026', '12-03-98']) {
      expect([value, edits({ dateOfBirth: value }).errors]).toEqual([value, { dateOfBirth: 'Una data di nascita valida, per esempio 12.03.1998.' }]);
    }
    for (const value of ['12.03.1998', '1998-03-12']) expect([value, edits({ dateOfBirth: value }).overrides]).toEqual([value, { dateOfBirth: value }]);
    expect(edits({ workPermit: 'qualcosa' }).errors).toEqual({ workPermit: 'Scegli una delle opzioni.' });
    expect(edits({ workPermit: IT_B }).overrides).toEqual({ workPermit: IT_B });
    // The CV's «G» and a legacy text kept as they were: no error, nothing written.
    expect(edits({ workPermit: 'G' })).toMatchObject({ errors: {}, changed: [] });
    const legacy = edits({ workPermit: 'Permesso B in rinnovo' }, { formOverrides: { workPermit: 'Permesso B in rinnovo' } });
    expect(legacy).toMatchObject({ errors: {}, changed: [] });
  });

  it('judges the texts with the status of now, a draft written before the status as it was', () => {
    const sources = { text: 'CV' };
    expect(factSourcesNow({ order, draft: draft({ factSources: sources }), flow: { answers: { work_permit: IT_G } } })).toBe(sources);
    const after = draft({ factSources: { text: 'CV', permitStatus: '' } });
    expect(factSourcesNow({ order, draft: after, flow: { answers: { work_permit: IT_G } } })).toEqual({ text: 'CV', permitStatus: 'permit_g' });
  });
});
