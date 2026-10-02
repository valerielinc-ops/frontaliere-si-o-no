import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { formatPeriod, parseEndpoint } = await import('../functions/src/lib/cvPeriod.js');
const { apprenticeHeadline, candidateType } = await import('../functions/src/assistedApplicationCandidateType.js');
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

  it('writes the apprentice’s trade as a goal, never as a role', () => {
    expect(apprenticeHeadline('Lernende/r Informatiker/in EFZ Applikationsentwicklung', 'de')).toBe('Berufswunsch: Informatiker/in EFZ Applikationsentwicklung');
    expect(apprenticeHeadline('Apprenti·e employé·e de commerce CFC', 'fr')).toBe('Objectif professionnel : employé·e de commerce CFC');
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
