import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAllInselspitalJobs,
  isInselspitalJob,
  isTrustedDomain,
  umantisApplyUrl,
} from '../scripts/lib/inselspital-job-parser.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';

const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1000666/jobs';
const ORIGINAL_RETRIES = process.env.JOBS_CRAWLER_RETRIES;
const ORIGINAL_RETRY_BASE_MS = process.env.JOBS_CRAWLER_RETRY_BASE_MS;

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_RETRIES === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
  else process.env.JOBS_CRAWLER_RETRIES = ORIGINAL_RETRIES;
  if (ORIGINAL_RETRY_BASE_MS === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  else process.env.JOBS_CRAWLER_RETRY_BASE_MS = ORIGINAL_RETRY_BASE_MS;
});

describe('Inselspital Prospective API crawler', () => {
  it('prefers the apply link when the Umantis vacancy ID is absent', () => {
    expect(umantisApplyUrl(
      { szas: { sza_apply_link: '' } },
      {
        directLink: 'https://detail.example/',
        applyLink: 'https://apply.example/',
      },
    )).toBe('https://apply.example/');
  });

  it('keeps Umantis identity URLs while publishing the API source body', async () => {
    const sourceListing = {
      id: '19627',
      title: 'Fachexpert:in Wochenklinik Herz-Gefäss-Zentrum',
      links: {
        directlink: 'https://jobs.inselgruppe.ch/offene-stellen/fachexpertin/abc123',
      },
      szas: {
        sza_title: 'Fachexpert:in Wochenklinik Herz-Gefäss-Zentrum',
        sza_apply_link: '19627',
        'sza_location.city': 'Bern',
        'sza_location.zip': '3010',
        'sza_location.street': 'Freiburgstrasse',
        sza_introduction: 'Die Insel Gruppe verbindet universitäre Spitzenmedizin mit einer umfassenden wohnortnahen Versorgung und interprofessioneller Zusammenarbeit.',
        sza_tasks: '<ul><li>Sie koordinieren die klinischen Abläufe und begleiten Patientinnen und Patienten im interprofessionellen Team.</li><li>Sie entwickeln die Qualität der Versorgung weiter und unterstützen die Mitarbeitenden im Alltag.</li></ul>',
        sza_requirements: '<ul><li>Sie verfügen über eine anerkannte Ausbildung und mehrjährige Berufserfahrung im Gesundheitswesen.</li><li>Sie arbeiten zuverlässig, kommunizieren klar und übernehmen Verantwortung.</li></ul>',
        sza_benefits: '<ul><li>Wir bieten ein modernes Arbeitsumfeld, faire Anstellungsbedingungen und gezielte Weiterbildung.</li><li>Sie profitieren von einer sorgfältigen Einführung und flexiblen Arbeitsmodellen.</li></ul>',
        sza_company_profil: 'Die Insel Gruppe ist das grösste medizinische Vollversorgungssystem der Schweiz und engagiert sich für Forschung, Lehre und eine hochwertige Behandlung.',
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ total: 1, jobs: [sourceListing] }),
    }));

    const jobs = await fetchAllInselspitalJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      companyKey: 'inselspital',
      id: 'inselspital-2a9b6b8fe9fe',
      title: sourceListing.title,
      url: 'https://recruitingapp-2624.umantis.com/Vacancies/19627/Description/1',
      applyUrl: 'https://recruitingapp-2624.umantis.com/Vacancies/19627/Application/CheckLogin/1',
      location: 'Bern',
      canton: 'BE',
      postalCode: '3010',
      streetAddress: 'Freiburgstrasse',
      needsRetranslation: true,
    });
    expect(jobs[0].description).toContain('Sie koordinieren die klinischen Abläufe');
    expect(sourceBodyWordCount(jobs[0].description)).toBeGreaterThanOrEqual(50);
  });

  it('recognizes the API and ATS domains without trusting an unrelated host', () => {
    expect(isInselspitalJob({ companyKey: 'inselspital' })).toBe(true);
    expect(isInselspitalJob({ url: 'https://recruitingapp-2624.umantis.com/Vacancies/19627/Description/1' })).toBe(true);
    expect(isTrustedDomain(API_URL + '?lang=de&offset=0&limit=100')).toBe(true);
    expect(isTrustedDomain('https://example.com/jobs/19627')).toBe(false);
  });

  it('fails closed instead of returning a partial result when pagination is unavailable', async () => {
    process.env.JOBS_CRAWLER_RETRIES = '0';
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(fetchAllInselspitalJobs()).rejects.toThrow(/pagination failed at offset=0/);
  });
});
