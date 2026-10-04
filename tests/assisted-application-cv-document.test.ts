import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { formatPeriod, parseEndpoint } = await import('../functions/src/lib/cvPeriod.js');
const { apprenticeHeadline, apprenticeTrade, candidateType, draftCandidateType } = await import('../functions/src/assistedApplicationCandidateType.js');
const { buildCvDocument } = await import('../functions/src/assistedApplicationCvDocument.js');
const { checkTailoredCvFacts, headlineGrounded, sanitizeTailoredCv, tailoredCvPlainText } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { sanitizeProfile } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { PROFILE_SCHEMA } = await import('../functions/src/assistedApplicationAiPrompts.js');

// Invented candidates of the study 2026-10-02 (report-cv-lettera).
const APPRENTICE_CV = 'Luka Kovačević\nGeboren am 14. März 2010 · Schweiz / Kroatien\nSchulbildung 2023 – 2026 Sekundarschule A, Schulhaus Rychenberg\n'
  + 'Schnupperlehre 04.2026 Informatiker Applikationsentwicklung, Muster Informatik AG, Winterthur: kleine Webseite mit HTML und CSS gebaut\n'
  + 'Nebenjob 2025 – heute Zeitungsverträger, Regionalzeitung Winterthur: jeden Samstag 80 Zeitungen verteilt\n'
  + 'Multicheck ICT (März 2026): Schulisches Potenzial 78 %\nKenntnisse: Python, Scratch\nSprachen: Deutsch, Kroatisch, Englisch B1\n'
  + 'Hobbys: Fussball, Gitarre\nReferenzen: Herr Peter Muster, Klassenlehrer, Schulhaus Rychenberg, +41 52 555 00 00';
const APPRENTICE = sanitizeProfile({
  fullName: 'Luka Kovačević', headline: 'Schüler Sekundarschule A', dateOfBirth: '14. März 2010', nationality: 'Schweiz / Kroatien',
  address: { street: 'Musterweg 12', postalCode: '8400', city: 'Winterthur', country: 'Schweiz' },
  languages: [{ language: 'Deutsch', level: 'Muttersprache' }, { language: 'Englisch', level: 'B1' }],
  skills: ['Python', 'Scratch'],
  experience: [
    { role: 'Schnupperlehre Informatiker Applikationsentwicklung', employer: 'Muster Informatik AG', location: 'Winterthur', start: '04.2026', end: '04.2026', kind: 'trial_apprenticeship', highlights: ['Kleine Webseite mit HTML und CSS gebaut'] },
    { role: 'Zeitungsverträger', employer: 'Regionalzeitung Winterthur', location: 'Winterthur', start: '2025', end: 'heute', kind: 'side_job', highlights: ['Jeden Samstag 80 Zeitungen verteilt'] },
  ],
  education: [{ degree: 'Sekundarschule A', institution: 'Schulhaus Rychenberg', start: '2023', end: '2026', grade: '' }],
  aptitudeTests: [{ name: 'Multicheck ICT', date: 'März 2026', results: 'Schulisches Potenzial 78 %' }],
  interests: ['Fussball', 'Gitarre'],
  references: [{ name: 'Herr Peter Muster', role: 'Klassenlehrer', organisation: 'Schulhaus Rychenberg', contact: '+41 52 555 00 00' }],
});
const identity = { name: 'Luka Kovačević', email: 'bewerbung-7f3k@frontaliereticino.ch', phone: '+41 79 555 01 23' };

describe('Swiss periods (cvPeriod)', () => {
  it('prints what it can read for sure as MM.YYYY, the rest as written', () => {
    expect(formatPeriod('März 2021', 'heute', 'de')).toBe('03.2021 – heute');
    expect(formatPeriod('03/2021', 'oggi', 'it')).toBe('03.2021 – oggi');
    expect(formatPeriod('Sept. 2017', 'Juil. 2018', 'fr')).toBe('09.2017 – 07.2018');
    expect(formatPeriod('04.2026', '04.2026', 'de')).toBe('04.2026');
    expect(formatPeriod('seit 2022', '', 'de')).toBe('2022 – heute');
    expect(formatPeriod('Frühling 2020', '2021', 'de')).toBe('Frühling 2020 – 2021');
    expect(parseEndpoint("aujourd'hui")).toBe('ongoing');
    expect(parseEndpoint('13/2021')).toBeNull();
  });
});

describe('type of application', () => {
  it('reads an apprenticeship from the posting, a first job from a profile without jobs', () => {
    expect(candidateType({ postingTitle: 'Lernende/r Informatiker/in EFZ Applikationsentwicklung', profile: APPRENTICE })).toEqual({ type: 'apprentice', sector: 'it' });
    expect(candidateType({ postingTitle: 'Infirmier/ère diplômé/e 80-100%', profile: { experience: [{ role: 'Infirmière', kind: 'job' }] } })).toEqual({ type: 'qualified', sector: 'health' });
    expect(candidateType({ postingTitle: 'Sviluppatore/trice Full-Stack', profile: { experience: [{ role: 'Stage', kind: 'internship' }] } })).toEqual({ type: 'first_job', sector: 'it' });
    // "IT" alone counts only in capitals.
    expect(candidateType({ postingTitle: 'IT Support Specialist 100%', profile: { experience: [{ role: 'Helpdesk', kind: 'job' }] } }).sector).toBe('it');
    expect(candidateType({ postingTitle: 'Make it happen: Sachbearbeiter/in', profile: { experience: [{ role: 'Sachbearbeiter', kind: 'job' }] } }).sector).toBe('other');
    // An EFZ in the title is a qualification, not an apprenticeship.
    expect(candidateType({ postingTitle: 'Informatiker EFZ Systemtechnik 100%', profile: { experience: [{ role: 'Informatiker', kind: 'job' }] } }).type).toBe('qualified');
  });

  // Verification of 2026-10-03: the apprentice CV and letter (a 14-16 year old) went to any posting that mentions apprentices.
  it('reads an apprenticeship only when the posting offers one', () => {
    const noJob = { experience: [{ role: 'Zeitungsverträger', kind: 'side_job' }] };
    const withJob = { experience: [{ role: 'Assistentin', kind: 'job' }] };
    const type = (postingTitle: string, profile: any, postingText = '') => candidateType({ postingTitle, postingText, profile }).type;
    // The verifier's three probes.
    expect(type('Sachbearbeiter/in 80%', noJob, 'Aufgaben: Administration und Betreuung der Lernenden.')).toBe('first_job');
    expect(type('Trainee Position Marketing', withJob)).toBe('qualified');
    expect(type('Stage / tirocinio formativo marketing', withJob)).toBe('qualified');
    // An internship, a traineeship, a job that trains apprentices, a training already done.
    expect(type('Praktikum Marketing', noJob, 'Wir bilden auch Lernende aus.')).toBe('first_job');
    expect(type('Tirocinio extracurriculare amministrazione', noJob)).toBe('first_job');
    expect(type('Berufsbildner/in für Lernende 80%', withJob)).toBe('qualified');
    expect(type('Responsable de l’apprentissage', withJob)).toBe('qualified');
    expect(type('Kauffrau/Kaufmann EFZ 80%', noJob, 'Sie haben eine abgeschlossene Lehre als Kauffrau/Kaufmann EFZ.')).toBe('first_job');
    // Apprenticeship titles in the four languages.
    for (const title of ['Lehrstelle 2027: Informatiker/in EFZ', 'Kauffrau/Kaufmann EFZ (Lehrstelle 2027)', 'Lernende Fachfrau/Fachmann Gesundheit EFZ', 'Lehre als Koch/Köchin EFZ',
      'Apprenti-e employé-e de commerce CFC', 'Apprentissage d’opérateur·trice en informatique CFC', 'Apprendista impiegato/a di commercio AFC',
      'Posto di tirocinio come impiegato/a di commercio AFC', 'Tirocinio impiegato/a di commercio AFC', 'Apprenticeship Commercial Employee EFZ']) {
      expect(type(title, noJob)).toBe('apprentice');
    }
    // A diploma in the title, the place offered in the text, no job yet.
    expect(type('Kauffrau/Kaufmann EFZ', noJob, 'Wir bieten per August 2027 eine Lehrstelle an.')).toBe('apprentice');
    expect(type('Kauffrau/Kaufmann EFZ', withJob, 'Wir bieten per August 2027 eine Lehrstelle an.')).toBe('qualified');
    expect(type('Impiegato/a di commercio AFC', noJob, 'Offriamo un posto di tirocinio dal 2027.')).toBe('apprentice');
  });

  it('takes the trade out of an apprenticeship title, or nothing when only the apprenticeship is left', () => {
    expect(apprenticeTrade('Lehrstelle 2027: Informatiker/in EFZ')).toBe('Informatiker/in EFZ');
    expect(apprenticeTrade('Kauffrau/Kaufmann EFZ (Lehrstelle 2027)')).toBe('Kauffrau/Kaufmann EFZ');
    expect(apprenticeTrade('Detailhandelsfachfrau/-mann EFZ – Lehrstelle 2027')).toBe('Detailhandelsfachfrau/-mann EFZ');
    expect(apprenticeTrade('Lernende/r Kauffrau/Kaufmann EFZ – Lehrbeginn August 2027')).toBe('Kauffrau/Kaufmann EFZ');
    expect(apprenticeTrade('Lernender/Lernende Polymechaniker/in EFZ')).toBe('Polymechaniker/in EFZ');
    expect(apprenticeTrade('Apprenti-e employé-e de commerce CFC')).toBe('employé-e de commerce CFC');
    expect(apprenticeTrade('Apprentissage d’opérateur·trice en informatique CFC')).toBe('opérateur·trice en informatique CFC');
    expect(apprenticeTrade('Apprendista impiegato/a di commercio AFC')).toBe('impiegato/a di commercio AFC');
    expect(apprenticeTrade('Posto di tirocinio come impiegato/a di commercio AFC')).toBe('impiegato/a di commercio AFC');
    // Nothing left, a phrase, or a title that does not say it is an apprenticeship.
    expect(apprenticeTrade('Lehrstellen 2027')).toBe('');
    expect(apprenticeTrade('Lehrstelle in der Pflege')).toBe('');
    expect(apprenticeTrade('Kauffrau/Kaufmann EFZ')).toBe('');
    // The headline reads the same trade (the old prefix stripper left «2027:» and the brackets in).
    expect(apprenticeHeadline('Lehrstelle 2027: Informatiker/in EFZ', 'de')).toBe('Berufswunsch: Informatiker/in EFZ');
    expect(apprenticeHeadline('Kauffrau/Kaufmann EFZ (Lehrstelle 2027)', 'de')).toBe('Berufswunsch: Kauffrau/Kaufmann EFZ');
  });

  it('writes the apprentice’s trade as a goal, never as a role', () => {
    expect(apprenticeHeadline('Lernende/r Informatiker/in EFZ Applikationsentwicklung', 'de')).toBe('Berufswunsch: Informatiker/in EFZ Applikationsentwicklung');
    expect(apprenticeHeadline('Apprenti·e employé·e de commerce CFC', 'fr')).toBe('Objectif professionnel : employé·e de commerce CFC');
  });

  // Review of 2026-10-03: a company's yearly apprentices typed an adult as an apprentice, a real offer in the
  // text did not count, an Italian internship and a French training company were misread.
  it('counts in the text one place offered, or the training offered, never what a company does every year', () => {
    const noJob = { experience: [{ role: 'Praktikum', kind: 'internship' }] };
    const type = (postingTitle: string, postingText = '') => candidateType({ postingTitle, postingText, profile: noJob }).type;
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Als Ausbildungsbetrieb bieten wir jedes Jahr zwölf Lehrstellen an.')).toBe('first_job');
    expect(type('Impiegato/a di commercio AFC 100%', 'La nostra azienda offre ogni anno posti di tirocinio.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nous formons des apprenti·e·s chaque année.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nos apprenti·es et apprenti(e)s sont encadré·es.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC', 'Nous cherchons un·e apprenti·e motivé·e.')).toBe('apprentice');
    // The training offered (Berufslehre, tirocinio, apprentissage), not the one a candidate has done.
    expect(type('Impiegato/a di commercio AFC', 'Offriamo un tirocinio triennale a partire da agosto 2027.')).toBe('apprentice');
    expect(type('Kauffrau/Kaufmann EFZ', 'Wir bieten dir eine spannende dreijährige Berufslehre ab August 2027.')).toBe('apprentice');
    expect(type('Employé·e de commerce CFC', 'Nous proposons un apprentissage dès août 2027.')).toBe('apprentice');
    expect(type('Impiegato/a di commercio AFC 100%', 'Requisiti: tirocinio di commercio concluso e tre anni di esperienza.')).toBe('first_job');
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten eine vielseitige Stelle für Personen mit abgeschlossener Berufslehre.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nous offrons chaque année des places d’apprentissage.')).toBe('first_job');
  });

  // Re-check of 2026-10-04: an offer verb anywhere before the training word typed an adult posting as an
  // apprenticeship, and so did a title that asks for a training already done.
  it('counts a training in the text only as the object of an offer verb, never one done or asked for', () => {
    const noJob = { experience: [{ role: 'Schnupperlehre', kind: 'trial_apprenticeship' }] };
    const type = (postingTitle: string, postingText: string) => candidateType({ postingTitle, postingText, profile: noJob }).type;
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten Absolventinnen und Absolventen einer kaufmännischen Berufslehre den idealen Berufseinstieg.')).toBe('first_job');
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten Ihnen eine unbefristete Stelle im Anschluss an Ihre Berufslehre.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nous offrons un premier emploi idéal à la fin de votre apprentissage.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nous offrons un poste fixe aux jeunes ayant terminé leur apprentissage.')).toBe('first_job');
    expect(type('Impiegato/a di commercio AFC 100%', 'Offriamo un impiego fisso a chi ha appena finito il tirocinio.')).toBe('first_job');
    expect(type('Commercial Employee EFZ 100%', 'We offer a permanent position upon completion of your apprenticeship.')).toBe('first_job');
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten nach abgeschlossener Berufslehre eine Festanstellung.')).toBe('first_job');
    // The verb, at most a pronoun, an article and adjectives, then the training.
    expect(type('Kauffrau/Kaufmann EFZ', 'Gerne bieten wir dir eine dreijährige Berufslehre an.')).toBe('apprentice');
    expect(type('Impiegato/a di commercio AFC', 'Offriamo l’apprendistato completo in azienda.')).toBe('apprentice');
    expect(type('Commercial Employee EFZ', 'We offer you a three-year apprenticeship.')).toBe('apprentice');
  });

  // Second re-check of 2026-10-04: the object rule missed the apprenticeships offered after a time phrase or to
  // a beneficiary.
  it('counts the training offered after a time phrase or to a beneficiary, still never one done', () => {
    const noJob = { experience: [{ role: 'Schnupperlehre', kind: 'trial_apprenticeship' }] };
    const type = (postingTitle: string, postingText: string) => candidateType({ postingTitle, postingText, profile: noJob }).type;
    expect(type('Kauffrau/Kaufmann EFZ', 'Wir bieten ab August 2027 eine dreijährige Berufslehre.')).toBe('apprentice');
    expect(type('Kauffrau/Kaufmann EFZ', 'Wir bieten Schulabgängern eine Berufslehre.')).toBe('apprentice');
    expect(type('Commercial Employee EFZ', 'We offer young people an apprenticeship.')).toBe('apprentice');
    expect(type('Impiegato/a di commercio AFC', 'Offriamo ai giovani un apprendistato.')).toBe('apprentice');
    expect(type('Employé·e de commerce CFC', 'Nous offrons aux jeunes un apprentissage.')).toBe('apprentice');
    expect(type('Kauffrau/Kaufmann EFZ', 'Wir bieten motivierten Jugendlichen per 1. August eine Lehre als Kauffrau.')).toBe('apprentice');
    expect(type('Kauffrau/Kaufmann EFZ', 'Wir bieten ab sofort jungen Menschen eine Berufslehre.')).toBe('apprentice');
    expect(type('Impiegato/a di commercio AFC', 'Offriamo dal 1° settembre a giovani motivati un tirocinio triennale.')).toBe('apprentice');
    expect(type('Impiegato/a di commercio AFC', 'Offriamo da agosto 2027 un apprendistato.')).toBe('apprentice');
    expect(type('Employé·e de commerce CFC', 'Nous proposons dès novembre 2027 un apprentissage.')).toBe('apprentice');
    expect(type('Employé·e de commerce CFC', 'Nous proposons, dès août 2027, à des jeunes un apprentissage.')).toBe('apprentice');
    expect(type('Employé·e de commerce CFC', 'Nous offrons à partir d’août 2027 un apprentissage.')).toBe('apprentice');
    expect(type('Commercial Employee EFZ', 'We offer, starting in August, a motivated young person an apprenticeship.')).toBe('apprentice');
    expect(type('Commercial Employee EFZ', 'We offer school leavers from August 2027 an apprenticeship.')).toBe('apprentice');
    // Still never a training done or asked for, nor the one a noun names («Absolventen einer Berufslehre»).
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten Absolventen einer Berufslehre ab sofort eine Festanstellung.')).toBe('first_job');
    expect(type('Kauffrau/Kaufmann EFZ 80%', 'Wir bieten jungen Menschen nach abgeschlossener Berufslehre eine Festanstellung.')).toBe('first_job');
    expect(type('Employé·e de commerce CFC 80%', 'Nous offrons aux jeunes ayant terminé leur apprentissage un poste fixe.')).toBe('first_job');
    expect(type('Commercial Employee EFZ 100%', 'We offer young people who completed an apprenticeship a permanent position.')).toBe('first_job');
  });

  it('reads a training the title asks for as done, never as the apprenticeship offered', () => {
    const withJob = { experience: [{ role: 'Logistiker EFZ', kind: 'job' }] };
    const type = (postingTitle: string) => candidateType({ postingTitle, profile: withJob }).type;
    expect(type('Mitarbeiter/in Logistik (abgeschlossene Lehre als Logistiker/in EFZ)')).toBe('qualified');
    expect(type('Sachbearbeiter/in mit abgeschlossener Berufslehre')).toBe('qualified');
    expect(type('Collaborateur·trice administratif·ve (CFC obtenu par apprentissage)')).toBe('qualified');
    expect(type('Magazziniere/a con apprendistato concluso')).toBe('qualified');
    expect(type('Impiegato/a di commercio AFC con tirocinio concluso')).toBe('qualified');
    expect(type('Commercial Employee with completed apprenticeship')).toBe('qualified');
    // «mit», «avec» after the training is what the apprenticeship comes with.
    expect(type('Berufslehre als Kauffrau/Kaufmann EFZ mit Berufsmaturität')).toBe('apprentice');
    expect(type('Apprentissage d’employé·e de commerce CFC avec maturité professionnelle')).toBe('apprentice');
  });

  it('reads an Italian internship in every spelling, and a training company in the title as no trainer', () => {
    const noJob = { experience: [{ role: 'Praktikum', kind: 'internship' }] };
    const type = (postingTitle: string) => candidateType({ postingTitle, profile: noJob }).type;
    expect(type('Posto di tirocinio non curriculare marketing')).toBe('first_job');
    expect(type('Posto di tirocinio extra-curriculare amministrazione')).toBe('first_job');
    expect(type('Apprenti·e employé·e de commerce – entreprise formatrice')).toBe('apprentice');
    expect(type('Formateur/trice d’apprenti·e·s')).toBe('first_job');
  });

  it('keeps the commercial profile in the trade: «Profil E» is no conjunction', () => {
    expect(apprenticeTrade('Lernende/r Kauffrau/Kaufmann EFZ, Profil E')).toBe('Kauffrau/Kaufmann EFZ, Profil E');
    expect(apprenticeHeadline('Lernende/r Kauffrau/Kaufmann EFZ, Profil E', 'de')).toBe('Berufswunsch: Kauffrau/Kaufmann EFZ, Profil E');
    expect(apprenticeHeadline('Lehrstelle Kauffrau/Kaufmann EFZ Profil E', 'de')).toBe('Berufswunsch: Kauffrau/Kaufmann EFZ Profil E');
    expect(apprenticeHeadline('Apprendista impiegato/a di commercio AFC, profilo E', 'it')).toBe('Obiettivo professionale: impiegato/a di commercio AFC, profilo E');
    // A phrase cut at the conjunction is still no trade.
    expect(apprenticeTrade('Apprendista impiegato/a di commercio e')).toBe('');
  });

  it('reads the type a draft was written for in one place', () => {
    expect(draftCandidateType({ candidateType: { type: 'apprentice', sector: 'it' } })).toBe('apprentice');
    expect(draftCandidateType({ candidateType: 'first_job' })).toBe('first_job');
    expect(draftCandidateType({})).toBe('');
    expect(draftCandidateType(null)).toBe('');
  });
});

describe('tailored CV by type', () => {
  const raw = { headline: 'Lernender Informatiker EFZ', summary: 'Motivierter Schüler.', competencies: ['Python'], experience: [{ index: 0, bullets: ['Kleine Webseite mit HTML und CSS gebaut'] }], skills: ['Python', 'HTML'] };

  it('gives the apprentice the Swiss apprentice CV: goal, personal data, school, placements, tests, interests, references', () => {
    const cv = sanitizeTailoredCv(raw, { profile: APPRENTICE, cvText: APPRENTICE_CV, language: 'de', type: 'apprentice', sector: 'it', title: 'Lernende/r Informatiker/in EFZ Applikationsentwicklung 100%' });
    expect(cv).toMatchObject({ headline: 'Berufswunsch: Informatiker/in EFZ Applikationsentwicklung', headlineSource: 'goal', summary: '' });
    // The goal is written in code from the order line: the gate reads only what the model wrote ("EFZ" is not in this CV).
    expect(checkTailoredCvFacts(cv, { cvText: APPRENTICE_CV, profile: APPRENTICE, answers: {} }).ok).toBe(true);
    const document = buildCvDocument(cv, { identity, profile: APPRENTICE, language: 'de', type: 'apprentice', sector: 'it' });
    expect(document.sections.map((section: any) => section.kind)).toEqual(['school', 'trial', 'jobs', 'tests', 'skills', 'languages', 'interests', 'references']);
    expect(document.personal).toEqual([['Geburtsdatum', '14. März 2010'], ['Nationalität', 'Schweiz / Kroatien']]);
    expect(document.contact[0]).toBe('Musterweg 12, 8400 Winterthur');
    const text = tailoredCvPlainText(cv, { identity, profile: APPRENTICE });
    for (const expected of ['PERSÖNLICHE ANGABEN', 'SCHNUPPERLEHREN', 'NEBENJOBS', 'EIGNUNGSTESTS', 'FREIZEIT UND ENGAGEMENT', 'REFERENZEN', '04.2026', '2025 – heute', 'Multicheck ICT: März 2026, Schulisches Potenzial 78 %', 'Herr Peter Muster']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('KURZPROFIL');
  });

  it('keeps the model’s headline only when the profile backs it', () => {
    const nurse = { headline: 'Infirmière', experience: [{ role: 'Infirmière en médecine interne', kind: 'job' }], education: [{ degree: "Diplôme d'État d'infirmier" }] };
    expect(headlineGrounded('Infirmière en médecine interne', nurse)).toBe(true);
    expect(headlineGrounded('Infirmière cheffe de service', nurse)).toBe(false);
    const cv = sanitizeTailoredCv({ ...raw, headline: 'Infirmière cheffe de service' }, { profile: sanitizeProfile(nurse), cvText: 'Infirmière', language: 'fr' });
    expect(cv).toMatchObject({ headline: 'Infirmière', headlineSource: 'profile' });
  });

  it('puts recognition right after education for health, projects for IT', () => {
    const profile = sanitizeProfile({
      experience: [{ role: 'Infirmière', employer: 'Centre Hospitalier Exemple', start: '09.2019', end: "aujourd'hui", kind: 'job', highlights: ['10 à 12 patients par poste'] }],
      education: [{ degree: "Diplôme d'État d'infirmier", institution: 'IFSI Exemple', start: '2015', end: '2018' }],
      recognitions: [{ title: 'Reconnaissance du diplôme par la Croix-Rouge suisse (CRS)', issuer: 'CRS', date: '2024' }],
      projects: [{ name: 'timesheet', url: 'github.com/example/timesheet', description: 'App open source' }],
      workPermit: 'Permis G (frontalière)',
    });
    const cv = sanitizeTailoredCv({ summary: 'Infirmière en médecine interne.', experience: [], competencies: [], skills: [] }, { profile, cvText: 'Infirmière', language: 'fr', type: 'qualified', sector: 'health' });
    const document = buildCvDocument(cv, { identity, profile, language: 'fr', type: 'qualified', sector: 'health' });
    const kinds = document.sections.map((section: any) => section.kind);
    expect(kinds.indexOf('recognitions')).toBe(kinds.indexOf('education') + 1);
    expect(document.personal).toContainEqual(['Permis de travail', 'Permis G (frontalière)']);
    expect(document.sections.find((section: any) => section.kind === 'experience').items[0].date).toBe("09.2019 – aujourd'hui");
  });
});

describe('richer profile', () => {
  it('keeps the new Swiss fields and defaults an unknown experience kind to a job', () => {
    const profile = sanitizeProfile({ experience: [{ role: 'X', kind: 'astronaut' }], drivingLicence: 'Kat. B', interests: ['Gitarre'], aptitudeTests: [{ name: 'Basic-Check', results: '75 %' }] });
    expect(profile.experience[0].kind).toBe('job');
    expect(profile).toMatchObject({ drivingLicence: 'Kat. B', interests: ['Gitarre'], aptitudeTests: [{ name: 'Basic-Check', date: '', results: '75 %' }], recognitions: [], references: [], projects: [] });
  });

  it('keeps the profile schema strict: every property required, no extra keys', () => {
    const strict = (schema: any): boolean => schema.type !== 'object'
      || (schema.additionalProperties === false && Object.keys(schema.properties).every((key) => schema.required.includes(key)) && Object.values(schema.properties).every((child: any) => strict(child.type === 'array' ? child.items : child)));
    expect(strict(PROFILE_SCHEMA)).toBe(true);
    expect(PROFILE_SCHEMA.properties.experience.items.properties.kind.enum).toContain('trial_apprenticeship');
  });
});
