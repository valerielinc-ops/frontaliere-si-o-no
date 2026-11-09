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
  ageOn,
  platformCandidateFacts,
  platformDateOfBirth,
  platformDefaultAnswer,
  platformPostalCode,
  platformQuestionTopic,
  platformStartDate,
  sanitizeCandidateFacts,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer, isOperationalDefaultValue, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { ensureOrderSalaryEstimate } from '../functions/src/assistedApplicationJobCard.js';

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

  it('accepts only a complete, valid set of upload answers', () => {
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: ' Italiana ' })).toEqual({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' });
    expect(sanitizeCandidateFacts({ workPermit: 'permit_x', passport: 'eu_efta', nationality: 'Italiana' })).toBeNull();
    expect(sanitizeCandidateFacts({ workPermit: 'permit_g', passport: 'eu_efta' })).toBeNull();
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
});
