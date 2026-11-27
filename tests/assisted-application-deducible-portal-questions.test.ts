import { describe, expect, it } from 'vitest';
import { operationalDefaultAnswer, operationalQuestionTopic } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { isConsentPurpose } from '../functions/src/lib/applicationConsent.js';
import { platformCandidateFacts, platformDefaultAnswer, platformPostalCountry, platformQuestionTopic } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { candidateAnswerForField, ownConsent, ownStatusAnswer, questionTopic } from '../scripts/assisted-application/lib/portal/plan.mjs';

// Synthetic data only. Each block is one class of question a portal asks although the order already knows the
// answer (a stated fact) or the platform has a true default for everyone (the mandate of the application).

const NOTICE = 'Dichiaro di aver letto e compreso la Dichiarazione sulla protezione dei dati dell’EOC. ';
const consentBox = (label: string, required = true) => ({ id: 'privacy', kind: 'checkbox', type: 'checkbox', question: label, applicationQuestion: label, label, required });

describe('privacy notice acknowledgement is covered by the mandate (case: umantis checkbox)', () => {
  it.each([
    'Accetto che i miei dati personali vengano trattati e conservati in conformità con tale Dichiarazione.',
    'Accetto il trattamento dei miei dati personali ai fini della candidatura.',
    'Acconsento che i miei dati personali vengano trattati in conformità con tale Dichiarazione.',
  ])('answers the box «%s» with the policy default and ticks it', (tail) => {
    const question = consentBox(NOTICE + tail);
    expect(operationalQuestionTopic(question)).toBe('application_data_processing_consent');
    expect(operationalDefaultAnswer(question)).toMatchObject({ value: 'true', source: 'policy_default' });
    expect(ownConsent({ kind: 'checkbox', label: NOTICE + tail, required: true })).toBe(true);
  });

  it('reads a named owner of the notice as a name, not as a claim', () => {
    expect(isConsentPurpose('Dichiaro di aver letto e compreso la Dichiarazione sulla protezione dei dati dell’EOC.')).toBe(true);
    expect(isConsentPurpose('Dichiaro di aver letto la privacy policy of Acme AG')).toBe(true);
    expect(isConsentPurpose('Datenschutzerklärung der Stadt Zürich gelesen und akzeptiert')).toBe(true);
  });

  it.each([
    NOTICE + 'Accetto di ricevere newsletter e che i miei dati personali vengano trattati.',
    NOTICE + 'Accetto che i miei dati personali vengano trattati. Accetto inoltre di essere inserito nel talent pool.',
    NOTICE + 'Non accetto che i miei dati personali vengano trattati.',
    'Dichiaro di essere in possesso del permesso B. Accetto che i miei dati personali vengano trattati.',
    'Dichiaro di essere maggiorenne e di aver letto la privacy policy of Acme AG',
  ])('never ticks a box with a fact, an optional purpose or a refusal: «%s»', (label) => {
    expect(operationalQuestionTopic(consentBox(label))).toBeNull();
    expect(operationalDefaultAnswer(consentBox(label))).toBeNull();
    expect(ownConsent({ kind: 'checkbox', label, required: true })).toBe(false);
    expect(isConsentPurpose(label)).toBe(false);
  });
});

describe('work permit and residence yes/no follow the stated permit (case: SuccessFactors coop)', () => {
  const permitFacts = (workPermit?: string) => platformCandidateFacts({
    order: { candidateFacts: workPermit ? { workPermit } : {} },
    profile: { address: { city: 'Como' } }, identity: { firstName: 'Anna' },
  });
  const disjunctive = 'Risiedi in Svizzera, o sei in possesso di un regolare permesso di lavoro?';
  const select = (label: string) => ({ id: 'x', kind: 'select', label, options: ['Seleziona', 'Sì', 'No'] });
  const candidate = (status?: string) => ({ answers: status ? { work_permit: status } : {}, identity: {}, profile: {}, portalQuestionsAnswered: [] });

  it('answers yes in the planner when a permit is held', () => {
    for (const label of [disjunctive, '* ' + disjunctive, 'Do you live in Switzerland, or do you hold a valid work permit?',
      'Wohnen Sie in der Schweiz oder haben Sie eine gültige Arbeitsbewilligung?', 'Habitez-vous en Suisse ou avez-vous un permis de travail valable ?']) {
      expect(candidateAnswerForField(candidate('permit_g'), select(label))?.value).toBe('Sì');
      expect(ownStatusAnswer(candidate('permit_g'), label, 'Sì', { option: true })).toBe(true);
    }
  });

  it('never derives a no from the lack of a permit: the candidate may live in Switzerland', () => {
    expect(candidateAnswerForField(candidate('none'), select(disjunctive))).toBeNull();
    expect(candidateAnswerForField(candidate(), select(disjunctive))).toBeNull();
    expect(ownStatusAnswer(candidate('none'), disjunctive, 'No', { option: true })).toBe(false);
    expect(ownStatusAnswer(candidate('permit_g'), disjunctive, 'No', { option: true })).toBe(false);
  });

  it('leaves the questions about a need, a document or a past permit to the candidate', () => {
    expect(candidateAnswerForField(candidate('permit_g'), select('Risiedi in Svizzera o hai bisogno di un permesso di lavoro?'))).toBeNull();
    expect(candidateAnswerForField(candidate('permit_g'), select('Risiedi in Svizzera o sei in possesso di un permesso di lavoro? Allega copia del documento'))).toBeNull();
  });

  it('answers the same question on the platform side, yes by a held permit only', () => {
    const question = { id: 'x', type: 'yes_no', question: disjunctive, options: ['Sì', 'No'] };
    expect(platformDefaultAnswer(question, permitFacts('permit_g'), { locale: 'it' })?.value).toBe('Sì');
    expect(platformDefaultAnswer(question, permitFacts('none'), { locale: 'it' })).toBeNull();
    expect(platformDefaultAnswer(question, permitFacts(), { locale: 'it' })?.value).not.toBe('No');
  });

  it('answers a plain «do you live in Switzerland» from the stated address country', () => {
    const question = { id: 'r', type: 'yes_no', question: 'Risiedi in Svizzera?', options: ['Sì', 'No'] };
    const facts = (city: string) => platformCandidateFacts({ order: {}, profile: { address: { city } }, identity: { firstName: 'Anna' } });
    expect(platformQuestionTopic(question)).toBe('residence_in_switzerland');
    expect(platformDefaultAnswer(question, facts('Lugano'), { locale: 'it' })?.value).toBe('Sì');
    expect(platformDefaultAnswer(question, facts('Como'), { locale: 'it' })?.value).toBe('No');
    expect(platformDefaultAnswer(question, facts(''), { locale: 'it' })).toBeNull();
    for (const text of ['Risiedi in Svizzera o in zona di frontiera?', 'Risiedi in Svizzera da almeno 5 anni?']) {
      expect(platformQuestionTopic({ ...question, question: text })).not.toBe('residence_in_switzerland');
    }
  });

  it('keeps asking the date of birth the CV does not state, and reuses it once given', () => {
    const question = { id: 'd', type: 'text', question: 'Data di nascita' };
    expect(platformDefaultAnswer(question, permitFacts('permit_g'), { locale: 'it' })).toBeNull();
    const answered = { answers: {}, identity: {}, profile: {}, portalQuestionsAnswered: [{ question: 'Data di nascita', answer: '01.02.1990', source: 'answers' }] };
    expect(candidateAnswerForField(answered, { id: 'd2', kind: 'text', label: 'Date of birth' })?.value).toBe('01.02.1990');
    expect(candidateAnswerForField(answered, { id: 'd3', kind: 'text', label: 'Geburtsdatum' })?.value).toBe('01.02.1990');
  });
});

describe('the country of residence is asked once and deduced only from proof (case: Stadt Zürich)', () => {
  const countries = ['Schweiz', 'Deutschland', 'Italien', 'Frankreich'];
  const owned = { section: 'Konto', addressContext: { section: 'Konto', owners: ['Konto'], unknown: false } };
  const field = (label: string, extra = {}) => ({ id: 'portal_land_x', kind: 'select', label, options: ['Bitte wählen', ...countries], ...extra });

  it('classifies the question form and the caption as the same semantic key in four languages', () => {
    for (const label of ['In welchem Land wohnen Sie?', 'In which country do you live?', 'In quale Paese risiedi?',
      'Land / Region des Wohnorts', 'Land/Region des Wohnorts:*', 'Wohnsitzland']) {
      expect(questionTopic(label, '', {})).toBe('residence_country');
    }
    expect(questionTopic('In which country did you study?', '', {})).toBe('');
    expect(questionTopic('In welchem Land möchten Sie arbeiten?', '', {})).toBe('');
  });

  it('reuses the answer given to the first wording when the portal asks the second one', () => {
    const asked = { answers: {}, identity: {}, profile: {}, portalQuestionsAnswered: [{ question: 'In welchem Land wohnen Sie?', answer: 'Italien', source: 'answers' }] };
    expect(candidateAnswerForField(asked, field('Land / Region des Wohnorts'))).toEqual({ value: 'Italien', source: 'answers' });
    const byAnswerId = { answers: { portal_residence_country: 'Italien' }, identity: {}, profile: {}, portalQuestionsAnswered: [] };
    expect(candidateAnswerForField(byAnswerId, field('Land / Region des Wohnorts', owned))).toEqual({ value: 'Italien', source: 'answers' });
  });

  it('does not reuse it for a field of another owner or an unknown one', () => {
    const byAnswerId = { answers: { portal_residence_country: 'Italien' }, identity: {}, profile: {}, portalQuestionsAnswered: [] };
    expect(candidateAnswerForField(byAnswerId, field('Land / Region des Wohnorts', { ...owned, addressContext: { section: 'Arbeitgeber', owners: ['Arbeitgeber'], unknown: false } }))).toBeNull();
    expect(candidateAnswerForField(byAnswerId, field('Land / Region des Wohnorts', { ...owned, addressContext: { section: 'Konto', owners: [], unknown: true } }))).toBeNull();
  });

  it('deduces the country from the address the profile proves, never from a bare code', () => {
    const question = { id: 'q', type: 'choice', question: 'In welchem Land wohnen Sie?', options: countries };
    const answer = (address: Record<string, string>) => platformDefaultAnswer(question,
      platformCandidateFacts({ order: {}, profile: { address }, identity: { firstName: 'Anna' } }), { locale: 'it' })?.value ?? null;
    expect(answer({ city: 'Como' })).toBe('Italien');
    expect(answer({ city: 'Lugano' })).toBe('Schweiz');
    expect(answer({ city: 'Xyzzy', country: 'Germany' })).toBe('Deutschland');
    // The 5-digit code alone is shared by Italy, France and Germany: no country is proven.
    expect(answer({ postalCode: '22100' })).toBeNull();
    expect(answer({})).toBeNull();
    // A town that exists in several countries is placed only by its own postal code.
    expect(platformPostalCountry('Wiesen')).toBe('');
    expect(platformPostalCountry('Wiesen', { postalCode: '39049' })).toBe('IT');
  });
});
