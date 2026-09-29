import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  composeKsgrDescription,
  parseKsgrDetailExtras,
  parseKsgrJobsPage,
} from '../scripts/lib/ksgr-job-parser.mjs';

describe('ksgr-job-parser', () => {
  it('accepts one PLZ-city hyphen without turning separator-only input into a city or HQ fallback', () => {
    const directlink = 'https://jobs.ksgr.ch/offene-stellen/test/06f8d7b2';
    const parse = (city: string, workplace: string) => parseKsgrJobsPage({
      jobs: [{
        id: city,
        links: { directlink },
        szas: {
          sza_title: 'Test role',
          'sza_location.city': city,
          sza_workplace: workplace,
        },
      }],
    }).jobs[0];

    expect(parse('Campus\nCH-7000-Chur', 'Campus\nCH-7000-Chur')).toMatchObject({
      location: 'Chur',
      postalCode: '7000',
    });
    expect(parse('Campus\n6850--', 'Campus\nCH-6850--')).toMatchObject({
      location: '6850--',
      postalCode: '',
    });
    expect(parse('Campus\n6850--Chur', 'Campus\nCH-6850--Chur')).toMatchObject({
      location: '6850--Chur',
      postalCode: '',
    });
  });

  it('parses Prospective API jobs into crawlable detail entries', () => {
    const payload = {
      total: 105,
      jobs: [
        {
          id: '9949520',
          viewkey: '06f8d7b2-16a7-47d3-b960-317bebad4909',
          title: 'Fachspezialist:in Employer Branding & Rekrutierung',
          links: {
            directlink: 'https://jobs.ksgr.ch/offene-stellen/fachspezialist-in-employer-branding-rekrutierung/06f8d7b2-16a7-47d3-b960-317bebad4909',
          },
          attributes: {
            '40': ['Chur', 'Home Office'],
            '15': ['Management Services'],
            '10': ['Administration, Informatik und Management'],
            '30': ['1601'],
            '50': ['80'],
            '60': ['100'],
          },
          szas: {
            sza_apply_link: 'https://career5.successfactors.eu/career?company=kantonsspi&career_job_req_id=1601',
            sza_pensum: '80 - 100%',
            'sza_location.city': 'Kantonsspital Graubünden\nHauptstandort\nLoëstrasse 170\nCH-7000 Chur',
            'sza_location.region': 'Graubünden',
            'sza_location.country': 'Schweiz',
            sza_title: 'Fachspezialist:in Employer Branding &amp; Rekrutierung',
          },
          start_date: '2026-03-06T10:42:05Z',
          end_date: '2036-03-02T22:59:59Z',
          last_modification_timestamp: '2026-03-06T13:02:35.196065Z',
          language: 'de',
        },
        {
          id: '9949521',
          viewkey: '0a7f8912-1111-4444-b960-317bebad4999',
          title: 'Dipl. Pflegefachperson HF',
          links: {
            directlink: 'https://jobs.ksgr.ch/offene-stellen/dipl-pflegefachperson-hf/0a7f8912-1111-4444-b960-317bebad4999',
          },
          attributes: {
            '40': ['Samedan'],
            '15': ['Pflege und Fachsupport'],
          },
          szas: {
            sza_apply_link: 'https://career5.successfactors.eu/career?company=kantonsspi&career_job_req_id=1701',
            'sza_location.city': 'Spital Oberengadin\nVia Nouva 3\n7503 Samedan',
            'sza_location.region': 'Graubünden',
            'sza_location.country': 'Schweiz',
          },
          start_date: '2026-03-05T09:00:00Z',
          last_modification_timestamp: '2026-03-05T12:00:00.000000Z',
          language: 'de',
        },
      ],
    };

    const result = parseKsgrJobsPage(payload);

    expect(result.total).toBe(105);
    expect(result.jobs).toEqual([
      {
        id: '9949520',
        title: 'Fachspezialist:in Employer Branding & Rekrutierung',
        detailUrl: 'https://jobs.ksgr.ch/offene-stellen/fachspezialist-in-employer-branding-rekrutierung/06f8d7b2-16a7-47d3-b960-317bebad4909',
        applyUrl: 'https://career5.successfactors.eu/career?company=kantonsspi&career_job_req_id=1601',
        location: 'Chur',
        canton: 'GR',
        postedDate: '2026-03-06',
        employmentType: '80 - 100%',
        description: '',
        industry: '',
        streetAddress: '',
        postalCode: '',
        region: 'Graubünden',
        country: 'Schweiz',
      },
      {
        id: '9949521',
        title: 'Dipl. Pflegefachperson HF',
        detailUrl: 'https://jobs.ksgr.ch/offene-stellen/dipl-pflegefachperson-hf/0a7f8912-1111-4444-b960-317bebad4999',
        applyUrl: 'https://career5.successfactors.eu/career?company=kantonsspi&career_job_req_id=1701',
        location: 'Samedan',
        canton: 'GR',
        postedDate: '2026-03-05',
        employmentType: '',
        description: '',
        industry: '',
        streetAddress: '',
        postalCode: '',
        region: 'Graubünden',
        country: 'Schweiz',
      },
    ]);
  });
});

describe('ksgr description completeness', () => {
  // Shape of the live Prospective record for "Bereichsleiter:in Human
  // Resource Management" (2026-09-29): attribute 80 is the per-role intro
  // that the page shows under the title.
  const apiJob = {
    id: '10199756',
    links: { directlink: 'https://jobs.ksgr.ch/offene-stellen/bereichsleiter-in-human-resource-management/956c6265-84d7-4301-b0c9-f3e08a713552' },
    attributes: {
      '40': ['Chur', 'Home Office'],
      '50': ['80'],
      '60': ['100'],
      '80': ['Wo über 3&#39;600 Mitarbeitende zusammenarbeiten, treffen täglich unterschiedliche Welten aufeinander.<br/> <br/>Du bist präsent, auf Augenhöhe und weisst, wie du unterschiedliche Interessen zusammenführst.'],
    },
    szas: {
      sza_title: 'Bereichsleiter:in Human Resource Management',
      sza_pensum: '80 - 100%',
      sza_introduction: 'Starte nach Vereinbarung als',
      sza_tasks: '<ul><li>Du treibst die Weiterentwicklung der HR-Strategie voran</li><li>Du führst den HRM-Bereich</li></ul>',
      sza_requirements: '<ul><li>Erfahrung in der Führung von Führungskräften</li></ul>',
      sza_company_profil: 'Du kannst etwas, was andere nicht können?<br/>Dann gehörst du zu uns!',
    },
  };

  it('publishes the lead-in with its object, the per-role intro and the lists as markdown', () => {
    const [job] = parseKsgrJobsPage({ jobs: [apiJob] }).jobs;
    expect(job.description).toBe([
      'Starte nach Vereinbarung als Bereichsleiter:in Human Resource Management 80 - 100%',
      'Wo über 3’600 Mitarbeitende zusammenarbeiten, treffen täglich unterschiedliche Welten aufeinander.\n\nDu bist präsent, auf Augenhöhe und weisst, wie du unterschiedliche Interessen zusammenführst.',
      '## Aufgaben\n\n- Du treibst die Weiterentwicklung der HR-Strategie voran\n- Du führst den HRM-Bereich',
      '## Anforderungen\n\n- Erfahrung in der Führung von Führungskräften',
      'Du kannst etwas, was andere nicht können?\nDann gehörst du zu uns!',
    ].join('\n\n'));
  });

  it('adds the detail-page benefit cards and contact, and nothing else from the page', () => {
    // Minimized from the live detail page (contact anonymized).
    const html = readFileSync(new URL('./fixtures/ksgr-detail-benefits-contact.html', import.meta.url), 'utf8');
    const extras = parseKsgrDetailExtras(html);
    expect(extras.benefitsHeading).toBe('Und das bieten wir dir');
    expect(extras.benefits).toEqual([
      expect.stringMatching(/^Beruf und Familie: Als flexible Arbeitgeberin/),
      expect.stringMatching(/^Ferien \/ Diensttreueurlaub: Der jährliche Ferienanspruch/),
    ]);
    expect(extras.contact).toContain('Erika Muster, Departementsleiterin Management Services');
    expect(extras.contact).toContain('Telefon +41 00 000 00 00');

    const composed = composeKsgrDescription('API TEXT', extras);
    expect(composed).toMatch(/^API TEXT\n\n## Und das bieten wir dir\n\n- Beruf und Familie: /);
    expect(composed).toContain('## Kontakt\n\nBei Fragen bin ich gerne für dich da:');
    // "Weitere spannende Stellen" / JobAbo teasers are chrome.
    expect(composed).not.toContain('Weitere spannende Stellen');
    expect(composed).not.toContain('JobAbo');
    // Unreadable page: the API text is published as is.
    expect(composeKsgrDescription('API TEXT', null)).toBe('API TEXT');
  });
});
