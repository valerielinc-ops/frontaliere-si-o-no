import { describe, expect, it } from 'vitest';
import { formPostingMatch, namesAnotherEmployer } from '../scripts/assisted-application/lib/portal/portal.mjs';

// A title line, heading or neighbouring text names another employer only with POSITIVE evidence (a legal form,
// «bei/chez/presso/at <Name>», «<Name> sucht/cerca/recherche», «Other <kind>», a kind next to a name, a known
// other employer). Words the page vocabulary does not know (menus, buttons, instructions, descriptions, file
// names, languages) are never a conflict. Lines below are the real page lines of three orders (2026-11-27),
// with the candidate's data removed.
const staJob = { title: 'Metallbauer/in für Montage von Sicherheitskomponenten', company: 'STA Personal AG' };
const staLines = [
  'Stellenangebote', 'Dienstleistungen', 'Payrolling', 'Zurück',
  'Metallbauteile fachgerecht zu montieren gehört zu deinen Kernaufgaben. Der Betrieb arbeitet mit modernen Mitteln und bietet dir vielseitige Einsatzmöglichkeiten', 'Tätigkeiten',
];
const damianiJob = { title: 'Group CFO', titleByLocale: { de: 'Gruppe CFO', fr: 'Groupe CFO' }, company: 'Damiani Group' };
const damianiLines = ['BRAND', 'SAVOIR FAIRE', 'ETHICS', 'NEWS & MEDIA', 'Sign Out', 'Options'];
const zurichJob = { title: 'Vermessungsassistent*in', company: 'Stadt Zürich' };
const zurichLines = [
  'Karrierechancen: Für Vermessungsassistent*in (52113) bewerben', 'Optionen', 'Deutsch',
  'Bitte laden Sie im Abschnitt «Meine Bewerbungsunterlagen» alle geforderten Dokumente hoch.',
  'Zulässige Dateiformate: Microsoft Word (DOCX), PDF, Bild und Text (max. 10MB pro Datei)', 'Lebenslauf', 'Lebenslauf_Muster.pdf',
];

describe('a line the vocabulary does not know is not another employer', () => {
  it.each([
    ['agency order, listing page', staJob, staLines],
    ['module of a group', damianiJob, damianiLines],
    ['city module', zurichJob, zurichLines],
  ])('%s: every real line, alone as the title and inside the page, names nobody', (_name, job, lines) => {
    for (const line of lines) {
      expect(namesAnotherEmployer(line, job)).toBe(false);
      expect(namesAnotherEmployer(`${line}\n${lines.join('\n')}`, job, { allowPostingLocation: true })).toBe(false);
    }
  });

  it('binds the agency posting page whose document title is only navigation words', () => {
    const pageUrl = 'https://www.sta.example/stellen/metallbauer-in-zuerich-dauerstelle-1/';
    const heading = staJob.title;
    const text = [staLines[0], heading, ...staLines.slice(1), pageUrl].join('\n');
    const diagnostics: Record<string, any> = {};
    expect(formPostingMatch(text, staJob, { pageUrl, postingUrl: pageUrl, postingMatched: true, pageHeading: heading, pageHeadings: [heading], diagnostics })).toBe('match');
    expect(diagnostics).toEqual({});
  });

  it('binds the module of the group and of the city whose headings carry the role', () => {
    const damianiUrl = 'https://career.example.eu/portalcareer?company=TENANT1';
    expect(formPostingMatch(['Career Opportunities: Group CFO (1808)', 'Group CFO (1808)', ...damianiLines, damianiUrl].join('\n'), damianiJob, {
      pageUrl: damianiUrl, postingMatched: true, postingEntry: true, pageHeading: 'Group CFO (1808)', pageHeadings: ['Group CFO (1808)'],
    })).toBe('match');
    const zurichUrl = 'https://career.example.eu/portalcareer?company=STZH&career_job_req_id=52113';
    expect(formPostingMatch([zurichLines[0], 'Vermessungsassistent*in (52113)', ...zurichLines.slice(1), zurichUrl].join('\n'), zurichJob, {
      pageUrl: zurichUrl, postingMatched: true, postingEntry: true, pageHeading: 'Vermessungsassistent*in (52113)', pageHeadings: ['Vermessungsassistent*in (52113)'],
    })).toBe('match');
  });
});

describe('positive evidence keeps the real conflicts', () => {
  const job = { title: 'Concierge', company: 'Grand Hotel Esempio' };
  it.each([
    ['Concierge | Siemens AG', 'legal_form'],
    ['Bewerbung bei Siemens AG', 'legal_form'],
    ['Concierge - Other Resort SA', 'legal_form'],
    ['Concierge | Muster S.p.A.', 'legal_form'],
    ['Concierge | Beispiel S.A.', 'legal_form'],
    ['Concierge | Beispiel GmbH & Co', 'legal_form'],
    ['Concierge at the Hotel Splendide', 'placement_preposition'],
    ['Stelle als Concierge bei Muster Betriebe', 'placement_preposition'],
    ['Concierge chez Beispiel Voyages', 'placement_preposition'],
    ['Concierge presso Beispiel Viaggi', 'placement_preposition'],
    ['Beispiel Reisen sucht Concierge', 'hiring_verb'],
    ['Beispiel Viaggi cerca Concierge', 'hiring_verb'],
    ['Beispiel Voyages recherche Concierge', 'hiring_verb'],
    ['Concierge — Other Resort', 'other_employer_marker'],
    ['Concierge, Frauenfeld | Other Employer', 'other_employer_marker'],
    ['Concierge | HOTEL SPLENDIDE', 'kind_with_name'],
    ['Greenfield Systems - My application', 'employer_slot_of_title'],
  ])('%s is another employer (%s)', (line, reason) => {
    const evidence: Record<string, string> = {};
    expect(namesAnotherEmployer(line, job, { evidence })).toBe(true);
    expect(typeof evidence.reason).toBe("string");
    expect(evidence.entity.length > 0).toBe(true);
    expect(evidence.line).toBe(line);
  });

  it('names a known other employer by its exact name', () => {
    const evidence: Record<string, string> = {};
    expect(namesAnotherEmployer('Concierge | Beispielwerk', { ...job, otherEmployerNames: ['Beispielwerk'] }, { evidence })).toBe(true);
    expect(evidence).toMatchObject({ reason: 'known_other_employer' });
    expect(namesAnotherEmployer('Concierge | Beispielwerk', job)).toBe(false);
  });

  it('is not fooled by prose after «bei», an own legal form or a staffing agency naming itself', () => {
    expect(namesAnotherEmployer('Bei Fragen melden Sie sich', job)).toBe(false);
    expect(namesAnotherEmployer('Concierge bei Fragen', job)).toBe(false);
    expect(namesAnotherEmployer('Concierge | Grand Hotel Esempio AG', job)).toBe(false);
    // Another agency is another employer, even for an agency's order: only the order's own distinctive name binds.
    expect(namesAnotherEmployer('Metallbauer | Beispiel Personal AG', { title: 'Metallbauer', company: 'Muster Staffing AG' })).toBe(true);
    expect(namesAnotherEmployer('Metallbauer | Muster Personal AG', { title: 'Metallbauer', company: 'Muster Staffing AG' })).toBe(false);
    expect(namesAnotherEmployer('Metallbauer | Beispiel Industrie AG', { title: 'Metallbauer', company: 'Muster Staffing AG' })).toBe(true);
  });

  it('stops the binding on the same lines inside a page, and names the line and entity in the diagnostics', () => {
    const pageUrl = 'https://www.sta.example/stellen/metallbauer-in-zuerich-dauerstelle-1/';
    const heading = staJob.title;
    const diagnostics: Record<string, any> = {};
    const text = [staLines[0], heading, ...staLines.slice(1), pageUrl].join('\n');
    expect(formPostingMatch(text, staJob, { pageUrl, postingUrl: pageUrl, postingMatched: true, pageHeading: heading, pageHeadings: [heading, 'Bewerbung bei Siemens AG'], diagnostics })).toBe('mismatch');
    expect(diagnostics.inputs.conflictLines).toEqual(['placement_preposition: «Siemens AG» in «Bewerbung bei Siemens AG»']);
    expect(diagnostics.inputs.conflictHeadings).toEqual(['Bewerbung bei Siemens AG']);
  });

  it('keeps another role, another requisition and another employer next to the order\'s name fail-closed', () => {
    expect(formPostingMatch('Karriere\nKoch\nBewerben', job, { postingMatched: true })).not.toBe('match');
    expect(namesAnotherEmployer('Other Hotel Esempio', job)).toBe(true);
    expect(namesAnotherEmployer('Grand Hotel Esempio Partners', job)).toBe(true);
  });
});

// Fourth real case: a public Avature page of a consultancy. Menus and labels around the employer's own name, and
// its own marketing copy («Why join <employer>?»), speak FOR the order's employer. The three spellings of the
// employer's name are one employer.
describe('the employer\'s own name and copy are not another employer', () => {
  const title = 'Manager IT Infrastructure Technology Strategy Transformation';
  const url = 'https://apply.example.ch/Careers/JobDetail/Manager-IT/24124';
  const page = [
    'Search jobs', 'Recruitment agencies', 'Deloitte', title, 'Basic information', 'Business line', 'Geneva, Zurich',
    'Experience level', 'Date published', 'Req #', 'Job description', 'Why join Deloitte?', 'At Deloitte, we are dedicated to your growth.',
    'Join Deloitte today', 'Working at Deloitte', 'Life at Deloitte', 'Deloitte Careers', url,
  ].join('\n');
  it.each(['Deloitte', 'Deloitte AG', 'Deloitte Consulting AG'])('binds the page for the order of %s', (company) => {
    const diagnostics: Record<string, any> = {};
    expect(formPostingMatch(page, { title, company }, {
      pageUrl: url, postingUrl: url, postingMatched: true, pageHeading: title, pageHeadings: [title], diagnostics,
    })).toBe('match');
    expect(diagnostics).toEqual({});
  });

  it('does not set the spellings of the name against each other, but keeps another name a conflict', () => {
    const spellings = ['Deloitte', 'Deloitte AG', 'Deloitte Consulting AG'];
    for (const ours of spellings) {
      for (const seen of spellings) expect(namesAnotherEmployer(`Welcome\nWhy join ${seen}?\n${seen}`, { company: ours, title })).toBe(false);
    }
    expect(namesAnotherEmployer('Welcome\nDeloitte Partners', { company: 'Deloitte AG', title })).toBe(true);
    expect(namesAnotherEmployer('Other Employer\nWelcome', { company: 'Deloitte AG', title })).toBe(true);
  });
});

describe('the employer slot of an ATS title accepts a single-token name', () => {
  it('reads another one-word employer as a conflict and the order\'s own variants as none', () => {
    const evidence: Record<string, string> = {};
    expect(namesAnotherEmployer('Deloitte - My application', { company: 'Acme', title: 'Manager' }, { evidence })).toBe(true);
    expect(evidence.reason).toBe('employer_slot_of_title');
    expect(namesAnotherEmployer('Deloitte - My application', { company: 'Deloitte AG', title: 'Manager' })).toBe(false);
    expect(namesAnotherEmployer('Deloitte Consulting AG - Bewerbung', { company: 'Deloitte', title: 'Manager' })).toBe(false);
    expect(namesAnotherEmployer('Deloitte | Candidature', { company: 'Acme', title: 'Manager' })).toBe(true);
  });
});

describe('an isolated ampersand joins one company name in the title slot', () => {
  it('reads A & B as another employer and keeps the order\'s own «&» name', () => {
    expect(namesAnotherEmployer('A & B - My application', { company: 'Acme', title: 'Manager' })).toBe(true);
    expect(namesAnotherEmployer('Procter & Gamble - Bewerbung', { company: 'Acme', title: 'Manager' })).toBe(true);
    expect(namesAnotherEmployer('Ernst & Young - My application', { company: 'Acme', title: 'Manager' })).toBe(true);
    expect(namesAnotherEmployer('Ernst & Young - My application', { company: 'Ernst & Young AG', title: 'Manager' })).toBe(false);
  });
});


// Fifth real case (STA, live proof 2026-11-28): the order's company is «STA Personal AG», the page names the same
// agency «STA Personalpartner AG». Names that differ only by the trade words of placement agencies and by the legal
// form are one agency; a really different name next to it, or another legal entity in the title, stays a conflict
// (fail-closed: a client named in a title or heading is not shown to be the employer of record).
describe('a placement agency\'s name variants are one employer', () => {
  const title = 'Metallbauer/in für Montage von Sicherheitskomponenten';
  const url = 'https://www.sta.example/stellen/metallbauer-in-zuerich-dauerstelle-1/';
  const job = { title, company: 'STA Personal AG' };
  const page = (...lines: string[]) => ['Stellenangebote', title, ...lines, 'Jetzt bewerben!', url].join('\n');
  const bind = (text: string, order = job, diagnostics: Record<string, any> = {}) => formPostingMatch(text, order, {
    pageUrl: url, postingUrl: url, postingMatched: true, pageHeading: title, pageHeadings: [title], diagnostics,
  });

  it.each([
    'STA Personalpartner AG', 'STA Personal AG', 'STA Personaldienstleistungen AG', 'STA Personaldienste AG',
    'STA Partner AG', 'STA Staffing AG', 'STA Jobs AG', 'STA Services AG', 'STA Consulting AG', 'STA Group AG',
    'STA Holding AG', 'STA Recruitment AG', 'STA Temporär AG', 'STA Stellenvermittlung AG',
  ])('binds the page that names the agency as «%s»', (name) => {
    const diagnostics: Record<string, any> = {};
    expect(bind(page(name, `Willkommen bei ${name}`, `© ${name}`), job, diagnostics)).toBe('match');
    expect(diagnostics).toEqual({});
  });

  it('holds in both directions and for an agency written in the page\'s own spelling', () => {
    expect(bind(page('STA Personal AG'), { title, company: 'STA Personalpartner AG' })).toBe('match');
    expect(namesAnotherEmployer('Willkommen\nSTA Personalpartner AG', job)).toBe(false);
  });

  it('keeps a really different name next to the agency\'s, and other employers, a conflict', () => {
    expect(namesAnotherEmployer('Willkommen\nSTA Muster Personal AG', job)).toBe(true);
    expect(namesAnotherEmployer('STA Personal AG – Kunde: Siemens AG', job)).toBe(true);
    expect(namesAnotherEmployer('Bewerbung bei Siemens AG', job)).toBe(true);
    // Trade words alone do not make another agency the order's: the order's distinctive name («STA») must be in it.
    expect(namesAnotherEmployer('Bewerbung bei Muster Personalpartner AG', job)).toBe(true);
    expect(namesAnotherEmployer('Concierge | Muster Staffing AG', job)).toBe(true);
    expect(namesAnotherEmployer('Bewerbung bei STA Personalpartner AG', job)).toBe(false);
    // For an employer that is not an agency, «Partners» next to the name is still another name.
    expect(namesAnotherEmployer('Welcome\nSTA Partners', { title, company: 'STA AG' })).toBe(true);
  });
});

// Sixth and seventh real cases (live proofs 2026-11-28): the agency's «STA Stellenpartner AG» (a compound of the
// trade) and the copyright line of a SuccessFactors footer «Damiani Group Valenza 2019 © All rights reserved»
// (the place of the seat next to the employer's name).
describe('trade compounds and legal-notice lines are no other employer', () => {
  const sta = { title: 'Metallbauer', company: 'STA Personal AG' };
  const damiani = { title: 'Group CFO', company: 'Damiani Group' };

  it.each(['STA Stellenpartner AG', 'STA Jobpartner AG', 'STA Staffline AG', 'STA Tempforce AG', 'STA Recruitpoint AG', 'STA Personalpartner AG'])(
    'reads «%s» as the order\'s agency', (name) => {
      expect(namesAnotherEmployer(`Willkommen\n${name}\n© ${name}`, sta)).toBe(false);
    });

  it('still reads another agency, or another name next to the agency\'s, as a conflict', () => {
    expect(namesAnotherEmployer('Willkommen\nMuster Stellenpartner AG', sta)).toBe(false); // body: no legal-form evidence far from the name
    expect(namesAnotherEmployer('Bewerbung bei Muster Personalpartner AG', sta)).toBe(true);
    expect(namesAnotherEmployer('Bewerbung bei Muster Stellenpartner AG', sta)).toBe(true);
    expect(namesAnotherEmployer('Willkommen\nSTA Muster Stellenpartner AG', sta)).toBe(true);
    // The broad trade stems never hide another agency by themselves: the order's distinctive name must be in the entity.
    for (const other of ['Jobcenter AG', 'Staffpoint AG', 'Tempcare AG', 'Recruitwerk AG', 'Stellenwerk AG', 'Muster Partner AG']) {
      expect(namesAnotherEmployer(other, sta)).toBe(true);
      expect(namesAnotherEmployer(`Bewerbung bei ${other}`, sta)).toBe(true);
    }
  });

  it.each([
    'Damiani Group Valenza 2019 © All rights reserved',
    'Damiani Group Valenza 2019 Alle Rechte vorbehalten',
    'Damiani Group Valenza 2019 Tous droits réservés',
    'Damiani Group Valenza 2019 Tutti i diritti riservati',
    '© 2019 Damiani Group Valenza',
    'Impressum Damiani Group Valenza',
  ])('does not read the footer line «%s» as another employer', (line) => {
    expect(namesAnotherEmployer(`Group CFO\nSign Out\n${line}`, damiani)).toBe(false);
    expect(namesAnotherEmployer(`${line}\nGroup CFO`, damiani)).toBe(false);
  });

  it('removes only the legal part of a notice line and still reads another name on it', () => {
    expect(namesAnotherEmployer('Jobcenter AG © Copyright 2026', sta)).toBe(true);
    expect(namesAnotherEmployer('Willkommen\nJobcenter AG © Copyright 2026', sta)).toBe(false); // body: no entity evidence far from the name
    expect(namesAnotherEmployer('Willkommen\nMuster STA © 2026 All rights reserved', sta)).toBe(true);
    expect(namesAnotherEmployer('© 2026 Jobcenter AG', sta)).toBe(true);
    expect(namesAnotherEmployer('Group CFO\nDamiani Group Valenza 2019 © All rights reserved', damiani)).toBe(false);
    expect(namesAnotherEmployer('Group CFO\n© 2019 Damiani Group Valenza', damiani)).toBe(false);
  });

  it('keeps the same name next to the employer a conflict outside a legal notice', () => {
    expect(namesAnotherEmployer('Group CFO\nDamiani Group Valenza', damiani)).toBe(true);
  });
});
