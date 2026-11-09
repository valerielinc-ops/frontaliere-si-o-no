import { describe, expect, it } from 'vitest';
import {
  ageOn,
  platformCandidateFactAnswer,
  platformCandidateFacts,
  platformDateOfBirth,
  platformDefaultAnswer,
  platformQuestionTopic,
  sanitizeCandidateFacts,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer, isOperationalDefaultValue, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { openRequiredQuestions } from '../scripts/assisted-application/lib/submit.mjs';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { ensureOrderSalaryEstimate, orderWithSalaryEstimate } from '../functions/src/assistedApplicationJobCard.js';

const NOW = Date.parse('2026-11-09T10:00:00Z');

describe('candidate facts are never synthesized', () => {
  it('keeps location, education, detected CV language and job estimates from becoming personal facts', () => {
    const facts = platformCandidateFacts({
      order: { userId: 'user-1', salaryMax: 88000, candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } },
      profile: {
        location: 'Como (CO)',
        languages: [{ language: 'Inglese', level: 'B2' }],
        cvLanguage: 'it',
        education: [{ degree: 'Diploma di maturità scientifica', institution: 'Liceo Volta', start: '2005', end: '2010' }],
      },
      identity: { firstName: 'Giulia', name: 'Giulia Rossi' },
      nowMs: NOW,
      locale: 'it',
    });

    expect(facts).toMatchObject({
      dateOfBirth: '', age: null, civilStatus: '', civilStatusLabel: '',
      languages: [], salutation: '', permitStatus: 'permit_g', passport: 'eu_efta', nationality: 'Italiana',
    });
    expect(facts).not.toHaveProperty('address');
    expect(facts).not.toHaveProperty('salary');
    expect(facts).not.toHaveProperty('startDate');
  });

  it('accepts a stated birth date and derives age only from that date', () => {
    expect(platformDateOfBirth({ education: [{ degree: 'Maturità classica', end: '2010' }] })).toBeNull();
    expect(platformDateOfBirth({ education: [{ degree: 'Laurea', start: '2000' }] })).toBeNull();
    expect(platformDateOfBirth({ dateOfBirth: '03.04.1990', education: [{ degree: 'Maturità', end: '2010' }] }))
      .toEqual({ value: '1990-04-03', estimated: false });
    expect(ageOn('1982-01-01', NOW)).toBe(44);
  });

  it('requires an explicit language list and keeps the stated level unchanged', () => {
    const parsedButUnconfirmed = platformCandidateFacts({ profile: {
      cvLanguage: 'it', languages: [{ language: 'Italian', level: 'B2' }],
    }, nowMs: NOW, locale: 'en' });
    expect(parsedButUnconfirmed.languages).toEqual([]);

    const explicit = platformCandidateFacts({ profile: {
      languagesExplicitList: true,
      cvLanguage: 'it',
      languages: [{ language: 'Italian', level: 'B2' }, { language: 'German', level: '' }],
    }, nowMs: NOW, locale: 'en' });
    expect(explicit.languages).toEqual([{ code: 'it', level: 'B2' }, { code: 'de', level: '' }]);
    expect(platformCandidateFactAnswer({ question: 'What is your Italian level?', type: 'choice', options: ['Native', 'C1', 'B2', 'B1'] }, explicit))
      .toMatchObject({ value: 'B2', source: 'profile' });
    expect(platformCandidateFactAnswer({ question: 'What is your German level?', type: 'choice', options: ['Native', 'C1', 'B2', 'B1'] }, explicit)).toBeNull();
  });

  it('does not infer civil status or passport from age, nationality, or permit', () => {
    const facts = platformCandidateFacts({
      order: { candidateFacts: { workPermit: 'swiss', nationality: 'Svizzera' } },
      profile: { dateOfBirth: '1980-01-01' }, personal: {}, nowMs: NOW,
    });
    expect(facts).toMatchObject({ civilStatus: '', passport: '' });
    expect(platformCandidateFactAnswer({ question: 'Do you hold a Swiss passport?', type: 'yes_no' }, facts)).toBeNull();
  });

  it('accepts only a complete, valid set of candidate upload answers', () => {
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: ' Italiana ' }))
      .toEqual({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_x', passport: 'eu_efta', nationality: 'Italiana' })).toBeNull();
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta' })).toBeNull();
  });
});

describe('hard questions and consent stay with the candidate', () => {
  it('classifies known fact questions but never returns them as policy defaults', () => {
    const explicit = platformCandidateFacts({
      order: { candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } },
      profile: { dateOfBirth: '1990-04-03', languagesExplicitList: true, languages: [{ language: 'English', level: 'B2' }] },
      personal: { civilStatus: 'Divorziata' }, answers: { salutation: 'Signora' }, nowMs: NOW, locale: 'it',
    });
    const prompts = [
      { question: 'CAP', type: 'text' },
      { question: 'Nazione (di residenza)', type: 'choice', options: ['Svizzera', 'Italia'] },
      { question: 'Qual è la tua data di nascita?', type: 'date' },
      { question: 'Qual è il tuo stato civile?', type: 'choice', options: ['Divorced', 'Single'] },
      { question: 'Qual è la tua aspettativa salariale?', type: 'text' },
      { question: 'Da quale data puoi iniziare a lavorare?', type: 'date' },
      { question: 'Sei disponibile a trasferirti per questo ruolo?', type: 'yes_no', options: ['Sì', 'No'] },
      { question: 'Sei disponibile per il servizio di picchetto?', type: 'yes_no', options: ['Sì', 'No'] },
      { question: 'I consent to recording and using the interview audio.', type: 'yes_no', options: ['Yes', 'No'] },
      { question: 'Please check this box to acknowledge that you have read the Applicant Privacy Notice.', type: 'checkbox', required: true },
    ];
    for (const question of prompts) {
      expect(platformDefaultAnswer(question, explicit)).toBeNull();
    }
    expect(platformQuestionTopic({ question: 'Qual è la tua data di nascita?', type: 'date' })).toBe('birth_date');
    expect(platformCandidateFactAnswer({ question: 'Qual è la tua data di nascita?', type: 'date' }, explicit))
      .toMatchObject({ value: '1990-04-03', source: 'profile' });
  });

  it('keeps required fact, notice, salary, and consent questions in the candidate queue', () => {
    const draft = {
      language: 'it',
      profile: { fullName: 'Giulia Rossi', location: 'Como (CO)' },
      questions: [
        { id: 'birth', question: 'Data di nascita', type: 'date', required: true, source: 'portal' },
        { id: 'salary', question: 'Aspettativa salariale', type: 'text', required: true, source: 'match' },
        { id: 'notice', question: 'Notice period', type: 'text', required: true, source: 'portal' },
        { id: 'consent', question: 'I consent to processing my personal data for this application.', type: 'checkbox', required: true, source: 'portal' },
      ],
    };
    const order = { applicantName: 'Giulia Rossi' };
    expect(openRequiredQuestions(draft, {}, { order }).map((question) => question.id))
      .toEqual(['birth', 'salary', 'notice', 'consent']);
  });

  it('uses only policy-approved workload and privacy-reading soft defaults', () => {
    const preferred = { id: 'preferred', question: 'What is your preferred workload?', type: 'text', required: true };
    expect(operationalDefaultAnswer(preferred)?.value).toBe('100%');
    expect(operationalDefaultAnswer({ question: 'What is your notice period?', type: 'text' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'Do you consent to be contacted via WhatsApp?', type: 'yes_no' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'I consent to processing my personal data for this application.', type: 'checkbox' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'Please check this box to acknowledge that you have read the Applicant Privacy Notice.', type: 'checkbox', required: true }))
      .toMatchObject({ value: 'true', topic: 'privacy_review_ack', source: 'policy_default' });
    expect(operationalDefaultAnswer({ question: 'How long may we retain your data for this application?', type: 'choice', options: ['1 year', '2 years'] })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'What is your salary expectation?', type: 'number' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'When can you start?', type: 'date' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'Are you willing to relocate?', type: 'yes_no' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'Can you work on call?', type: 'yes_no' })).toBeNull();

    const answers = withOperationalQuestionAnswers([preferred, { id: 'notice', question: 'Notice period', type: 'text' }], {});
    expect(answers.answers).toEqual({ [preferred.id]: '100%' });
    expect(answers.defaults[preferred.id]).toMatchObject({ source: 'policy_default' });
    expect(isOperationalDefaultValue(preferred, '100%')).toBe(true);
  });

  it('defaults optional marketing to decline and never checks a checkbox automatically', () => {
    const question = 'Do you want to receive marketing emails?';
    expect(platformDefaultAnswer({ question, type: 'yes_no', required: false, options: ['Yes', 'No'] }))
      .toMatchObject({ value: 'No', source: 'policy_default' });
    expect(platformDefaultAnswer({ question, type: 'yes_no', required: true, options: ['Yes', 'No'] })).toBeNull();
    expect(platformDefaultAnswer({ question, type: 'yes_no', options: ['Yes', 'No'] })).toBeNull();
    expect(operationalDefaultAnswer({ question, type: 'yes_no', required: true, options: ['Yes', 'No'] })).toBeNull();
    expect(platformDefaultAnswer({ question, type: 'checkbox', required: false })).toBeNull();
  });

  it('does not infer a title from the candidate name or create form address values', () => {
    const draft = { language: 'it', profile: { fullName: 'Giulia Rossi', location: 'Como (CO)', education: [{ degree: 'Maturità', end: '2010' }] }, factSources: { text: 'Giulia Rossi\nComo (CO)\nMaturità, 2010' }, questions: [] };
    const edited = candidateWithEdits({ order: { applicantName: 'Giulia Rossi' }, draft, flow: {} });
    expect(edited.personal.salutation).toBe('');
    expect(edited.answers).not.toHaveProperty('salutation');
    expect(edited.platformFacts).toMatchObject({ dateOfBirth: '', age: null, civilStatus: '' });

    const candidate = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers, personal: edited.personal, platformFacts: edited.platformFacts, draft });
    expect(candidate.identity.address).toMatchObject({ street: '', postalCode: '', city: 'Como', country: '' });
    expect(candidate.profile.dateOfBirth).toBe('');
    expect(candidate.profile.civilStatus).toBe('');
  });

  it('maps explicit upload answers to passport, permit and nationality fields as candidate facts', () => {
    const facts = platformCandidateFacts({
      order: { candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } },
      nowMs: NOW, locale: 'it',
    });
    expect(platformCandidateFactAnswer({ question: 'Do you hold an EU/EFTA passport?', type: 'yes_no', options: ['Yes', 'No'] }, facts))
      .toMatchObject({ value: 'Yes', source: 'profile' });
    expect(platformCandidateFactAnswer({ question: 'What is your nationality?', type: 'text' }, facts))
      .toMatchObject({ value: 'italiana', source: 'profile' });
    const permit = platformCandidateFactAnswer({ question: 'Do you currently hold a valid Swiss work permit?', type: 'yes_no', options: ['Yes', 'No'] }, facts);
    expect(permit).toMatchObject({ value: 'Yes', source: 'profile' });
  });
});

describe('job salary estimate fetching remains separate from candidate expectations', () => {
  it('keeps an order retryable when the job detail cannot be read, and marks a job without estimate', async () => {
    const order = { jobId: 'job-1' };
    const writes: any[] = [];
    const write = async (patch: any) => { writes.push(patch); };
    await expect(ensureOrderSalaryEstimate({ order, write, fetchImpl: (async () => { throw new Error('network down'); }) as any })).rejects.toThrow();
    await expect(ensureOrderSalaryEstimate({ order, write, fetchImpl: (async () => new Response('', { status: 503 })) as any })).rejects.toThrow('job_detail_unavailable:503');
    expect(writes).toEqual([]);
    expect(await ensureOrderSalaryEstimate({ order, write, nowMs: 5, fetchImpl: (async () => new Response('', { status: 404 })) as any })).toBe('unavailable');
    expect(writes).toEqual([{ salaryEstimateCheckedAt: 5 }]);
    const detail = { baseSalary: { currency: 'CHF', value: { minValue: 80000, maxValue: 100000, unitText: 'YEAR' } } };
    expect(await ensureOrderSalaryEstimate({ order, write, nowMs: 6, fetchImpl: (async () => new Response(JSON.stringify(detail), { status: 200 })) as any })).toBe('estimated');
    expect(writes.at(-1)).toMatchObject({ salaryMax: 100000, salaryMin: 80000, salaryCurrency: 'CHF', salaryEstimateCheckedAt: 6 });
  });

  it('hands the automation the order with the estimate just written', async () => {
    const detail = { salaryMax: 90000 };
    const writes: any[] = [];
    const { order, salary } = await orderWithSalaryEstimate({
      order: { jobId: 'job-1' }, nowMs: 7,
      write: async (patch: any) => { writes.push(patch); },
      fetchImpl: (async () => new Response(JSON.stringify(detail), { status: 200 })) as any,
    });
    expect(salary).toBe('estimated');
    expect(order).toMatchObject({ jobId: 'job-1', salaryMax: 90000, salaryEstimateCheckedAt: 7 });
    expect(writes).toHaveLength(1);
    expect((await orderWithSalaryEstimate({ order: { jobId: 'job-1', salaryMax: 5 }, write: async () => {}, fetchImpl: (async () => { throw new Error('unexpected'); }) as any })).order)
      .toEqual({ jobId: 'job-1', salaryMax: 5 });
  });
});
