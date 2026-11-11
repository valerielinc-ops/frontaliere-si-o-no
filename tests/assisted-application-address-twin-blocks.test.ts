/**
 * Two address blocks of the candidate's own in one order (owner decision 2026-11-11).
 *
 * Yellowshark 1EpmkrDu: a run of 2026-11-11 read the candidate form again and stored its address fields a second
 * time, now with their native ownership contract under the form's neutral heading «Hier sind Sie richtig». The
 * platform took that block for nobody's, and the candidate typed street, house number, postal code and town a
 * second time. The labels, sections and contexts below are the real ones of that form; every value is invented.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_DEFAULTS_VERSION,
  candidateAddressTopics,
  platformDefaultAnswer,
  platformQuestionTopic,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { candidateAnswersForQuestions, candidateWithEdits as candidateWithEditsJs, questionsForCandidate } from '../functions/src/assistedApplicationCandidateEdits.js';
import { withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';

// The JSDoc of the JS module types `locale` as required and leaves `platformFacts` out of the result.
const candidateWithEdits = candidateWithEditsJs as unknown as (input: object) => any;

const SECTION = 'Hier sind Sie richtig';
const FIRST_CONTEXT = 'Anrede · Company · Frau · Herr · Vorname · Nachname · E-Mail · Email workflow step · Strasse · Hausnummer · PLZ · Ort · Land · Nationalität · Mobile · Telefon (optional) · Geburtstag · Monat · Jahr · Ich akzeptiere die Datenschutzerklärung ';
const SECOND_CONTEXT = 'Anrede · Email · Frau · Herr · Vorname · Nachname · E-Mail · Email workflow step · Strasse · Hausnummer · PLZ · Ort · Land · Nationalität · Mobile · Telefon (optional) · Geburtstag · Monat · Jahr · Ich akzeptiere die Datenschutzerklärung · ';
const NEUTRAL = { section: SECTION, owners: [], unknown: false };

const portal = (id: string, applicationQuestion: string, question: string, extra: Record<string, unknown> = {}) => ({
  id, source: 'portal', type: 'text', required: true, applicationQuestion, question, section: SECTION, ...extra,
});
// The first extraction (2026-11-05): no ownership contract.
const firstBlock = [
  portal('portal_strasse_1', 'Strasse', 'Qual è il nome della sua via di residenza?', { context: FIRST_CONTEXT }),
  portal('portal_hausnummer_1', 'Hausnummer', 'Qual è il numero civico del suo indirizzo di residenza?', { context: FIRST_CONTEXT }),
  portal('portal_plz_1', 'PLZ', 'PLZ', { context: FIRST_CONTEXT }),
];
// The second extraction (2026-11-11): the native contract names the form's heading only.
const secondBlock = [
  portal('portal_strasse_2', 'Strasse', 'Via', { context: SECOND_CONTEXT, addressContext: NEUTRAL, labels: ['Strasse'] }),
  portal('portal_hausnummer_2', 'Hausnummer', 'Numero civico', { context: SECOND_CONTEXT, addressContext: NEUTRAL, labels: ['Hausnummer'] }),
  portal('portal_plz_2', 'PLZ', 'CAP', { context: SECOND_CONTEXT, addressContext: NEUTRAL, labels: ['PLZ'] }),
  portal('portal_ort_2', 'Ort', 'Località', { context: SECOND_CONTEXT, addressContext: NEUTRAL, labels: ['Ort'] }),
];

const order = { userId: 'user-test', applicantName: 'Anna Muster' };
const draftWith = (questions: object[], location = 'Como (CO)') => ({
  status: 'ready', round: 1, language: 'de',
  job: { source: 'job_detail' }, channel: { type: 'portal', applyUrl: 'https://jobs.example.test/apply' },
  factCheck: { ok: true, unsupported: [] },
  profile: { fullName: 'Anna Muster', ...(location ? { location } : {}), cvLanguage: 'it', education: [{ degree: 'Maturità', end: '2010' }] },
  questions,
});

describe('two address blocks of the candidate own form (Yellowshark 1EpmkrDu, 2026-11-11)', () => {
  it('reads both blocks as the candidate address and fills both from the platform', () => {
    for (const question of [...firstBlock, ...secondBlock]) expect(platformQuestionTopic(question)).not.toBeNull();
    expect(platformQuestionTopic(secondBlock[0])).toBe('address_street_name');
    expect(platformQuestionTopic(secondBlock[3])).toBe('residence_city');
    const draft = draftWith([...firstBlock, ...secondBlock]);
    const edited = candidateWithEdits({ order, draft, flow: {} });
    const { answers } = withOperationalQuestionAnswers(draft.questions, edited.answers, { facts: edited.platformFacts });
    const address = edited.platformFacts.address;
    expect(answers).toMatchObject({
      portal_strasse_1: address.streetName, portal_hausnummer_1: address.houseNumber, portal_plz_1: '22100',
      portal_strasse_2: address.streetName, portal_hausnummer_2: address.houseNumber, portal_plz_2: '22100', portal_ort_2: 'Como',
    });
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
  });

  it('answers the live field of the second block in the run that reads it', () => {
    const draft = draftWith([...firstBlock]);
    const edited = candidateWithEdits({ order, draft, flow: {} });
    const candidate = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers, personal: edited.personal, platformFacts: edited.platformFacts });
    const live = { kind: 'text', label: 'Strasse', context: SECOND_CONTEXT, section: SECTION, addressContext: NEUTRAL, required: true };
    expect(candidateAnswerForField(candidate, live)?.value).toBe(edited.platformFacts.address.streetName);
  });

  it('reads a postal, correspondence or residence heading as the candidate own address', () => {
    for (const heading of ['Postadresse', 'Korrespondenzadresse', 'Wohnadresse', 'Adresse', 'Indirizzo postale', 'Mailing address']) {
      const question = portal('q', 'PLZ', 'CAP', { section: heading, context: 'Strasse · PLZ · Ort', addressContext: { section: heading, owners: [heading], unknown: false } });
      expect(platformQuestionTopic(question)).toBe('residence_postal_code');
    }
  });
});

describe('an address of another party', () => {
  it('stays out, whatever block of the candidate the order has', () => {
    for (const heading of ['Arbeitgeber', 'Referenzperson', 'Rechnungsadresse', 'Ansprechpartner', 'Billing address', 'Datore di lavoro attuale']) {
      const other = [
        portal('other_strasse', 'Strasse', 'Via', { section: heading, context: 'Firma · Strasse · Hausnummer · PLZ · Ort', addressContext: { section: heading, owners: [heading], unknown: false } }),
        portal('other_plz', 'PLZ', 'CAP', { section: heading, context: 'Firma · Strasse · Hausnummer · PLZ · Ort', addressContext: { section: heading, owners: [heading], unknown: false } }),
      ];
      const questions = [...secondBlock, ...other];
      expect(platformQuestionTopic(other[0])).toBeNull();
      expect([...candidateAddressTopics(questions).keys()]).not.toContain('other_strasse');
      const draft = draftWith(questions);
      const flow = { answers: { portal_strasse_2: 'Musterweg', portal_plz_2: '6900' } };
      const edited = candidateWithEdits({ order, draft, flow });
      expect(edited.answers.other_strasse).toBeUndefined();
      expect(edited.answers.other_plz).toBeUndefined();
      expect(platformDefaultAnswer(other[1], edited.platformFacts, { locale: 'de' })).toBeNull();
      expect(evaluateRedFlags(draft, flow.answers, {}, {}, null, order).candidate).toEqual(expect.arrayContaining(['other_strasse', 'other_plz']));
    }
  });

  it('never copies a block that names nobody into one with different fields, nor a street into a second street line', () => {
    const owned = { section: 'Personal information', owners: ['Personal information'], unknown: false };
    const neutral = { section: 'Schritt 2', owners: [], unknown: false };
    const questions = [
      portal('own_street', 'Street', 'Via', { section: 'Personal information', addressContext: owned }),
      portal('own_zip', 'Postal code', 'CAP', { section: 'Personal information', addressContext: owned }),
      portal('step_street', 'Street', 'Via', { section: 'Schritt 2', addressContext: neutral }),
      portal('step_region', 'State', 'Stato', { section: 'Schritt 2', addressContext: neutral }),
      portal('line_1', 'Address line 1', 'Indirizzo 1', { section: 'Personal information', addressContext: owned }),
      portal('line_2', 'Address line 2', 'Indirizzo 2', { section: 'Personal information', addressContext: owned }),
    ];
    const topics = candidateAddressTopics(questions);
    expect(topics.has('step_street')).toBe(false);
    expect(topics.has('line_1')).toBe(false);
    expect(topics.has('line_2')).toBe(false);
    expect(candidateAnswersForQuestions(questions, { own_street: 'Musterweg 4' })).not.toHaveProperty('line_2');
  });
});

describe('a block of the candidate proved by its fields', () => {
  const owned = { section: 'Personal information', owners: ['Personal information'], unknown: false };
  const neutral = { section: 'Schritt 2', owners: [], unknown: false };
  const questions = [
    portal('own_street', 'Strasse', 'Via', { section: 'Personal information', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: owned }),
    portal('own_number', 'Hausnummer', 'Numero civico', { section: 'Personal information', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: owned }),
    portal('own_zip', 'PLZ', 'CAP', { section: 'Personal information', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: owned }),
    portal('own_town', 'Ort', 'Località', { section: 'Personal information', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: owned }),
    portal('step_street', 'Strasse', 'Via', { section: 'Schritt 2', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: neutral }),
    portal('step_number', 'Hausnummer', 'Numero civico', { section: 'Schritt 2', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: neutral }),
    portal('step_zip', 'PLZ', 'CAP', { section: 'Schritt 2', context: 'Strasse · Hausnummer · PLZ · Ort', addressContext: neutral }),
  ];

  it('takes the same platform address as the block it repeats', () => {
    expect(platformQuestionTopic(questions[4])).toBeNull();
    expect([...candidateAddressTopics(questions).keys()]).toEqual(expect.arrayContaining(['step_street', 'step_number', 'step_zip']));
    const draft = draftWith(questions);
    const edited = candidateWithEdits({ order, draft, flow: {} });
    expect(platformDefaultAnswer(questions[6], edited.platformFacts, { locale: 'de' })?.value).toBe('22100');
    expect(platformDefaultAnswer(questions[4], edited.platformFacts, { locale: 'de' })).toMatchObject({ value: edited.platformFacts.address.streetName, version: PLATFORM_DEFAULTS_VERSION });
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
  });
});

describe('what the candidate typed in one block', () => {
  const typed = { portal_strasse_1: 'Musterweg', portal_hausnummer_1: '7', portal_plz_1: '6900' };

  it('answers the same fields of the other block, above the platform address', () => {
    const draft = draftWith([...firstBlock, ...secondBlock]);
    const edited = candidateWithEdits({ order, draft, flow: { answers: typed } });
    expect(edited.answers).toMatchObject({ portal_strasse_2: 'Musterweg', portal_hausnummer_2: '7', portal_plz_2: '6900' });
    expect(edited.platformFacts.address).toMatchObject({ streetName: 'Musterweg', houseNumber: '7', street: 'Musterweg 7', postalCode: '6900', synthesizedStreet: false });
    // The town nobody typed: the platform's, from the CV.
    expect(platformDefaultAnswer(secondBlock[3], edited.platformFacts, { locale: 'de' })?.value).toBe('Como');
    expect(evaluateRedFlags(draft, typed, {}, {}, null, order).candidate).toEqual([]);
    // The live runner fills the second block with the candidate's own words.
    const candidate = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers, personal: edited.personal, platformFacts: edited.platformFacts });
    const live = { kind: 'text', label: 'Hausnummer', context: SECOND_CONTEXT, section: SECTION, addressContext: NEUTRAL, required: true };
    expect(candidateAnswerForField(candidate, live)?.value).toBe('7');
  });

  it('is asked once when neither block can be answered, and reaches the twin once given', () => {
    const draft = draftWith([...firstBlock, ...secondBlock], '');
    const shown = questionsForCandidate(draft.questions, draft.profile, {}, {}, draft);
    const addressShown = shown.filter((question) => String(question.id).startsWith('portal_'));
    expect(addressShown.map((question) => question.applicationQuestion).sort()).toEqual(['Hausnummer', 'Ort', 'PLZ', 'Strasse']);
    const once = { [addressShown.find((question) => question.applicationQuestion === 'PLZ')!.id]: '6900' };
    const projected = candidateAnswersForQuestions(draft.questions, once);
    expect(projected.portal_plz_1).toBe('6900');
    expect(projected.portal_plz_2).toBe('6900');
  });

  it('leaves two different answers to the candidate, and keeps a field they cleared', () => {
    const draft = draftWith([...firstBlock, ...secondBlock], '');
    const conflicting = { portal_plz_1: '6900', portal_plz_2: '6830' };
    const shown = questionsForCandidate(draft.questions, draft.profile, conflicting, {}, draft).map((question) => question.id);
    expect(shown).toEqual(expect.arrayContaining(['portal_plz_1', 'portal_plz_2']));
    expect(candidateWithEdits({ order, draft, flow: { answers: conflicting } }).platformFacts.address.postalCode).toBe('');
    const cleared = candidateAnswersForQuestions(draft.questions, { portal_plz_1: '6900', portal_plz_2: '' });
    expect(cleared.portal_plz_2).toBe('');
  });
});
