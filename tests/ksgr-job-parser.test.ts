import { describe, expect, it } from 'vitest';

import { parseKsgrJobsPage } from '../scripts/lib/ksgr-job-parser.mjs';

describe('ksgr-job-parser', () => {
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
