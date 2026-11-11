/**
 * Three owner decisions of 2026-11-11 on the questions the platform answers without the candidate.
 *
 *  1. Nationality deduced from the CV when the candidate gave none (Yellowshark 1EpmkrDu, an order uploaded
 *     before the nationality was asked): «se ha studiato il liceo lì la sua nazionalità è di quel paese,
 *     utilizza regole multiple per avere più segnali di deduzione». The upper secondary school wins; without it,
 *     two concordant signals and no strong one against; otherwise unknown. Never a web search. Second part, the
 *     same day: more offline signals (the CV's declaration, the codice fiscale's place of birth, the phone prefix,
 *     the CV's language), never the name.
 *  2. Criminal record: always «no conviction» (SBB ifB89NW2). A question is «no», a statement of none «yes», a
 *     choice its option of none. The extract to attach stays a document; the debt-enforcement register is not
 *     this rule.
 *  3. «Attestato»: an upload takes the paper, a text or a choice field the title the CV declares.
 *
 * Every candidate, CV and school here is invented.
 */
import { describe, expect, it } from 'vitest';
import {
  candidatePhoneCountry,
  codiceFiscaleBirthCountry,
  codiceFiscaleValid,
  cvBirthplaceCountry,
  cvDeclaredNationality,
  deducedNationality,
  institutionCountry,
  PLATFORM_DEFAULTS_VERSION,
  platformCandidateFacts,
  platformDefaultAnswer,
  platformQuestionTopic,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { OPERATIONAL_DEFAULTS_VERSION } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateOnlyCategory, experienceQuestionKind } from '../functions/src/assistedApplicationDecisionAnswers.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';

const NOW = Date.UTC(2026, 10, 11, 12);
const liceo = { degree: 'Diploma di maturità scientifica', institution: 'Liceo Scientifico Statale, Varese', start: '2004', end: '2009' };
const university = { degree: 'Laurea magistrale in Ingegneria', institution: 'Politecnico di Milano', start: '2009', end: '2014' };
const facts = (profile: object, extra: object = {}) => platformCandidateFacts({ order: { userId: 'u-test' }, profile, nowMs: NOW, seed: 'u-test', ...extra });
// candidateWithEdits as the review page calls it; its JSDoc names neither `locale` as optional nor `platformFacts`.
const platformFactsOf = (input: object) => (candidateWithEdits as unknown as (value: object) => { platformFacts: Record<string, unknown> })(input).platformFacts;
const nationalityQuestion = (options: string[] = [], question = 'Nationalität') => ({
  id: 'portal_nationalitat', source: 'portal', question, applicationQuestion: question, type: options.length ? 'choice' : 'text', options,
});

describe('versions', () => {
  it('lets the recovery by version read the held questions again', () => {
    expect(PLATFORM_DEFAULTS_VERSION).toBe('platform-defaults-v12');
    expect(OPERATIONAL_DEFAULTS_VERSION).toBe('operational-preferences-v12');
  });
});

describe('the nationality deduced from the CV (owner decision 2026-11-11)', () => {
  it('reads the country of a school from its town, its Swiss words, a written country or its typical words', () => {
    expect(institutionCountry('Liceo Scientifico Statale, Varese')).toBe('IT');
    expect(institutionCountry('Liceo cantonale di Lugano')).toBe('CH');
    expect(institutionCountry('Kantonsschule Musterstadt')).toBe('CH');
    expect(institutionCountry('Istituto Tecnico Industriale Statale «A. Prova»')).toBe('IT');
    expect(institutionCountry('Gymnasium am Stadtpark, Deutschland')).toBe('DE');
    expect(institutionCountry('Abitur, Musterschule')).toBe('DE');
    // Nothing that places it: unknown, never a guess.
    expect(institutionCountry('High School')).toBe('');
    expect(institutionCountry('')).toBe('');
  });

  it('reads the place of birth the CV writes, in the four languages', () => {
    expect(cvBirthplaceCountry('Nato a Como il 3 aprile 1990')).toBe('IT');
    expect(cvBirthplaceCountry('Luogo di nascita: Lugano')).toBe('CH');
    expect(cvBirthplaceCountry('Data e luogo di nascita: 03/04/1990, Varese')).toBe('IT');
    expect(cvBirthplaceCountry('Geburtsort: Zürich')).toBe('CH');
    expect(cvBirthplaceCountry('Born in Milano')).toBe('IT');
    // No place of birth, or one the directory cannot place.
    expect(cvBirthplaceCountry('Data di nascita: 03/04/1990')).toBe('');
    expect(cvBirthplaceCountry('Luogo di nascita: Atlantide')).toBe('');
    expect(cvBirthplaceCountry('La NATO a Bruxelles')).toBe('');
  });

  it('gives the country of the upper secondary school, whatever else the CV says', () => {
    const profile = { education: [liceo], languages: [{ language: 'Deutsch', level: 'Muttersprache' }], location: 'Lugano' };
    expect(deducedNationality({ profile, cvText: 'Geburtsort: Zürich', residenceCountry: 'CH' })).toEqual({ code: 'IT', signals: ['upper_secondary_school'] });
    expect(deducedNationality({ profile: { education: [{ degree: 'Maturità liceale', institution: 'Liceo cantonale di Lugano' }] } })?.code).toBe('CH');
    // Two upper secondary schools in two countries: no winner, and they stand against each other.
    expect(deducedNationality({ profile: { education: [liceo, { degree: 'Abitur', institution: 'Gymnasium, Deutschland' }] }, residenceCountry: 'IT' })).toBeNull();
  });

  it('without the school, needs two concordant signals and no strong one against', () => {
    const italian = [{ language: 'Italiano', level: 'Madrelingua' }];
    expect(deducedNationality({ profile: { languages: italian }, residenceCountry: 'IT' })).toEqual({ code: 'IT', signals: ['mother_tongue', 'residence'] });
    expect(deducedNationality({ profile: { languages: italian }, cvText: 'Nato a Como il 3 aprile 1990' })?.code).toBe('IT');
    // The legacy order of the decision: no school, no place of birth, a university and the residence in one country.
    expect(deducedNationality({ profile: { education: [university] }, residenceCountry: 'IT' })).toEqual({ code: 'IT', signals: ['university', 'residence'] });
    // A strong signal against: unknown.
    expect(deducedNationality({ profile: { languages: italian }, cvText: 'Luogo di nascita: Lugano', residenceCountry: 'IT' })).toBeNull();
    // One signal only, or two of one kind.
    expect(deducedNationality({ profile: { languages: italian } })).toBeNull();
    expect(deducedNationality({ profile: {}, residenceCountry: 'IT' })).toBeNull();
    expect(deducedNationality({ profile: { education: [university, { degree: 'Master', institution: 'Università degli Studi, Como' }] } })).toBeNull();
    // A university and a residence in two countries: no country gathers two.
    expect(deducedNationality({ profile: { education: [university] }, residenceCountry: 'CH' })).toBeNull();
  });

  it('reads German or French as a mother tongue only as a confirmation', () => {
    const german = [{ language: 'Deutsch', level: 'Muttersprache' }];
    // Alone it names no country (DE, AT, CH).
    expect(deducedNationality({ profile: { languages: german } })).toBeNull();
    // It confirms the country another signal names, and never stands against one.
    expect(deducedNationality({ profile: { languages: german }, cvText: 'Geburtsort: Zürich' })?.code).toBe('CH');
    expect(deducedNationality({ profile: { languages: german }, cvText: 'Nato a Como il 3 aprile 1990', residenceCountry: 'IT' })?.code).toBe('IT');
    // A level that is no mother tongue is no signal; a bilingual one neither.
    expect(deducedNationality({ profile: { languages: [{ language: 'Italiano', level: 'C2' }] }, residenceCountry: 'IT' })).toBeNull();
    expect(deducedNationality({ profile: { languages: [{ language: 'Italiano', level: 'Bilingue madrelingua' }] }, residenceCountry: 'IT' })).toBeNull();
  });

  it('marks the fact as deduced, and the candidate\'s own nationality always wins', () => {
    const deduced = facts({ education: [liceo], location: 'Como' }, { locale: 'de' });
    expect(deduced).toMatchObject({ nationality: 'Italien', nationalitySource: 'deduced', nationalityCode: 'IT' });
    // Stated in the CV, at upload, or in an answer: nothing is deduced.
    expect(facts({ education: [liceo], nationality: 'Svizzera' })).toMatchObject({ nationality: 'Svizzera', nationalitySource: 'candidate', nationalityCode: 'CH' });
    expect(platformCandidateFacts({ order: { candidateFacts: { workPermit: 'permit_b', passport: 'other', nationality: 'Kosovara' } }, profile: { education: [liceo] }, nowMs: NOW }))
      .toMatchObject({ nationality: 'Kosovara', nationalitySource: 'candidate' });
    // Their answer to the nationality question is the answer itself: nothing is deduced beside it.
    expect(facts({ education: [liceo] }, { answers: { nationality: 'Francese' } })).toMatchObject({ nationality: '', nationalitySource: '' });
    // A cleared correction or answer of theirs (`nationalityDeduction` false) is their word too, even empty.
    expect(facts({ education: [liceo] }, { nationalityDeduction: false })).toMatchObject({ nationality: '', nationalitySource: '' });
    // Nothing to read: unknown, never invented.
    expect(facts({ location: 'Como' })).toMatchObject({ nationality: '', nationalitySource: '', nationalityCode: '' });
  });

  it('does not deduce over a correction or an answer the candidate gave, even emptied (candidateWithEdits)', () => {
    const order = { userId: 'u-test', locale: 'de' };
    const draft = { profile: { education: [liceo], location: 'Como' }, questions: [], factSources: { text: '' } };
    expect(platformFactsOf({ order, draft, flow: { answers: {} } })).toMatchObject({ nationalitySource: 'deduced', nationalityCode: 'IT' });
    expect(platformFactsOf({ order, draft, flow: { answers: {}, formOverrides: { nationality: '' } } }))
      .toMatchObject({ nationality: '', nationalitySource: '' });
    expect(platformFactsOf({ order, draft, flow: { answers: { nationality: '' } } })).toMatchObject({ nationalitySource: '' });
    // The CV text reaches the rule: the place of birth with the mother tongue.
    const birth = { profile: { languages: [{ language: 'Italiano', level: 'Madrelingua' }] }, questions: [], factSources: { text: 'Nato a Como il 3 aprile 1990' } };
    expect(platformFactsOf({ order, draft: birth, flow: { answers: {} } })).toMatchObject({ nationalitySource: 'deduced', nationalityCode: 'IT' });
  });

  it('answers the nationality question in the form\'s own words, marked as deduced', () => {
    const known = facts({ education: [liceo], location: 'Como' });
    // The Yellowshark list of country names in German, its prompt first.
    expect(platformDefaultAnswer(nationalityQuestion(['Nationalität', 'Albanien', 'Italien', 'Schweiz']), known))
      .toMatchObject({ value: 'Italien', topic: 'platform:nationality', source: 'policy_default', basis: 'deduced', version: PLATFORM_DEFAULTS_VERSION });
    expect(platformDefaultAnswer(nationalityQuestion(['Aucune sélection', 'Allemand', 'Italien', 'Suisse'], 'Qual è la tua nazionalità?'), known)?.value).toBe('Italien');
    expect(platformDefaultAnswer(nationalityQuestion(['Selezionare', 'Svizzera', 'Tedesca', 'Italiana'], 'Nazionalità'), known)?.value).toBe('Italiana');
    expect(platformDefaultAnswer(nationalityQuestion(['Germany', 'Italy', 'Switzerland'], 'Citizenship'), known)?.value).toBe('Italy');
    expect(platformDefaultAnswer(nationalityQuestion([], 'Nazionalità'), known, { locale: 'it' })?.value).toBe('italiana');
    expect(platformDefaultAnswer(nationalityQuestion([], 'Staatsangehörigkeit'), known, { locale: 'de' })?.value).toBe('Italien');
    expect(platformDefaultAnswer(nationalityQuestion([], 'Nationality'), known, { locale: 'en' })?.value).toBe('Italian');
    // A list without the country: no answer.
    expect(platformDefaultAnswer(nationalityQuestion(['Albanien', 'Schweiz']), known)).toBeNull();
    // The candidate's own nationality is not marked as deduced.
    expect(platformDefaultAnswer(nationalityQuestion(['Albanien', 'Italien']), facts({ nationality: 'italiana' }))).not.toHaveProperty('basis');
  });

  it('is no statement for the Swiss Army question, and reaches the runner\'s nationality field', () => {
    const known = facts({ education: [liceo], location: 'Como' });
    const army = { id: 'army', question: 'Haben Sie die Rekrutenschule absolviert?', type: 'choice', options: ['Ja', 'Nein'] };
    expect(platformDefaultAnswer(army, known)).toBeNull();
    expect(platformDefaultAnswer(army, facts({ nationality: 'italiana' }))?.value).toBe('Nein');
    const form = candidateForForm({ identity: { name: 'Prova Candidata', email: 'alias@example.test' }, profile: { education: [liceo] }, language: 'de', platformFacts: known });
    expect(form.profile.nationality).toBe(known.nationality);
    const stated = candidateForForm({ identity: { name: 'Prova Candidata', email: 'alias@example.test' }, profile: { nationality: 'Svizzera' }, language: 'de', platformFacts: known });
    expect(stated.profile.nationality).toBe('Svizzera');
    expect(candidateForForm({ identity: { name: 'Prova Candidata', email: 'alias@example.test' }, profile: {}, language: 'de', platformFacts: facts({}) }).profile.nationality).toBe('');
  });
});

describe('more offline signals for the nationality (owner decision 2026-11-11, second part)', () => {
  // A synthetic codice fiscale: its check character computed here with the ministerial algorithm, on a body no
  // person can have (day 00 does not exist, A000 is no Italian municipality, Z000 no foreign country).
  const ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
  const valueOf = (char: string) => (/\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65);
  const withCheck = (body: string) => {
    let sum = 0;
    for (let index = 0; index < 15; index += 1) sum += index % 2 === 0 ? ODD[valueOf(body[index])] : valueOf(body[index]);
    return `${body}${String.fromCharCode(65 + (sum % 26))}`;
  };
  const bornInItaly = withCheck('TSTPRV90A00A000');
  const bornAbroad = withCheck('TSTPRV90A00Z000');
  // Omocodia: the last digits written as letters (0 → L).
  const omocodia = withCheck('TSTPRV90A00A0LL');
  const wrongCheck = `${bornInItaly.slice(0, 15)}${bornInItaly[15] === 'A' ? 'B' : 'A'}`;
  // Numbers no one is reached at: a national block of zeros after each prefix.
  const PHONE_IT = '+39 000 000 0000';
  const PHONE_CH = '0041 00 000 00 00';
  const PHONE_DE = '+49 000 0000000';
  // An AHV/AVS number of the right shape with a wrong EAN-13 check digit.
  const AVS = '756.0000.0000.00';
  const italian = [{ language: 'Italiano', level: 'Madrelingua' }];

  it('reads a nationality the CV declares, in the four languages, a dual one Swiss first', () => {
    expect(cvDeclaredNationality('Nazionalità: italiana')).toEqual({ code: 'IT', codes: ['IT'] });
    expect(cvDeclaredNationality('Cittadinanza italiana')).toEqual({ code: 'IT', codes: ['IT'] });
    expect(cvDeclaredNationality('Staatsangehörigkeit: deutsch')?.code).toBe('DE');
    expect(cvDeclaredNationality('Nationalité : française')?.code).toBe('FR');
    expect(cvDeclaredNationality('Nationality: Italian (EU)')?.code).toBe('IT');
    expect(cvDeclaredNationality('Data di nascita: 01.01.1990 | Nazionalità: italiana | Patente B')?.code).toBe('IT');
    expect(cvDeclaredNationality('Nazionalità: italiana, Patente: B')?.code).toBe('IT');
    expect(cvDeclaredNationality('Nationalität: Schweiz      Zivilstand: ledig')?.code).toBe('CH');
    expect(cvDeclaredNationality('Doppia cittadinanza: italiana e svizzera')).toEqual({ code: 'CH', codes: ['IT', 'CH'] });
    expect(cvDeclaredNationality('Nationality: Italian / German')).toEqual({ code: 'IT', codes: ['IT', 'DE'] });
    // No declaration: a word of another meaning, an unknown part, two declarations that disagree.
    expect(cvDeclaredNationality('Cittadinanza attiva e Costituzione')).toBeNull();
    expect(cvDeclaredNationality('Nationality: Atlantean')).toBeNull();
    expect(cvDeclaredNationality('Nationality: Italian\nNationalité : française')).toBeNull();
    expect(cvDeclaredNationality('Nationality: Italian\nNazionalità: italiana')?.code).toBe('IT');
    expect(cvDeclaredNationality('')).toBeNull();
  });

  it('gives none when a declaration has a part the tables do not know, whatever another line says (review of #18097)', () => {
    expect(cvDeclaredNationality('Nazionalità: italiana e marziana\nNazionalità: italiana')).toBeNull();
    expect(cvDeclaredNationality('Nazionalità: italiana\nNazionalità: italiana e marziana')).toBeNull();
    expect(cvDeclaredNationality('Nationality: Atlantean\nNationality: Italian')).toBeNull();
    expect(facts({}, { cvText: 'Nazionalità: italiana e marziana\nNazionalità: italiana' })).toMatchObject({ nationality: '', nationalitySource: '' });
    // A label of another meaning, with no colon and no known nationality, is no declaration and blocks nothing.
    expect(cvDeclaredNationality('Cittadinanza attiva e Costituzione\nNazionalità: italiana')?.code).toBe('IT');
  });

  it('reads an omocodic codice fiscale whose check character is computed again, as the ministerial algorithm does (review of #18097)', () => {
    // One digit of the year written as its omocodia letter (5 → R), on a synthetic body no person can have.
    const parent = withCheck('TSTPRV95A00A000');
    const variant = withCheck('TSTPRV9RA00A000');
    expect(codiceFiscaleValid(variant)).toBe(true);
    expect(codiceFiscaleBirthCountry(`Codice fiscale: ${variant}`)).toBe('IT');
    // The substitution changes the check character: the variant that keeps the parent's is no valid code.
    const stale = `${variant.slice(0, 15)}${parent[15]}`;
    expect(stale).not.toBe(variant);
    expect(codiceFiscaleValid(stale)).toBe(false);
    expect(codiceFiscaleBirthCountry(`Codice fiscale: ${stale}`)).toBe('');
  });

  it('reads the place of birth of a valid codice fiscale only, and never returns the code', () => {
    expect(codiceFiscaleValid(bornInItaly)).toBe(true);
    expect(codiceFiscaleValid(omocodia)).toBe(true);
    expect(codiceFiscaleValid(wrongCheck)).toBe(false);
    expect(codiceFiscaleBirthCountry(`Codice fiscale: ${bornInItaly}`)).toBe('IT');
    expect(codiceFiscaleBirthCountry(`C.F. ${omocodia.toLowerCase()}`)).toBe('IT');
    expect(codiceFiscaleBirthCountry(`CF: ${bornAbroad}`)).toBe('abroad');
    // A wrong check character, two different codes (one may be another person's), none: nothing.
    expect(codiceFiscaleBirthCountry(`CF: ${wrongCheck}`)).toBe('');
    expect(codiceFiscaleBirthCountry(`CF: ${bornInItaly}\nRef. ${omocodia}`)).toBe('');
    expect(codiceFiscaleBirthCountry('Nessun codice')).toBe('');
    // A birth in Italy is a strong signal; the deduction records the kind of signal, never the code.
    const deduced = deducedNationality({ profile: { languages: italian }, cvText: `Codice fiscale: ${bornInItaly}` });
    expect(deduced).toEqual({ code: 'IT', signals: ['codice_fiscale_birthplace', 'mother_tongue'] });
    expect(JSON.stringify(platformCandidateFacts({ profile: { languages: italian }, cvText: `CF ${bornInItaly}`, nowMs: NOW }))).not.toContain(bornInItaly);
    // Alone it is one signal; against a mother tongue of another country it stops the deduction.
    expect(deducedNationality({ profile: {}, cvText: `CF ${bornInItaly}` })).toBeNull();
    expect(deducedNationality({ profile: { languages: [{ language: 'Polski', level: 'Native' }] }, cvText: `CF ${bornInItaly}` })).toBeNull();
    // A birth abroad names no country, and contradicts a place of birth in Italy the text writes.
    expect(deducedNationality({ profile: { languages: italian }, cvText: `CF ${bornAbroad}` })).toBeNull();
    expect(deducedNationality({ profile: { languages: italian }, cvText: `Nato a Como il 3 aprile 1990\nCF ${bornAbroad}` })).toBeNull();
    expect(deducedNationality({ profile: { languages: italian }, cvText: 'Nato a Como il 3 aprile 1990' })?.code).toBe('IT');
  });

  it('reads the phone prefix of the candidate, the order or the CV, never a national number or an AHV number', () => {
    expect(candidatePhoneCountry({ identity: { phone: PHONE_IT } })).toBe('IT');
    expect(candidatePhoneCountry({ order: { applicantPhone: PHONE_CH } })).toBe('CH');
    expect(candidatePhoneCountry({ profile: { phone: PHONE_DE } })).toBe('DE');
    // The phone the candidate gave or corrected comes first.
    expect(candidatePhoneCountry({ identity: { phone: PHONE_CH }, order: { applicantPhone: PHONE_IT } })).toBe('CH');
    expect(candidatePhoneCountry({ cvText: `Tel. ${PHONE_IT}` })).toBe('IT');
    expect(candidatePhoneCountry({ cvText: `Mobile: ${PHONE_CH}` })).toBe('CH');
    // Two countries in the CV, a national number, a number outside a phone line, an AHV number: nothing.
    expect(candidatePhoneCountry({ cvText: `Tel. ${PHONE_IT}\nCell ${PHONE_CH}` })).toBe('');
    expect(candidatePhoneCountry({ identity: { phone: '079 000 00 00' } })).toBe('');
    expect(candidatePhoneCountry({ cvText: `Fattura ${PHONE_IT}` })).toBe('');
    expect(candidatePhoneCountry({ cvText: `AHV-Nr. ${AVS}` })).toBe('');
  });

  it('counts the phone prefix and the CV\'s language only beside a strong signal', () => {
    // A strong signal and the prefix of its country: two kinds.
    expect(deducedNationality({ profile: { languages: italian }, phoneCountry: 'IT' })).toEqual({ code: 'IT', signals: ['mother_tongue', 'phone_prefix'] });
    expect(deducedNationality({ profile: { cvLanguage: 'it' }, cvText: 'Nato a Como il 3 aprile 1990' })).toEqual({ code: 'IT', signals: ['birthplace', 'cv_language'] });
    // Two weak signals are not enough: the prefix with the residence (both say where the candidate lives), with a
    // university, or with the CV's language.
    expect(deducedNationality({ profile: {}, phoneCountry: 'IT', residenceCountry: 'IT' })).toBeNull();
    expect(deducedNationality({ profile: { education: [university] }, phoneCountry: 'IT' })).toBeNull();
    expect(deducedNationality({ profile: { cvLanguage: 'it' }, phoneCountry: 'IT' })).toBeNull();
    expect(deducedNationality({ profile: { cvLanguage: 'it' } })).toBeNull();
    // An Italian CV of an Italian mother tongue is one fact (a Ticinese writes both): still one kind.
    expect(deducedNationality({ profile: { languages: italian, cvLanguage: 'it' } })).toBeNull();
    // The prefix with the residence beside a strong signal adds no second kind of its own.
    expect(deducedNationality({ profile: { languages: italian }, phoneCountry: 'IT', residenceCountry: 'IT' })?.signals).toEqual(['mother_tongue', 'residence', 'phone_prefix']);
    // Never against a strong signal; the legacy pair of #18085 (university and residence) is unchanged.
    expect(deducedNationality({ profile: { languages: italian }, cvText: 'Nato a Como il 3 aprile 1990', phoneCountry: 'CH' })?.code).toBe('IT');
    expect(deducedNationality({ profile: { languages: italian }, phoneCountry: 'CH' })).toBeNull();
    expect(deducedNationality({ profile: { education: [university] }, residenceCountry: 'IT', phoneCountry: 'CH' })).toEqual({ code: 'IT', signals: ['university', 'residence'] });
    // German as the CV's language confirms Switzerland, Germany or Austria only beside a strong signal.
    expect(deducedNationality({ profile: { cvLanguage: 'de' }, cvText: 'Geburtsort: Zürich' })?.code).toBe('CH');
    // An AHV number in the CV is no signal for or against anything.
    expect(deducedNationality({ profile: { languages: italian }, cvText: `AHV ${AVS}`, residenceCountry: 'CH' })).toBeNull();
    expect(deducedNationality({ profile: { languages: italian }, cvText: `AHV ${AVS}`, residenceCountry: 'IT' })?.code).toBe('IT');
  });

  it('makes the CV\'s declaration the value, as the CV\'s, below the parser and the candidate', () => {
    const declared = facts({ location: 'Como' }, { cvText: 'Nazionalità: italiana', locale: 'de' });
    expect(declared).toMatchObject({ nationality: 'Italien', nationalitySource: 'cv', nationalityCode: 'IT', nationalityCodes: ['IT'], nationalitySignals: ['cv_declaration'] });
    // A dual national: Swiss first on a list, both kept for the record.
    const dual = facts({}, { cvText: 'Cittadinanza: italiana e svizzera', locale: 'it' });
    expect(dual).toMatchObject({ nationality: 'svizzera', nationalitySource: 'cv', nationalityCode: 'CH', nationalityCodes: ['IT', 'CH'] });
    // The declaration wins over a deduction that would say otherwise.
    expect(facts({ education: [{ degree: 'Abitur', institution: 'Gymnasium, Deutschland' }] }, { cvText: 'Nationality: Italian' })).toMatchObject({ nationalitySource: 'cv', nationalityCode: 'IT' });
    // The parser's reading of the same line, an upload answer, an answer or a cleared correction win.
    expect(facts({ nationality: 'Svizzera' }, { cvText: 'Nazionalità: italiana' })).toMatchObject({ nationalitySource: 'candidate', nationalityCode: 'CH' });
    expect(facts({}, { cvText: 'Nazionalità: italiana', answers: { nationality: 'Francese' } })).toMatchObject({ nationality: '', nationalitySource: '' });
    expect(facts({}, { cvText: 'Nazionalità: italiana', nationalityDeduction: false })).toMatchObject({ nationality: '', nationalitySource: '' });
    // The candidate's own dual nationality carries Swiss first as its code.
    expect(facts({ nationality: 'italiana e svizzera' })).toMatchObject({ nationalitySource: 'candidate', nationalityCode: 'CH', nationalityCodes: ['IT', 'CH'] });
  });

  it('answers the form from the declaration, and the phone reaches the deduction through the facts', () => {
    const declared = facts({}, { cvText: 'Nationality: Italian' });
    expect(platformDefaultAnswer(nationalityQuestion(['Albanien', 'Italien', 'Schweiz']), declared)).toMatchObject({ value: 'Italien', basis: 'cv', version: PLATFORM_DEFAULTS_VERSION });
    const dual = facts({}, { cvText: 'Cittadinanza: italiana e svizzera' });
    expect(platformDefaultAnswer(nationalityQuestion(['Albanien', 'Italien', 'Schweiz']), dual)?.value).toBe('Schweiz');
    // The candidate's own dual nationality: Swiss first on a list, their own words in a free field.
    const ownDual = facts({ nationality: 'italiana e svizzera' });
    expect(platformDefaultAnswer(nationalityQuestion(['Albanien', 'Italien', 'Schweiz']), ownDual)?.value).toBe('Schweiz');
    expect(platformDefaultAnswer(nationalityQuestion([], 'Nazionalità'), ownDual, { locale: 'it' })?.value).toBe('italiana e svizzera');
    // A declaration is the candidate's own word for the Swiss Army question; a deduction is not.
    const army = { id: 'army', question: 'Haben Sie die Rekrutenschule absolviert?', type: 'choice', options: ['Ja', 'Nein'] };
    expect(platformDefaultAnswer(army, declared)?.value).toBe('Nein');
    expect(platformDefaultAnswer(army, dual)).toBeNull();
    const phoned = platformCandidateFacts({ order: { userId: 'u-test' }, identity: { phone: PHONE_IT }, profile: { languages: italian }, nowMs: NOW, seed: 'u-test' });
    expect(phoned).toMatchObject({ nationalitySource: 'deduced', nationalityCode: 'IT', nationalitySignals: ['mother_tongue', 'phone_prefix'] });
    expect(platformCandidateFacts({ order: { userId: 'u-test', applicantPhone: PHONE_IT }, profile: { location: 'Como' }, nowMs: NOW, seed: 'u-test' }))
      .toMatchObject({ nationality: '', nationalitySource: '' });
  });

  it('reaches the review page and the runner\'s nationality field (candidateWithEdits, candidateForForm)', () => {
    const order = { userId: 'u-test', locale: 'de' };
    const draft = { profile: { location: 'Como' }, questions: [], factSources: { text: 'Nazionalità: italiana' } };
    const known = platformFactsOf({ order, draft, flow: { answers: {} } });
    expect(known).toMatchObject({ nationalitySource: 'cv', nationalityCode: 'IT' });
    expect(platformFactsOf({ order, draft, flow: { answers: {}, formOverrides: { nationality: '' } } })).toMatchObject({ nationality: '', nationalitySource: '' });
    const form = candidateForForm({ identity: { name: 'Prova Candidata', email: 'alias@example.test' }, profile: {}, language: 'de', platformFacts: known });
    expect(form.profile.nationality).toBe('Italien');
    // The order's phone with a mother tongue: a deduction the candidate can still change.
    const phoned = { profile: { languages: italian }, questions: [], factSources: { text: '' } };
    expect(platformFactsOf({ order: { ...order, applicantPhone: PHONE_IT }, draft: phoned, flow: { answers: {} } })).toMatchObject({ nationalitySource: 'deduced', nationalityCode: 'IT' });
  });

  it('never reads the name: a name alone gives no nationality', () => {
    expect(platformCandidateFacts({ order: { userId: 'u-test' }, identity: { name: 'Prova Candidata', firstName: 'Prova' }, profile: {}, nowMs: NOW, seed: 'u-test' }))
      .toMatchObject({ nationality: '', nationalitySource: '', nationalitySignals: [] });
  });
});

describe('the criminal record: always no conviction (owner decision 2026-11-11)', () => {
  const legacy = facts({});
  const choice = (question: string, options = ['Ja', 'Nein']) => ({ id: 'q', source: 'portal', type: 'choice', question, applicationQuestion: question, options });
  const value = (question: object, known = legacy, locale = 'it') => platformDefaultAnswer(question, known, { locale })?.value ?? null;

  it('answers «no» to a conviction, an entry or a pending proceeding, in the four languages', () => {
    expect(value(choice('Ha subito condanne penali?', ['Sì', 'No']))).toBe('No');
    expect(value(choice('Sind Sie vorbestraft?'))).toBe('Nein');
    expect(value(choice('Gibt es Einträge im Strafregister?'))).toBe('Nein');
    expect(value(choice('Sind gegen Sie laufende Strafverfahren hängig?'))).toBe('Nein');
    expect(value(choice('Hai procedimenti penali in corso?', ['Sì', 'No']))).toBe('No');
    expect(value(choice('Have you ever been convicted of a criminal offence?', ['Yes', 'No']))).toBe('No');
    expect(value(choice('Avez-vous fait l\'objet d\'une condamnation pénale ?', ['Oui', 'Non']))).toBe('Non');
    expect(value({ id: 'q', type: 'yes_no', question: 'Do you have a criminal record?' }, legacy, 'en')).toBe('No');
    expect(platformDefaultAnswer(choice('Sind Sie vorbestraft?'), legacy)).toMatchObject({ topic: 'platform:criminal_record', source: 'policy_default' });
  });

  it('answers «yes» to a statement that there is none, and reads the polarity of each wording', () => {
    expect(value({ id: 'c', type: 'checkbox', question: 'Dichiaro di non avere condanne penali' })).toBe('true');
    expect(value({ id: 'c', type: 'checkbox', question: 'Ich bestätige, dass keine Einträge im Strafregister bestehen.' })).toBe('true');
    expect(value(choice('Dichiaro di non avere condanne penali e di non avere procedimenti penali in corso', ['Sì', 'No']))).toBe('Sì');
    expect(value(choice('Ist Ihr Strafregisterauszug einwandfrei?'))).toBe('Ja');
    // A request to provide the paper stays with the candidate, clean or not (review of #18085).
    expect(value(choice('Puoi fornire un casellario giudiziale pulito?', ['Yes', 'No']))).toBeNull();
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'yes_no', question: 'Can you provide a clean criminal-record extract?' }, legacy, { locale: 'en' })).toBeNull();
    // A statement of an entry is not made: the box stays unticked.
    expect(value({ id: 'c', type: 'checkbox', question: 'Ich habe Einträge im Strafregister' })).toBe('false');
    // A negated question reads both ways: it stays with the candidate.
    expect(value(choice('Non hai mai avuto condanne penali?', ['Sì', 'No']))).toBeNull();
    expect(value(choice('Sind Sie nicht vorbestraft?'))).toBeNull();
  });

  it('picks the option of «none» in a choice, and the «no conviction» of a free question', () => {
    expect(value({ id: 's', type: 'choice', question: 'Strafregister', options: ['Bitte wählen', 'Keine Einträge', 'Einträge vorhanden'] })).toBe('Keine Einträge');
    expect(value({ id: 's', type: 'choice', question: 'Casellario giudiziale', options: ['Condanne', 'Nessuna condanna', 'Procedimenti in corso'] })).toBe('Nessuna condanna');
    // Two options of «none», or none at all: no guess.
    expect(value({ id: 's', type: 'choice', question: 'Strafregister', options: ['Keine Einträge', 'Keine Vorstrafen', 'Einträge vorhanden'] })).toBeNull();
    expect(value({ id: 's', type: 'choice', question: 'Strafregister', options: ['Eintrag A', 'Eintrag B', 'Eintrag C'] })).toBeNull();
    expect(value({ id: 't', type: 'text', question: 'Hai precedenti penali?' })).toBe('Nessuna condanna');
    expect(value({ id: 't', type: 'textarea', question: 'Sind Sie vorbestraft?' }, legacy, 'de')).toBe('Keine Vorstrafen');
  });

  it('never answers a request for the extract, a consent to a check or an upload', () => {
    for (const question of [
      { id: 'f', type: 'file', question: 'Estratto del casellario giudiziale' },
      { id: 'f', type: 'text', question: 'Allegare l\'estratto del casellario giudiziale' },
      { id: 'f', type: 'text', question: 'Strafregisterauszug' },
      choice('Können Sie einen aktuellen Strafregisterauszug vorlegen?'),
      choice('Puoi fornire l\'estratto del casellario giudiziale?', ['Sì', 'No']),
      choice('Acconsento alla verifica del casellario giudiziale', ['Sì', 'No']),
      choice('Ich bin einverstanden, dass ein Strafregisterauszug eingeholt wird'),
    ]) expect(platformDefaultAnswer(question, legacy)).toBeNull();
  });

  it('answers «no» on the debt-enforcement register too when the upload gave no answer (owner decision 2026-11-11)', () => {
    expect(platformQuestionTopic(choice('Haben Sie Einträge im Betreibungsregister?'))).toBe('debt_record');
    expect(value(choice('Haben Sie Einträge im Betreibungsregister?'))).toBe('Nein');
    // SBB ifB89NW2's question names both registers: «no» for an order made before the upload asked.
    const both = choice('* Hast du einen Eintrag im Strafregister oder im Betreibungsregister?', ['Nein', 'Ja']);
    expect(platformQuestionTopic(both)).toBe('criminal_or_debt_record');
    expect(value(both)).toBe('Nein');
    // A «yes» the candidate gave at upload still wins.
    const debt = platformCandidateFacts({ order: { candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana', criminalRecord: 'no', debtRecord: 'yes' } }, nowMs: NOW });
    expect(value(both, debt)).toBe('Ja');
    // «Poursuites pénales» are criminal proceedings, not debt enforcement.
    expect(value(choice('Faites-vous l\'objet de poursuites pénales ?', ['Oui', 'Non']))).toBe('Non');
  });

  it('lets the candidate\'s own «yes» at upload win', () => {
    const record = platformCandidateFacts({ order: { candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana', criminalRecord: 'yes', debtRecord: 'no' } }, nowMs: NOW });
    expect(value(choice('Gibt es Einträge im Strafregister?'), record)).toBe('Ja');
    expect(value({ id: 'c', type: 'checkbox', question: 'Dichiaro di non avere condanne penali' }, record)).toBeNull();
    expect(value(choice('Sind gegen Sie laufende Strafverfahren hängig?'), record)).toBeNull();
    // Review of #18085: a conviction asked without the register's name keeps the upload «yes».
    expect(value(choice('Hai avuto una condanna penale?', ['Sì', 'No']), record)).toBe('Sì');
  });

  it('reads a conviction named beside the debt register as the combined question (review of #18085)', () => {
    const both = { id: 'q', source: 'portal', type: 'yes_no', question: 'Have you ever been convicted or do you have an entry in the debt-enforcement register?' };
    expect(platformQuestionTopic(both)).toBe('criminal_or_debt_record');
    expect(platformDefaultAnswer(both, legacy, { locale: 'en' })?.value).toBe('No');
  });
});

describe('«Attestato»: the title in a text or a choice field, the paper in an upload (owner decision 2026-11-11)', () => {
  const known = facts({
    education: [
      { degree: 'Attestato federale di capacità impiegato di commercio', institution: 'Scuola professionale commerciale, Bellinzona', start: '2010', end: '2013' },
      { degree: 'Bachelor in Economia aziendale', institution: 'Scuola universitaria professionale, Manno', start: '2014', end: '2017' },
    ],
    certifications: ['Certificazione di prova in contabilità'],
  });
  const answer = (question: object, facts = known) => platformDefaultAnswer(question, facts)?.value ?? null;

  it('declares the CV\'s title in a text field', () => {
    expect(platformQuestionTopic({ id: 'a', type: 'text', question: 'Attestato' })).toBe('held_title');
    expect(answer({ id: 'a', type: 'text', question: 'Attestato' })).toBe('Attestato federale di capacità impiegato di commercio');
    expect(answer({ id: 'a', type: 'text', question: 'Attestato federale di capacità (AFC)' })).toBe('Attestato federale di capacità impiegato di commercio');
    expect(answer({ id: 'a', type: 'text', question: 'Titolo di studio conseguito' })).toBe('Bachelor in Economia aziendale');
    expect(answer({ id: 'a', type: 'text', question: 'Certificazioni' })).toBe('Certificazione di prova in contabilità');
    // The CV holds no title: no value, the question stays.
    expect(answer({ id: 'a', type: 'text', question: 'Attestato' }, facts({}))).toBeNull();
  });

  it('chooses the option of the CV\'s title, never one of two', () => {
    expect(answer({ id: 'a', type: 'choice', question: 'Quale attestato possiede?', options: ['AFC logistica', 'AFC impiegato di commercio', 'Nessuno'] }))
      .toBe('AFC impiegato di commercio');
    expect(answer({ id: 'a', type: 'choice', question: 'Diploma', options: ['Maturità', 'Bachelor', 'Master'] })).toBe('Bachelor');
    expect(answer({ id: 'a', type: 'choice', question: 'Quale attestato possiede?', options: ['AFC logistica', 'AFC meccanica'] })).toBeNull();
  });

  it('leaves the paper to the upload: an upload field, a request to attach, a caption of documents', () => {
    for (const question of [
      { id: 'a', type: 'file', question: 'Attestato' },
      { id: 'a', type: 'text', question: 'Allegare l\'attestato' },
      { id: 'a', type: 'text', question: 'Lebenslauf - Zeugnisse - Diplome' },
      { id: 'a', type: 'text', question: 'Arbeitszeugnis' },
      { id: 'a', type: 'text', question: 'Anno di conseguimento del diploma' },
      { id: 'a', type: 'choice', question: 'Possiede l\'attestato federale di capacità?', options: ['Sì', 'No'] },
    ]) expect(platformQuestionTopic(question)).not.toBe('held_title');
    expect(candidateOnlyCategory({ id: 'a', type: 'file', question: 'Attestato' })).toBe('candidate_document');
    expect(candidateOnlyCategory({ id: 'a', type: 'yes_no', question: 'Allegare una copia dell\'attestato federale di capacità' })).toBe('candidate_document');
  });

  it('reads a yes/no on holding the AFC as a title the CV states, not as a document', () => {
    for (const question of ['Possiede l\'attestato federale di capacità di impiegato di commercio?', 'Haben Sie ein eidgenössisches Fähigkeitszeugnis?']) {
      const item = { id: 'a', source: 'portal', type: 'choice', question, applicationQuestion: question, options: ['Sì', 'No'] };
      expect(experienceQuestionKind(item)).toBe('certification');
      expect(candidateOnlyCategory(item)).toBeNull();
    }
  });
});
