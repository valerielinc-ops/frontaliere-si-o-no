import { describe, expect, it } from 'vitest';
import { formPostingMatch, namesAnotherEmployer } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Real case (Migros Genève, 2026-11-28): the portal's own header «Le portail de l'emploi / du groupe Migros» put the
// word «groupe» next to the employer's name and the binding stopped as `posting_mismatch`
// (`direct_match_employer_conflict`, `groupe next to migros`). A word of corporate grouping next to the order's
// distinctive name is the same group, for any employer; another name behind it, or another legal entity, is not.
const migros = { company: 'Société coopérative Migros Genève', title: 'Vendeuse fruits et légumes FHD' };
const url = 'https://jobs.example.ch/fr/nos-entreprises/job/societe-cooperative-migros-geneve/vendeuse-fruits-et-legumes-fhd/00000000-0000-0000-0000-000000000000';
const header = ['Société coopérative Migros Genève20 novembre 2026', "Le portail de l'emploi", 'du groupe Migros'];

describe('a group word next to the employer\'s name is the same group', () => {
  it('binds the real page whose header carries «du groupe Migros»', () => {
    const text = [...header, 'Vendeuse fruits et légumes FHD', 'Postuler', url].join('\n');
    const diagnostics: Record<string, any> = {};
    expect(formPostingMatch(text, migros, {
      pageUrl: url, postingUrl: url, postingMatched: true, pageHeading: migros.title, pageHeadings: [migros.title], diagnostics,
    })).toBe('match');
    expect(diagnostics).toEqual({});
    expect(namesAnotherEmployer(header.join('\n'), migros)).toBe(false);
  });

  it.each([
    "Le portail de l'emploi du groupe Migros",
    'Das Stellenportal der Migros-Gruppe',
    'Il portale del lavoro del gruppo Migros',
    'Jobs bei der Migros Gruppe',
    'Karriere im Migros-Konzern',
    'Teil der Migros-Gruppe',
    'Mitglied du groupe Migros',
    'Migros Holding',
    'Migros Unternehmensgruppe',
    'Groupement Migros',
    'Migros Group',
    'The Migros group is hiring',
    'Groupe Migros',
    'Migros Genève, 28 novembre 2026',
    'Welcome\nMigros Gruppe, Stellenportal',
  ])('does not read «%s» as another employer', (line) => {
    expect(namesAnotherEmployer(`Welcome\n${line}`, migros)).toBe(false);
    expect(namesAnotherEmployer(`${line}\nWelcome`, migros)).toBe(false);
  });

  it.each([
    ['Gruppe', 'Das Stellenportal der Acme-Gruppe', { company: 'Acme AG', title: 'Koch' }],
    ['Konzern', 'Karriere im Acme-Konzern', { company: 'Acme AG', title: 'Koch' }],
    ['holding', 'Welcome\nAcme Holding', { company: 'Acme', title: 'Koch' }],
    ['group', 'Welcome\nThe Acme Group careers', { company: 'Acme Ltd', title: 'Koch' }],
  ])('holds for any order, not only agencies: %s', (_name, text, job) => {
    expect(namesAnotherEmployer(text, job as any)).toBe(false);
  });

  it('keeps a name behind the group word, or another legal entity, a conflict', () => {
    for (const line of ['Migros Group Beta', 'Migros Gruppe Muster', 'Migros Holding Beispiel', 'Groupe Migros Muster']) {
      expect(namesAnotherEmployer(`Welcome\n${line}`, migros)).toBe(true);
    }
    expect(namesAnotherEmployer('Muster Group AG', { company: 'Acme AG', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Concierge | Muster Group AG', { company: 'Acme', title: 'Concierge' })).toBe(true);
    expect(namesAnotherEmployer('Bewerbung bei Muster Gruppe AG', migros)).toBe(true);
    expect(namesAnotherEmployer('Welcome\nOther Group', { company: 'Acme', title: 'Koch' })).toBe(false); // body: no entity evidence
    expect(namesAnotherEmployer('Other Group - My application', { company: 'Acme', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Concierge | Beispiel Holding', { company: 'Acme', title: 'Concierge' })).toBe(true);
  });

  it('keeps the negatives of the agency and notice rules', () => {
    expect(namesAnotherEmployer('Bewerbung bei Muster Personalpartner AG', { company: 'STA Personal AG', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Jobcenter AG', { company: 'STA Personal AG', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Jobcenter AG © Copyright 2026', { company: 'STA Personal AG', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Muster Ypsilon AG © Copyright 2026', { company: 'Muster GmbH', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Willkommen\nSTA Stellenpartner AG', { company: 'STA Personal AG', title: 'Koch' })).toBe(false);
  });

  it('reads the date line next to the name as no employer, and a word before the name still as one', () => {
    for (const date of ['Migros Genève20 novembre 2026', 'Migros Genève 3 décembre 2026', 'Migros Genève, 28. Januar 2027', 'Migros Genève 1 April 2027']) {
      expect(namesAnotherEmployer(`Welcome\n${date}`, migros)).toBe(false);
    }
    expect(namesAnotherEmployer('Welcome\nMuster Migros', migros)).toBe(true);
    expect(namesAnotherEmployer('Welcome\nOther Migros Genève', migros)).toBe(true);
  });
});

describe('months and portal words are neutral only in their own context', () => {
  it('reads another employer named like a month or a portal word as a conflict', () => {
    for (const name of ['April GmbH', 'Mai AG', 'Juli SA', 'August Sagl', 'Stellenmarkt AG', 'Stellenportal GmbH', 'Jobboerse AG']) {
      expect(namesAnotherEmployer(name, { company: 'Acme', title: 'Koch' })).toBe(true);
      expect(namesAnotherEmployer(`Bewerbung bei ${name}`, { company: 'Acme', title: 'Koch' })).toBe(true);
    }
    expect(namesAnotherEmployer('Concierge | April GmbH', { company: 'Acme', title: 'Concierge' })).toBe(true);
  });
});

describe('a group word next to the order\'s own name, as a title or heading', () => {
  const migrosOrder = { company: 'Migros', title: 'Koch' };
  const page = (...lines: string[]) => [...lines, 'Koch', 'https://x.test/job/1'].join('\n');

  it.each(['Migros Group', 'Migros Gruppe', 'Migros Holding', 'Migros Konzern', 'Group Migros', 'Groupe Migros', 'Migros Group AG',
    'Migros Group - My application', 'Migros Unternehmensgruppe', 'Acme Group Holding'])('binds the page headed «%s» for the order of Migros or Acme', (line) => {
    const job = /Acme/.test(line) ? { company: 'Acme', title: 'Koch' } : migrosOrder;
    expect(namesAnotherEmployer(line, job)).toBe(false);
    const diagnostics: Record<string, any> = {};
    expect(formPostingMatch(page(line), job, {
      pageUrl: 'https://x.test/job/1', postingUrl: 'https://x.test/job/1', postingMatched: true, pageHeading: 'Koch', pageHeadings: ['Koch'], diagnostics,
    })).toBe('match');
    expect(diagnostics).toEqual({});
  });

  it('still reads a distinct name with the group word, in a title, a heading or a form, as another employer', () => {
    for (const line of ['Migros Group Beta', 'Muster Group AG', 'Muster Gruppe', 'Beispiel Holding', 'Beispiel Konzern', 'Concierge | Muster Group', 'Group Muster']) {
      expect(namesAnotherEmployer(line, migrosOrder)).toBe(true);
    }
    // The order's name only prefixes a distinct entity.
    expect(namesAnotherEmployer('Migros Group Beta AG', migrosOrder)).toBe(true);
  });
});

describe('every month of the four languages reads as a date only beside a number', () => {
  const months = {
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    de: ['Januar', 'Februar', 'März', 'Maerz', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  };
  const acme = { company: 'Acme Genève', title: 'Koch' };
  it('binds a date line with the month, and still reads the month as a name without a number', () => {
    for (const month of Object.values(months).flat()) {
      for (const line of [`Acme Genève 20 ${month} 2026`, `Acme Genève20 ${month} 2026`, `Acme Genève, ${month} 2026`]) {
        expect(namesAnotherEmployer(`Welcome\n${line}`, acme)).toBe(false);
      }
      const capitalised = month.charAt(0).toUpperCase() + month.slice(1);
      expect(namesAnotherEmployer(`${capitalised} GmbH`, { company: 'Acme', title: 'Koch' })).toBe(true);
      expect(namesAnotherEmployer(`Bewerbung bei ${capitalised} AG`, { company: 'Acme', title: 'Koch' })).toBe(true);
    }
  });

  it('binds the page whose date line carries May, and keeps «May GmbH» another employer', () => {
    const url = 'https://x.test/job/1';
    const diagnostics: Record<string, any> = {};
    expect(formPostingMatch(['Acme Genève 20 May 2026', 'Koch', url].join('\n'), acme, {
      pageUrl: url, postingUrl: url, postingMatched: true, pageHeading: 'Koch', pageHeadings: ['Koch'], diagnostics,
    })).toBe('match');
    expect(diagnostics).toEqual({});
    expect(namesAnotherEmployer('May GmbH', { company: 'Acme', title: 'Koch' })).toBe(true);
    expect(namesAnotherEmployer('Concierge | May GmbH', { company: 'Acme', title: 'Concierge' })).toBe(true);
  });
});

