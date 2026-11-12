/**
 * Platform defaults of the assisted application (owner decision 2026-11-09).
 *
 * The census of 2026-11-09 counted 178 questions asked on 34 paid orders; the
 * stable ones (permit, address, form of address, birth date, languages,
 * salary, workload, notice, start date, consents, availabilities) are now
 * answered by the platform. The labels below are the ones real orders were
 * asked.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_STREETS,
  PLATFORM_DEFAULTS_VERSION,
  ageOn,
  platformCandidateFacts,
  platformDateOfBirth,
  platformDefaultAnswer,
  platformPostalCode,
  platformQuestionTopic,
  platformStartDate,
  sanitizeCandidateFacts,
  passportOf,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { operationalDefaultAnswer, isOperationalDefaultValue, withOperationalQuestionAnswers, withPlatformSuggestions } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { ensureOrderSalaryEstimate, orderWithSalaryEstimate } from '../functions/src/assistedApplicationJobCard.js';

const NOW = Date.parse('2026-11-09T10:00:00Z');

const facts = platformCandidateFacts({
  order: { userId: 'user-1', salaryMax: 88000, baseSalary: { value: { unitText: 'YEAR' }, currency: 'CHF' }, candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } },
  profile: {
    location: 'Como (CO)',
    languages: [{ language: 'Inglese', level: 'B2' }, { language: 'Tedesco', level: 'base' }],
    cvLanguage: 'it',
    education: [{ degree: 'Diploma di maturità scientifica', institution: 'Liceo Volta', start: '2005', end: '2010' }],
  },
  identity: { firstName: 'Giulia', name: 'Giulia Rossi' },
  nowMs: NOW,
  locale: 'it',
});

const answer = (question: Record<string, unknown>, given = facts) => platformDefaultAnswer({ required: true, ...question }, given, { locale: 'it' })?.value ?? null;

describe('candidate facts', () => {
  it('deduces postal code and country from the CV town, Italy and Switzerland alike', () => {
    expect(facts.address).toMatchObject({ postalCode: '22100', city: 'Como', country: 'IT', countryName: 'Italia', synthesizedStreet: true });
    expect(platformPostalCode('Milano')).toMatchObject({ country: 'IT', code: '20121' });
    expect(platformPostalCode('Lugano')).toMatchObject({ country: 'CH', code: '6900' });
    expect(platformPostalCode('Chiasso', { region: 'TI' })).toMatchObject({ country: 'CH', code: '6830' });
    expect(platformPostalCode('Nowhere-on-the-map')).toBeNull();
  });

  it('synthesizes a street from the owner list, the same for the same candidate', () => {
    expect(PLATFORM_STREETS).toContain(facts.address.streetName);
    expect(Number(facts.address.houseNumber)).toBeGreaterThanOrEqual(1);
    expect(Number(facts.address.houseNumber)).toBeLessThanOrEqual(101);
    const again = platformCandidateFacts({ order: { userId: 'user-1' }, profile: { location: 'Como' }, nowMs: NOW });
    expect(again.address.street).toBe(facts.address.street);
  });

  it('keeps a street the CV states', () => {
    const stated = platformCandidateFacts({ profile: { address: { street: 'Via Milano 12', city: 'Varese' } }, nowMs: NOW });
    expect(stated.address).toMatchObject({ street: 'Via Milano 12', houseNumber: '12', synthesizedStreet: false, postalCode: '21100' });
  });

  it('estimates the birth date at 18 from the Maturità, else from the start of university', () => {
    expect(platformDateOfBirth({ education: [{ degree: 'Maturità classica', end: '2010' }] })).toEqual({ value: '1992-01-01', estimated: true });
    // The owner's example: university started in 2000 → born in 1982.
    expect(platformDateOfBirth({ education: [{ degree: 'Laurea in Economia', institution: 'Università Bocconi', start: '2000', end: '2005' }] })).toEqual({ value: '1982-01-01', estimated: true });
    expect(platformDateOfBirth({ dateOfBirth: '03.04.1990', education: [{ degree: 'Maturità', end: '2010' }] })).toEqual({ value: '1990-04-03', estimated: false });
    expect(platformDateOfBirth({ education: [] })).toBeNull();
    expect(ageOn('1982-01-01', NOW)).toBe(44);
  });

  it('sets the civil status from the age: married above 35, single otherwise; the CV wins', () => {
    expect(facts).toMatchObject({ age: 34, civilStatus: 'single', civilStatusEstimated: true });
    const older = platformCandidateFacts({ profile: { education: [{ degree: 'Laurea', institution: 'Politecnico di Milano', start: '2000' }] }, nowMs: NOW });
    expect(older).toMatchObject({ age: 44, civilStatus: 'married', civilStatusLabel: 'Coniugato/a' });
    const stated = platformCandidateFacts({ personal: { civilStatus: 'Divorziata' }, profile: { education: [{ degree: 'Laurea', institution: 'USI', start: '2000' }] }, nowMs: NOW });
    expect(stated).toMatchObject({ civilStatus: 'divorced', civilStatusEstimated: false });
  });

  it('starts three months after submission and reads the salary maximum', () => {
    expect(platformStartDate(NOW)).toBe('2027-02-09');
    expect(platformStartDate(Date.parse('2026-11-30T10:00:00Z'))).toBe('2027-02-28');
    expect(facts.salary).toEqual({ annual: 88000, currency: 'CHF' });
    expect(platformCandidateFacts({ order: { baseSalary: { value: { maxValue: 6000, unitText: 'MONTH' }, currency: 'CHF' } }, nowMs: NOW }).salary).toEqual({ annual: 72000, currency: 'CHF' });
  });

  it('accepts valid candidate facts and preserves omitted or explicitly blank fields', () => {
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: ' Italiana ' })).toEqual({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', nationality: 'Italiana' })).toEqual({ workPermit: 'permit_g', nationality: 'Italiana' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta' })).toEqual({ workPermit: 'permit_g', passport: 'eu_efta' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: '', nationality: 'Italiana' })).toEqual({ workPermit: 'permit_g', passport: '', nationality: 'Italiana' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: null, nationality: 'Italiana' })).toBeNull();
    expect(sanitizeCandidateFacts({ workPermit: 'permit_x', passport: 'eu_efta', nationality: 'Italiana' })).toBeNull();
    expect(sanitizeCandidateFacts({ workPermit: 'permit_x', passport: 'eu_efta' })).toBeNull();
  });
});

describe('questions the platform answers (labels from the census)', () => {
  it('address fields', () => {
    expect(answer({ question: 'CAP', type: 'text' })).toBe('22100');
    expect(answer({ question: 'Zip/Postal Code:', type: 'text' })).toBe('22100');
    expect(answer({ question: 'Qual è la tua via e il numero civico?', type: 'text' })).toBe(facts.address.street);
    expect(answer({ question: 'Qual è il nome della sua via di residenza?', type: 'text' })).toBe(facts.address.streetName);
    expect(answer({ question: 'Qual è il numero civico del suo indirizzo di residenza?', type: 'text' })).toBe(facts.address.houseNumber);
    expect(answer({ question: 'Qual è la tua città?', type: 'text' })).toBe('Como');
    expect(answer({ question: 'Nazione (di residenza)', type: 'choice', options: ['---', 'Svizzera', 'Italia', 'Egitto'] })).toBe('Italia');
    expect(answer({ question: 'Land/Region des Wohnorts:', type: 'choice', options: ['- Bitte auswählen -', 'Schweiz', 'Italien'] })).toBe('Italien');
  });

  it('is not misled by contact fields that mention «via» or «indirizzo»', () => {
    expect(platformQuestionTopic({ question: 'Accetti la comunicazione tramite WhatsApp?', applicationQuestion: 'Comunicazione via WhatsApp *' })).toBeNull();
    expect(platformQuestionTopic({ question: 'Indirizzo e-mail' })).toBeNull();
  });

  it('personal data: form of address, birth date (also split), civil status', () => {
    expect(answer({ id: 'salutation', question: 'Come vuoi essere indicato nei moduli di candidatura?', type: 'choice', options: ['Signor', 'Signora', 'Altro'] })).toBe('Signora');
    expect(answer({ question: 'Qual è la tua data di nascita?', type: 'date' })).toBe('1992-01-01');
    expect(answer({ question: 'In welchem Jahr sind Sie geboren?', type: 'choice', options: ['Jahr', ...Array.from({ length: 60 }, (_, index) => String(1950 + index))] })).toBe('1992');
    expect(answer({ question: 'In welchem Monat sind Sie geboren?', type: 'choice', options: ['Monat', '1.', '2.', '3.'] })).toBe('1.');
    expect(answer({ question: 'Qual è il tuo stato civile?', type: 'choice', options: ['Divorced (Switzerland)', 'Married (Switzerland)', 'Single'] })).toBe('Single');
  });

  it('permit, passport and nationality come from the upload answers', () => {
    const permitOptions = ['Ho la cittadinanza svizzera', 'Ho un permesso C (domicilio) valido oggi', 'Ho un permesso B (dimora) valido oggi', 'Lavoro oggi in Svizzera con un permesso G (frontalieri) valido', 'Oggi non ho un permesso svizzero'];
    expect(answer({ id: 'work_permit', question: 'Hai la cittadinanza svizzera o un permesso svizzero valido oggi?', type: 'choice', options: permitOptions })).toBe(permitOptions[3]);
    expect(answer({ question: 'Qual è il tuo attuale status di autorizzazione a lavorare in Svizzera?', applicationQuestion: 'Do you currently hold a valid Swiss work permit or Swiss passport that allows you to work in Switzerland without restrictions?', type: 'choice', options: ['Seleziona', 'Sì, ho un passaporto svizzero.', 'Sì, ho un permesso di lavoro valido (ad es. permesso C, B o G).', 'No, ma ho la cittadinanza EU/EFTA.'] }))
      .toBe('Sì, ho un permesso di lavoro valido (ad es. permesso C, B o G).');
    expect(answer({ question: 'Possiedi un passaporto svizzero/UE/EFTA?', type: 'yes_no', options: ['Seleziona un\'opzione', 'Sì', 'No'] })).toBe('Sì');
    expect(answer({ question: 'Nazionalità', type: 'choice', options: ['Selezionare', 'Svizzera', 'Tedesca', 'Italiana'] })).toBe('Italiana');
  });

  it('uses known nationality for Swiss/EU-EFTA passport prompts and catalog select options in all four languages', () => {
    const cases = [
      { locale: 'en', nationality: 'Italian', swissNationality: 'Swiss', binary: 'Do you hold a Swiss/EU/EFTA passport?', binaryOptions: ['Yes', 'No'], yes: 'Yes', no: 'No', select: 'Type of valid passport (select an option)', options: ['EU/EFTA passport', 'Swiss passport', 'Other'], expected: 'EU/EFTA passport', expectedSwiss: 'Swiss passport', expectedOther: 'Other' },
      { locale: 'it', nationality: 'Italiana', swissNationality: 'Svizzera', binary: 'Possiedi un passaporto svizzero/UE/AELS?', binaryOptions: ['Sì', 'No'], yes: 'Sì', no: 'No', select: 'Tipo di passaporto valido (seleziona un’opzione)', options: ['Passaporto UE/AELS', 'Passaporto svizzero', 'Altro'], expected: 'Passaporto UE/AELS', expectedSwiss: 'Passaporto svizzero', expectedOther: 'Altro' },
      { locale: 'de', nationality: 'Italienerin', swissNationality: 'Schweizerin', binary: 'Haben Sie einen Schweizer oder EU/EFTA-Reisepass?', binaryOptions: ['Ja', 'Nein'], yes: 'Ja', no: 'Nein', select: 'Art des gültigen Reisepasses (Option auswählen)', options: ['EU/EFTA-Reisepass', 'Schweizer Reisepass', 'Andere'], expected: 'EU/EFTA-Reisepass', expectedSwiss: 'Schweizer Reisepass', expectedOther: 'Andere' },
      { locale: 'fr', nationality: 'italienne', swissNationality: 'Suisse', binary: 'Détenez-vous un passeport suisse/UE/AELE ?', binaryOptions: ['Oui', 'Non'], yes: 'Oui', no: 'Non', select: 'Type de passeport valide (sélectionnez une option)', options: ['Passeport UE/AELE', 'Passeport suisse', 'Autre'], expected: 'Passeport UE/AELE', expectedSwiss: 'Passeport suisse', expectedOther: 'Autre' },
    ] as const;
    for (const testCase of cases) {
      const candidateFacts = platformCandidateFacts({ profile: { nationality: testCase.nationality }, nowMs: NOW, locale: testCase.locale });
      const binary = { question: testCase.binary, type: 'yes_no', options: testCase.binaryOptions };
      const select = { question: testCase.select, type: 'choice', options: testCase.options };
      expect(candidateFacts.passport, testCase.locale).toBe('eu_efta');
      expect(candidateFacts.passportSource, testCase.locale).toBe('nationality');
      expect(platformQuestionTopic(binary), testCase.locale).toBe('passport_swiss_eu_efta');
      expect(platformDefaultAnswer(binary, candidateFacts, { locale: testCase.locale })?.value, testCase.locale).toBe(testCase.yes);
      expect(platformQuestionTopic(select), testCase.locale).toBe('passport_type');
      expect(platformDefaultAnswer(select, candidateFacts, { locale: testCase.locale })?.value, testCase.locale).toBe(testCase.expected);
      const swissFacts = platformCandidateFacts({ profile: { nationality: testCase.swissNationality }, nowMs: NOW, locale: testCase.locale });
      expect(swissFacts.passport, testCase.locale).toBe('swiss');
      expect(platformDefaultAnswer(select, swissFacts, { locale: testCase.locale })?.value, testCase.locale).toBe(testCase.expectedSwiss);
      const otherFacts = platformCandidateFacts({ profile: { nationality: 'Ucraina' }, nowMs: NOW, locale: testCase.locale });
      expect(otherFacts.passport, testCase.locale).toBe('other');
      expect(platformDefaultAnswer(select, otherFacts, { locale: testCase.locale })?.value, testCase.locale).toBe(testCase.expectedOther);
      expect(platformDefaultAnswer(binary, otherFacts, { locale: testCase.locale })?.value, testCase.locale).toBe(testCase.no);
    }
    const swiss = platformCandidateFacts({ profile: { nationality: 'Schweizerin' }, nowMs: NOW, locale: 'de' });
    const other = platformCandidateFacts({ profile: { nationality: 'Ucraina' }, nowMs: NOW, locale: 'it' });
    expect(swiss.passport).toBe('swiss');
    expect(other.passport).toBe('other');
    const otherType = { question: 'Type of valid passport (select an option)', type: 'choice', options: ['EU/EFTA passport', 'Swiss passport', 'Other'] };
    expect(platformDefaultAnswer(otherType, other, { locale: 'en' })?.value).toBe('Other');
    expect(passportOf({ passport: 'swiss', nationality: 'Italiana' })).toBe('swiss');
    expect(passportOf({ nationality: 'nazionalità sconosciuta' })).toBe('');
    const unknown = platformCandidateFacts({ profile: {}, nowMs: NOW, locale: 'en' });
    expect(platformDefaultAnswer(otherType, unknown, { locale: 'en' })).toBeNull();
  });

  it('keeps one passport fact across nationality, candidate answers and verified platform decisions', () => {
    const binary = {
      id: 'passport_binary', source: 'portal', type: 'yes_no', required: true, options: [],
      question: 'Do you hold a Swiss/EU/EFTA passport?',
      platformDecision: { decision: 'answer', shape: 'yes_no', value: 'yes', principle: 'plausible_deduction',
        reason: 'The career makes this plausible.', version: 'decision-answers-v2' },
    };
    const type = { id: 'passport_type', source: 'portal', type: 'choice', required: true, options: [],
      question: 'Type of valid passport' };
    const cv = 'Cloud engineer with experience operating customer databases and container platforms.';
    const draft = { status: 'ready', round: 1, profile: {}, factSources: { text: cv }, questions: [binary, type] };
    const factsFor = (extra: Record<string, unknown> = {}, flow: Record<string, unknown> = {}, locale = 'en', profile = {}) => candidateWithEdits({
      order: { orderId: 'synthetic-order', applicantName: 'Candidato Prova', ...extra }, draft: { ...draft, profile }, flow, locale,
    }).platformFacts;

    expect(PLATFORM_DEFAULTS_VERSION).toBe('platform-defaults-v14');

    const swissJob = { kind: 'job', role: 'Cloud engineer', employer: 'Example SA', location: 'Lugano', start: '2021', end: 'oggi' };
    const permitProfile = { location: 'Como (CO)', experience: [swissJob] };
    const deduced = factsFor({}, {}, 'en', permitProfile);
    expect(deduced).toMatchObject({ permitStatus: 'permit_g', permitStatusSource: 'deduced', passport: 'eu_efta', passportSource: 'deduced' });
    const projected = withOperationalQuestionAnswers([binary, type], {}, { facts: deduced, locale: 'en' });
    expect(projected.answers).toMatchObject({ passport_binary: 'Yes', passport_type: 'EU/EFTA' });
    expect(projected.defaults.passport_binary).toMatchObject({ source: 'policy_default', basis: 'deduced' });
    expect(projected.defaults.passport_type).toMatchObject({ source: 'policy_default', basis: 'deduced' });
    expect(withPlatformSuggestions([binary, type], { facts: deduced, locale: 'en' })[1])
      .toMatchObject({ suggestedAnswer: 'EU/EFTA', answerOrigin: 'platform_rule' });

    const uploadWins = factsFor({ candidateFacts: { workPermit: 'permit_g', passport: 'swiss', nationality: 'Italiana' } });
    expect(uploadWins).toMatchObject({ passport: 'swiss', passportSource: 'candidate' });
    expect(platformDefaultAnswer(binary, uploadWins, { locale: 'en' })?.value).toBe('Yes');
    expect(platformDefaultAnswer(type, uploadWins, { locale: 'en' })?.value).toBe('Swiss');

    const typeWithOptions = { ...type, options: ['Swiss', 'EU/EFTA', 'Other'] };
    const candidateOther = factsFor({ candidateFacts: { workPermit: 'permit_g', passport: 'other' } });
    const coherent = withOperationalQuestionAnswers([binary, typeWithOptions], {}, { facts: candidateOther, locale: 'en' });
    expect(coherent.answers).toMatchObject({ passport_binary: 'No', passport_type: 'Other' });
    expect(candidateOther.decisionAnswers).toEqual({});

    const candidateTypeQuestion = { ...type, options: ['Swiss', 'EU/EFTA', 'Other (non-EU/EFTA)'] };
    const candidateType = candidateWithEdits({
      order: { orderId: 'synthetic-candidate-type', candidateFacts: { workPermit: 'permit_g' } },
      draft: { ...draft, questions: [binary, candidateTypeQuestion] },
      flow: { answers: { passport_type: 'Other (non-EU/EFTA)' } }, locale: 'en',
    }).platformFacts;
    expect(candidateType).toMatchObject({ passport: 'other', passportSource: 'candidate', decisionAnswers: {} });
    expect(platformDefaultAnswer(binary, candidateType, { locale: 'en' })?.value).toBe('No');
    expect(platformDefaultAnswer(candidateTypeQuestion, candidateType, { locale: 'en' })?.value).toBe('Other (non-EU/EFTA)');

    const ambiguousTypeQuestion = { ...type, options: ['Swiss/EU/EFTA'] };
    const ambiguousType = candidateWithEdits({
      order: { orderId: 'synthetic-ambiguous-type', candidateFacts: { workPermit: 'permit_g' } },
      draft: { ...draft, questions: [ambiguousTypeQuestion] },
      flow: { answers: { passport_type: 'Swiss/EU/EFTA' } }, locale: 'en',
    }).platformFacts;
    expect(ambiguousType).toMatchObject({ passport: '', passportSource: 'candidate' });
    expect(platformDefaultAnswer(ambiguousTypeQuestion, ambiguousType, { locale: 'en' })).toBeNull();

    const explicitBlank = factsFor({ candidateFacts: { workPermit: 'permit_g', passport: '', nationality: 'Italiana' } });
    expect(explicitBlank).toMatchObject({ passport: '', passportSource: 'candidate' });
    expect(platformDefaultAnswer(binary, explicitBlank, { locale: 'en' })).toBeNull();
    expect(platformDefaultAnswer(type, explicitBlank, { locale: 'en' })).toBeNull();

    const correctedBlank = factsFor(
      { candidateFacts: { workPermit: 'permit_g', nationality: 'Italiana' } },
      { formOverrides: { passport: '' } },
    );
    expect(correctedBlank).toMatchObject({ passport: '', passportSource: 'candidate', decisionAnswers: {} });
    const blankAnswer = factsFor(
      { candidateFacts: { workPermit: 'permit_g', nationality: 'Italiana' } },
      { answers: { passport_type: '' } },
    );
    expect(blankAnswer).toMatchObject({ passport: '', passportSource: 'candidate', decisionAnswers: {} });

    const noPermit = factsFor({ candidateFacts: { workPermit: 'none' } });
    expect(noPermit).toMatchObject({ passport: '', passportSource: '' });
    expect(platformDefaultAnswer(type, noPermit, { locale: 'en' })).toBeNull();
    const swissStatus = factsFor({ candidateFacts: { workPermit: 'swiss' } });
    expect(swissStatus).toMatchObject({ passport: '', passportSource: '' });
    expect(platformDefaultAnswer(binary, swissStatus, { locale: 'en' })).toBeNull();
    expect(platformDefaultAnswer(type, swissStatus, { locale: 'en' })).toBeNull();

    const unknown = candidateWithEdits({
      order: { orderId: 'synthetic-unknown', applicantName: 'Candidato Prova' },
      draft: { status: 'ready', round: 1, profile: {}, questions: [type] }, flow: {}, locale: 'en',
    }).platformFacts;
    expect(unknown).toMatchObject({ passport: '', passportSource: '' });
    expect(platformDefaultAnswer(type, unknown, { locale: 'en' })).toBeNull();
  });

  it('maps a verified EU/EFTA decision to the localized passport answer and the matching live option', () => {
    const binaryByLocale = {
      it: { question: 'Possiedi un passaporto svizzero/UE/AELS?', yes: 'Sì' },
      de: { question: 'Haben Sie einen Schweizer oder EU/EFTA-Reisepass?', yes: 'Ja' },
      fr: { question: 'Détenez-vous un passeport suisse/UE/AELE ?', yes: 'Oui' },
      en: { question: 'Do you hold a Swiss/EU/EFTA passport?', yes: 'Yes' },
    } as const;
    const typeByLocale = {
      it: { label: 'Tipo di passaporto valido', options: ['Svizzero', 'UE/AELS', 'Altro'], eu: 'UE/AELS' },
      de: { label: 'Art des gültigen Reisepasses', options: ['Schweizer', 'EU/EFTA', 'Andere'], eu: 'EU/EFTA' },
      fr: { label: 'Type de passeport valide', options: ['Suisse', 'UE/AELE', 'Autre'], eu: 'UE/AELE' },
      en: { label: 'Type of valid passport', options: ['Swiss', 'EU/EFTA', 'Other'], eu: 'EU/EFTA' },
    } as const;
    for (const locale of ['it', 'de', 'fr', 'en'] as const) {
      const binary = { id: 'passport_binary', source: 'portal', type: 'yes_no', required: true, options: [],
        question: binaryByLocale[locale].question,
        platformDecision: { decision: 'answer', shape: 'yes_no', value: 'yes', principle: 'plausible_deduction',
          reason: 'The career makes this plausible.', version: 'decision-answers-v2' },
      };
      const noOptions = { id: 'passport_type', source: 'portal', type: 'choice', required: true, options: [],
        question: typeByLocale[locale].label };
      const options = { ...noOptions, options: typeByLocale[locale].options };
      const draft = { status: 'ready', round: 1, profile: { location: 'Como (CO)', experience: [
        { kind: 'job', role: 'Cloud engineer', employer: 'Example SA', location: 'Lugano', start: '2021', end: 'oggi' },
      ] }, factSources: { text: 'Cloud engineer with experience in database operations.' }, questions: [binary, noOptions] };
      const facts = candidateWithEdits({
        order: { orderId: `synthetic-${locale}`, applicantName: 'Candidato Prova' },
        draft, flow: {}, locale,
      }).platformFacts;
      expect(platformDefaultAnswer(binary, facts, { locale })?.value, locale).toBe(binaryByLocale[locale].yes);
      expect(platformDefaultAnswer(noOptions, facts, { locale })?.value, locale).toBe(typeByLocale[locale].eu);
      expect(platformDefaultAnswer(noOptions, facts, { locale })?.basis, locale).toBe('deduced');
      expect(platformDefaultAnswer(options, facts, { locale })?.value, locale).toBe(typeByLocale[locale].eu);
      expect(platformDefaultAnswer({ question: 'Do you hold a Swiss passport?', type: 'yes_no', options: ['Yes', 'No'] }, facts, { locale }))
        .toMatchObject({ value: 'No', basis: 'deduced' });
      expect(platformDefaultAnswer({ question: 'Do you hold an EU/EFTA passport?', type: 'yes_no', options: ['Yes', 'No'] }, facts, { locale }))
        .toMatchObject({ value: 'Yes', basis: 'deduced' });
    }
  });

  it('uses a nationality-derived passport in descriptive permit options and keeps the answer marked as deduced', () => {
    const question = {
      question: 'Do you hold a Swiss work permit or EU/EFTA citizenship?', type: 'choice', options: [
        'Yes, I hold a valid G permit', 'No, but I have EU/EFTA citizenship', 'No, I have another nationality',
      ],
    };
    const facts = platformCandidateFacts({ profile: { nationality: 'Italian' }, nowMs: NOW, locale: 'en' });
    const result = platformDefaultAnswer(question, facts, { locale: 'en' });
    expect(result).toMatchObject({ value: 'No, but I have EU/EFTA citizenship', basis: 'deduced' });
  });

  it('languages from the CV, the CV language as native', () => {
    expect(answer({ question: 'Qual è il livello di italiano parlato?', type: 'choice', options: ['---', 'Lingua madre', 'Fluente', 'Avanzato', 'Conoscenze di base'] })).toBe('Lingua madre');
    expect(answer({ question: 'Qual è il tuo livello di inglese?', type: 'choice', options: ['A1 (Principiante)', 'A2 (Pre-intermedio)', 'B1 (Intermedio)', 'B2 (Intermedio superiore)', 'C1 (Avanzato)'] })).toBe('B2 (Intermedio superiore)');
    expect(answer({ question: 'Qual è il tuo livello di tedesco?', type: 'choice', options: ['Native - Proficiency - C2', 'Advanced - C1', 'High - B2', 'Intermediate - B1', 'Basic A1/A2', 'I don’t speak this language'] })).toBe('Basic A1/A2');
    expect(answer({ question: 'Qual è il tuo livello di francese?', type: 'choice', options: ['Base', 'Fluente'] })).toBeNull();
  });

  it('salary, workload, start date', () => {
    expect(answer({ question: 'Qual è la tua aspettativa salariale?', type: 'text' })).toBe("CHF 88'000 lordi annui");
    expect(answer({ question: 'Qual è la tua aspettativa salariale annua in CHF?', type: 'number' })).toBe('88000');
    // The workload is the owner's preference (assistedApplicationOperationalAnswers.js), read with the census wording.
    expect(operationalDefaultAnswer({ question: 'Qual è il tuo carico di lavoro preferito?', type: 'text', required: true }, { facts })?.value).toBe('100%');
    expect(operationalDefaultAnswer({ question: 'Qual è il tuo grado d\'impiego desiderato?', applicationQuestion: 'gewünschtes Arbeitspensum', type: 'text', required: true }, { facts })?.value).toBe('100%');
    expect(operationalDefaultAnswer({ question: 'Qual è la tua disponibilità lavorativa desiderata in percentuale?', applicationQuestion: 'What is your desired workload (in %)?* (required)', type: 'number', required: true }, { facts })?.value).toBe('100');
    expect(operationalDefaultAnswer({ question: 'Il datore richiede un grado di occupazione del 100%', type: 'text' }, { facts })).toBeNull();
    expect(answer({ question: 'Da quale data puoi iniziare a lavorare?', type: 'date' })).toBe('2027-02-09');
    expect(answer({ question: 'Quando potresti iniziare? Indica una data oppure specifica se sei disponibile subito.', type: 'text' })).toBe('09.02.2027');
  });

  it('does not put platform availability dates into historical experience or education rows', () => {
    const historyRows = [
      { label: 'Start Date', section: 'Work Experience' },
      { label: 'Start Date', section: 'Education' },
      { label: 'Eintrittsdatum', section: 'Berufserfahrung' },
      { label: 'Eintrittsdatum', section: 'Ausbildung' },
      { label: 'Data di inizio', section: 'Esperienza professionale' },
      { label: 'Data di inizio', section: 'Formazione' },
      { label: 'Date de début', section: 'Expérience professionnelle' },
      { label: 'Date de début', section: 'Formation' },
      { label: 'Date de début', section: 'Éducation' },
      { label: 'Start Date', group: { label: 'Previous Employment' } },
      { label: 'Start Date', context: 'Education · Institution · Start Date · End Date' },
    ];
    const candidate = { answers: {}, identity: {}, profile: {}, platformFacts: facts };

    for (const row of historyRows) {
      const question = { ...row, type: 'date' };
      expect(platformQuestionTopic(question), `${row.label} in ${row.section || row.group?.label || row.context}`).toBeNull();
      expect(platformDefaultAnswer(question, facts), row.label).toBeNull();
      expect(candidateAnswerForField(candidate, { ...row, kind: 'text', inputType: 'date' }), row.label).toBeNull();
    }
  });

  it('keeps standalone start-date questions on the platform default', () => {
    const candidate = { answers: {}, identity: {}, profile: {}, platformFacts: facts };
    for (const label of ['Start Date', 'Earliest start date', 'Frühestmögliches Eintrittsdatum']) {
      const question = { label, type: 'date' };
      expect(platformQuestionTopic(question), label).toBe('start_date');
      expect(platformDefaultAnswer(question, facts)).toMatchObject({ topic: 'platform:start_date', source: 'policy_default' });
      expect(candidateAnswerForField(candidate, { label, kind: 'text', inputType: 'date' }))
        .toMatchObject({ topic: 'platform:start_date', source: 'policy_default' });
    }
  });

  it('consents, marketing and availabilities', () => {
    expect(answer({ question: 'Puoi fornire il consenso informato alla partecipazione, alla registrazione della conversazione e all’uso dell’audio per il progetto di IA?', type: 'yes_no', options: ['Sì', 'No'] })).toBe('Sì');
    expect(answer({ question: 'Desideri ricevere informazioni sulle opportunità di formazione e sui corsi di TSMG Academy oltre alle comunicazioni relative alla selezione?', type: 'choice', options: ['Yes', 'No'] })).toBe('No');
    // The privacy notice is the existing consent grammar's (lib/applicationConsent.js), with the census pair.
    expect(operationalDefaultAnswer({ question: 'Seleziona questa casella per confermare di aver letto l\'Informativa sulla privacy per i candidati.', applicationQuestion: 'Please check this box to acknowledge that you have read the Applicant Privacy Notice.', type: 'text', required: true, source: 'portal' }, { facts })).toMatchObject({ topic: 'privacy_review_ack' });
    expect(answer({ question: 'Sei disponibile a trasferirti nel Canton Ticino, in Svizzera, per questo ruolo?', type: 'yes_no', options: ['Sì', 'No'] })).toBe('Sì');
    expect(answer({ question: 'Sei disponibile a lavorare in modalità ibrida, con presenza presso la sede di Cadempino?', type: 'yes_no', options: ['Sì', 'No'] })).toBe('Sì');
    expect(answer({ question: 'Sei disponibile a partecipare al servizio di picchetto 24h secondo il regolamento aziendale?', type: 'yes_no' })).toBe('Sì');
    // Left by lib/mobilityRequirements.js only for a current residence: a fact, never the platform's.
    expect(answer({ id: 'mobility_requirement_abc', question: 'Puoi soddisfare tutte le condizioni di residenza o trasferimento riportate qui?', type: 'yes_no', options: ['Sì', 'No'] })).toBeNull();
    expect(answer({ question: 'Hai meno di 26 anni?', type: 'yes_no', options: ['Oui', 'Non'] })).toBe('Non');
  });

  it('leaves compound prompts and other parties\' addresses to the candidate', () => {
    for (const question of [
      'What is your notice period and earliest possible start date?',
      'Qual è il preavviso e la data di inizio?',
      'Comunicazione via WhatsApp e consenso privacy',
      'I consent to the processing of my personal data for marketing and future job offers.',
    ]) expect(answer({ question, type: 'text' })).toBeNull();
    expect(answer({ question: 'City', type: 'text', context: 'Employer' })).toBeNull();
    expect(answer({ question: 'City', type: 'text', addressContext: { section: 'Employer', owners: ['Employer'], unknown: false } })).toBeNull();
    expect(answer({ question: 'City', type: 'text', addressContext: { section: '', owners: [], unknown: true } })).toBeNull();
    expect(answer({ question: 'City', type: 'text', addressContext: { section: 'Personal information', owners: ['Personal information'], unknown: false } })).toBe('Como');
    // Helsana (2026-11-10): the candidate's own profile and application form own the address.
    const profileOwned = { section: 'IT Management Assistenz (a) 80% (34525)', owners: ['Profilinformationen', 'Stellenbewerbungsformular'], unknown: false };
    expect(platformQuestionTopic({ question: '* Via, n.', applicationQuestion: '* Strasse, Nr.', type: 'text', required: true, source: 'portal', addressContext: profileOwned })).toBe('address_street');
    expect(answer({ question: 'City', type: 'text', addressContext: { section: 'Mein Profil', owners: ['Mein Profil'], unknown: false } })).toBe('Como');
    expect(answer({ question: 'City', type: 'text', addressContext: { section: 'Arbeitgeber', owners: ['Profilinformationen', 'Arbeitgeber'], unknown: false } })).toBeNull();
  });

  it('leaves the questions only the candidate can answer', () => {
    for (const question of [
      'Quanti anni di esperienza ha maturato come Concierge in hotel 5 stelle? Indichi anche le strutture.',
      'È in possesso di una patente di guida valida di categoria B?',
      'Puoi fornire un casellario giudiziale pulito?',
      'Hai maturato esperienza in una società di consulenza Big Four o in un ambiente equivalente?',
    ]) expect(answer({ question, type: 'text' })).toBeNull();
  });
});

describe('wiring', () => {
  it('extends the operational defaults and the runner whitelist with the same value', () => {
    const question = { id: 'portal_cap', question: 'CAP', type: 'text', required: true, source: 'portal' };
    const value = operationalDefaultAnswer(question, { facts });
    expect(value).toMatchObject({ value: '22100', source: 'policy_default' });
    expect(isOperationalDefaultValue(question, '22100', { facts })).toBe(true);
    expect(isOperationalDefaultValue(question, '22101', { facts })).toBe(false);
    // Without a candidate only the facts that need none apply.
    expect(operationalDefaultAnswer(question)).toBeNull();
    expect(operationalDefaultAnswer({ id: 'on_call', question: 'Sei disponibile al picchetto?', type: 'yes_no', required: true })).toMatchObject({ value: 'Sì' });
    expect(withOperationalQuestionAnswers([question], {}, { facts }).defaults.portal_cap).toBeTruthy();
  });

  it('clears the candidate holds of the questions the platform answers', () => {
    const draft = {
      status: 'ready', round: 1, language: 'it',
      job: { source: 'job_detail' }, channel: { type: 'portal', applyUrl: 'https://jobs.example.test/apply' },
      factCheck: { ok: true, unsupported: [] },
      profile: { fullName: 'Giulia Rossi', location: 'Como (CO)', languages: [{ language: 'Inglese', level: 'B2' }], cvLanguage: 'it', education: [{ degree: 'Maturità', end: '2010' }] },
      questions: [
        { id: 'portal_cap', question: 'CAP', type: 'text', required: true, source: 'portal' },
        { id: 'portal_birth', question: 'Qual è la tua data di nascita?', type: 'date', required: true, source: 'portal' },
        { id: 'salary_expectation', question: 'Qual è la tua aspettativa salariale?', type: 'text', required: true, source: 'match' },
        { id: 'licence', question: 'È in possesso di una patente di guida valida di categoria B?', type: 'yes_no', required: true, source: 'match' },
      ],
    };
    const order = { userId: 'user-1', applicantName: 'Giulia Rossi', salaryMax: 88000 };
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual(['licence']);
  });

  it('fills the form candidate, never the profile the letter is written from', () => {
    const order = { userId: 'user-1', applicantName: 'Giulia Rossi' };
    const draft = { language: 'it', profile: { fullName: 'Giulia Rossi', location: 'Como (CO)', education: [{ degree: 'Maturità', end: '2010' }] }, questions: [] };
    const edited = candidateWithEdits({ order, draft, flow: {} });
    expect(edited.profile.address?.street).toBeFalsy();
    expect(edited.profile.dateOfBirth).toBeFalsy();
    expect(edited.answers.salutation).toBe('Signora');
    const candidate = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers, personal: edited.personal, platformFacts: edited.platformFacts });
    expect(candidate.identity.address).toMatchObject({ street: edited.platformFacts.address.street, postalCode: '22100', country: 'Italia' });
    expect(candidate.profile).toMatchObject({ dateOfBirth: '1992-01-01', civilStatus: 'Celibe/Nubile' });
  });

  it('uses the permit and nationality asked at upload', () => {
    const order = { userId: 'user-1', applicantName: 'Marco Bianchi', candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } };
    const draft = { language: 'it', profile: { fullName: 'Marco Bianchi' }, questions: [{ id: 'work_permit', question: 'Hai la cittadinanza svizzera o un permesso svizzero valido oggi?', type: 'choice', required: true, source: 'match' }] };
    const edited = candidateWithEdits({ order, draft, flow: {} });
    expect(edited.profile).toMatchObject({ permitStatus: 'permit_g', nationality: 'Italiana' });
    expect(edited.answers.work_permit).toBe('Lavoro oggi in Svizzera con un permesso G (frontalieri) valido');
  });
});

describe('review of #17764', () => {
  const en = (question: Record<string, unknown>, given: any) => platformDefaultAnswer({ required: true, ...question }, given, { locale: 'en' })?.value ?? null;
  const withPassport = (passport: string, nationality = '') => platformCandidateFacts({ order: { candidateFacts: { workPermit: 'none', passport, nationality } }, nowMs: NOW, locale: 'en' });

  it('answers a passport prompt only for the passport it names', () => {
    expect(en({ question: 'Do you hold a Swiss passport?', type: 'yes_no' }, withPassport('eu_efta'))).toBe('No');
    expect(en({ question: 'Do you hold a Swiss passport?', type: 'yes_no' }, withPassport('swiss'))).toBe('Yes');
    expect(en({ question: 'Do you hold an EU/EFTA passport?', type: 'yes_no' }, withPassport('swiss'))).toBe('No');
    expect(en({ question: 'Do you hold an EU/EFTA passport?', type: 'yes_no' }, withPassport('eu_efta'))).toBe('Yes');
    expect(en({ question: 'Do you hold a Swiss / EU / EFTA passport?', type: 'yes_no' }, withPassport('eu_efta'))).toBe('Yes');
    expect(en({ question: 'Do you hold a Swiss / EU / EFTA passport?', type: 'yes_no' }, withPassport('other'))).toBe('No');
  });

  it('never picks an option for a nationality it does not recognize', () => {
    expect(en({ question: 'Nationality', type: 'choice', options: ['Other', 'Italian', 'Swiss'] }, withPassport('other', 'Klingon'))).toBeNull();
    expect(en({ question: 'Nationality', type: 'text' }, withPassport('other', 'Klingon'))).toBe('Klingon');
    expect(en({ question: 'Nationality', type: 'choice', options: ['Other', 'Italian', 'Swiss'] }, withPassport('eu_efta', 'Italiana'))).toBe('Italian');
  });

  it('makes the CV language the mother tongue even when the parser gave it a level', () => {
    const given = platformCandidateFacts({ profile: { cvLanguage: 'it', languages: [{ language: 'Italian', level: 'B2' }] }, nowMs: NOW, locale: 'en' });
    expect(given.languages).toEqual([{ code: 'it', level: 'native', inferred: true }]);
    expect(en({ question: 'What is your Italian level?', type: 'choice', options: ['Native', 'C1', 'B2', 'B1'] }, given)).toBe('Native');
  });

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
    // An order that already has its estimate is handed on unchanged.
    expect((await orderWithSalaryEstimate({ order: { jobId: 'job-1', salaryMax: 5 }, write: async () => {}, fetchImpl: (async () => { throw new Error('unexpected'); }) as any })).order).toEqual({ jobId: 'job-1', salaryMax: 5 });
  });
});

describe('review of #17879', () => {
  it('derives passport class from a known nationality, but never from a work permit', () => {
    expect(passportOf({ nationality: 'Italy' } as any)).toBe('eu_efta');
    expect(passportOf({ permitStatus: 'swiss' } as any)).toBe('');
    expect(passportOf({ passport: 'eu_efta' })).toBe('eu_efta');
  });

  it('keeps a natively required control required when the generic flag says otherwise', () => {
    const field = { id: 'f1', kind: 'text', label: 'Codice fiscale', required: false, portalNativeContract: { required: true } };
    const plan = guardPlan({ actions: [], missingRequired: [] }, [field], { identity: {}, profile: {}, answers: {} });
    expect(plan.missingRequired).toContainEqual(expect.objectContaining({ fieldId: 'f1' }));
  });
});

describe('residence region (State / Kanton / Provincia), deduced from the CV town (Damiani 2026-11-10)', () => {
  const portal = (question: string, extra = {}) => ({ id: 'q', source: 'portal', type: 'text', question, applicationQuestion: question,
    context: 'Profile Information · * Address · * City · * State · * Zip Code · * Country', ...extra });
  const lugano = platformCandidateFacts({ profile: { location: 'Lugano' }, nowMs: NOW, locale: 'en' });
  const como = platformCandidateFacts({ profile: { location: 'Como (CO)' }, nowMs: NOW, locale: 'it' });

  it('answers the canton or the province of the town the CV names', () => {
    expect(lugano.address).toMatchObject({ country: 'CH', region: 'TI' });
    expect(platformDefaultAnswer(portal('* State'), lugano, { locale: 'en' })).toMatchObject({ value: 'Ticino', topic: 'platform:residence_region' });
    expect(platformDefaultAnswer(portal('Kanton'), lugano, { locale: 'de' })?.value).toBe('Ticino');
    expect(platformDefaultAnswer(portal('Provincia di residenza'), como)?.value).toBe('CO');
    // A select takes its own option for the code or the name.
    expect(platformDefaultAnswer(portal('* State', { type: 'choice', options: ['Ticino (TI)', 'Zürich (ZH)'] }), lugano, { locale: 'en' })?.value).toBe('Ticino (TI)');
    expect(platformDefaultAnswer(portal('Canton', { type: 'choice', options: ['TI', 'ZH'] }), lugano, { locale: 'fr' })?.value).toBe('TI');
  });

  it('never answers a country, a preference, another party or an unknown town', () => {
    expect(platformQuestionTopic(portal('Stato'))).not.toBe('residence_region');
    expect(platformDefaultAnswer(portal('Preferred region'), lugano, { locale: 'en' })).toBeNull();
    expect(platformDefaultAnswer(portal('Gewünschte Arbeitsregion'), lugano, { locale: 'de' })).toBeNull();
    expect(platformDefaultAnswer(portal('* State', { context: 'Employer address · * State' }), lugano, { locale: 'en' })).toBeNull();
    const unknown = platformCandidateFacts({ profile: { location: 'Atlantis' }, nowMs: NOW, locale: 'en' });
    expect(platformDefaultAnswer(portal('* State'), unknown, { locale: 'en' })).toBeNull();
    // A select without the region's option is left, not forced.
    expect(platformDefaultAnswer(portal('* State', { type: 'choice', options: ['Bern', 'Zürich'] }), lugano, { locale: 'en' })).toBeNull();
  });
});

describe('address fields in the candidate own form whose labels name a company (Yellowshark 2026-11-10)', () => {
  const context = 'Anrede · Company · Frau · Herr · Vorname · Nachname · E-Mail · Email workflow step · Strasse · Hausnummer · PLZ · Ort · Land · Nationalität · Mobile · Telefon (optional) · Geburtstag · Monat · Jahr · Ich akzeptiere die Datenschutzerklärung';
  const field = (applicationQuestion: string, extra = {}) => ({ id: 'q', source: 'portal', type: 'text', required: true,
    applicationQuestion, question: applicationQuestion, context, section: 'Hier sind Sie richtig', ...extra });
  const como = platformCandidateFacts({ profile: { location: 'Como (CO)' }, nowMs: NOW, locale: 'de' });

  it('answers street, house number and postal code from the platform address', () => {
    expect(platformQuestionTopic(field('Strasse'))).toBe('address_street_name');
    expect(platformDefaultAnswer(field('Strasse'), como, { locale: 'de' })?.value).toBe(como.address.streetName);
    expect(platformDefaultAnswer(field('Hausnummer'), como, { locale: 'de' })?.value).toBe(como.address.houseNumber);
    expect(platformDefaultAnswer(field('PLZ'), como, { locale: 'de' })?.value).toBe(como.address.postalCode);
  });

  it('still leaves an address whose own section or label names another party', () => {
    expect(platformQuestionTopic(field('Strasse', { section: 'Arbeitgeber' }))).toBeNull();
    expect(platformQuestionTopic(field('Strasse', { context: 'Firma · Ansprechpartner · Strasse · PLZ · Ort' }))).toBeNull();
    // A French form names the surname «Nom» (review of #18036).
    expect(platformQuestionTopic(field('Rue', { context: 'Nom · Prénom · Entreprise · Rue', section: '' }))).toBe('address_street');
    // A phone number beside the street is no house-number field: the street keeps its number.
    expect(platformQuestionTopic(field('Indirizzo', { context: 'Nome · Cognome · E-mail · Indirizzo · Numero di telefono' }))).toBe('address_street');
  });
});

describe('CV locations as real CVs write them (census 2026-11-10: 38 of 44 towns resolved)', () => {
  const at = (location: string) => platformCandidateFacts({ profile: { location }, nowMs: NOW, locale: 'it' }).address;

  it('reads a town followed by its province written out, or by a note in brackets', () => {
    expect(at('Cantù, Como')).toMatchObject({ city: 'Cantù', country: 'IT', postalCode: expect.stringMatching(/^\d{5}$/) });
    expect(at('Lugano (Abitazione)')).toMatchObject({ city: 'Lugano', country: 'CH', postalCode: '6900' });
    // The province code in brackets is still a region, not a note.
    expect(at('Como (CO)')).toMatchObject({ city: 'Como', country: 'IT' });
  });

  it('deduces the country of a town abroad even without a public postal list for it', () => {
    expect(at('Valencia, Spain')).toMatchObject({ country: 'ES', countryName: 'Spagna', postalCode: '' });
    expect(at('Bucarest, Romania')).toMatchObject({ country: 'RO', countryName: 'Romania' });
    // A hyphenated country name (review of #18036).
    expect(at('London, Royaume-Uni')).toMatchObject({ city: 'London', country: 'GB' });
  });

  it('never takes another word of the text for a town', () => {
    expect(at('Zona industriale, Nessunluogo').postalCode).toBe('');
  });
});
