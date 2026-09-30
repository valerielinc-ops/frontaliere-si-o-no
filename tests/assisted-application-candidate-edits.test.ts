import { describe, expect, it } from 'vitest';
import {
  candidateWithEdits,
  fieldView,
  formAnswersWithEdits,
  planCandidateEdits,
} from '../functions/src/assistedApplicationCandidateEdits.js';

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
