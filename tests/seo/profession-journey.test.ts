import { describe, expect, it } from 'vitest';
import {
  buildProfessionJourneyAlertHref,
  buildProfessionJourneyNetHref,
  buildProfessionJourneySearchHref,
  PROFESSION_JOURNEY_ANCHORS,
  renderProfessionJourney,
} from '../../build-plugins/shared/professionJourney';
import { reportedSalarySummary } from '../../build-plugins/shared/realSalaryMedian';
import {
  buildProfessionLandingPath,
  PROFESSION_IDS,
  type ProfessionId,
} from '../../build-plugins/professionLandingsData';
import { buildProfessionLandingCopy, buildProfessionRoleLabel, buildProfessionLandingSections } from '../../build-plugins/professionLandingsCopy';
import {
  renderProfessionLandingForJourneyTest,
} from '../../build-plugins/professionLandingsPlugin';
import {
  buildNursingLandingPath,
  NURSING_LANDING_IDS,
  type NursingLandingId,
} from '../../build-plugins/nursingLandingsData';
import { renderNursingLandingForJourneyTest } from '../../build-plugins/nursingLandingsPlugin';
import { buildSectorLandingHtml } from '../../build-plugins/jobSectorPagesPlugin';
import { buildJobBoardUrl } from '../../build-plugins/cityJobsAggregate';
import type { JobBoardLocale } from '../../build-plugins/jobBoardSeo';
import type { ProfessionJobsSnapshot, FeaturedJob } from '../../build-plugins/professionJobsAggregate';
import type { SectorCountableJob, SectorHubKey } from '../../build-plugins/jobSectorLanding';

const LOCALES: readonly JobBoardLocale[] = ['it', 'en', 'de', 'fr'];
const REPORTED_ANNUAL_SALARIES = [60000, 62000, 64000, 66000, 68000];

function reportedSalaryJobs(): FeaturedJob[] {
  return REPORTED_ANNUAL_SALARIES.map((salary, index) => ({
    id: `role-job-${index}`,
    title: 'Nurse',
    titleByLocale: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachfrau', fr: 'Infirmier' },
    company: `Employer ${index + 1}`,
    companyKey: null,
    companyDomain: null,
    city: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    contract: 'full-time',
    salaryMin: salary,
    salaryMax: salary,
    salarySource: 'reported',
    currency: 'CHF',
    postedDate: '2026-10-01',
    daysAgo: 1,
    slug: `role-job-${index}`,
    slugByLocale: {},
    employmentType: 'full-time',
    url: null,
  }));
}

function salarySnapshot(): ProfessionJobsSnapshot {
  const jobs = reportedSalaryJobs();
  return {
    liveCount: jobs.length,
    fresh30Count: jobs.length,
    medianSalaryChf: null,
    reportedSalary: reportedSalarySummary(jobs),
    featured: [],
    jobs,
    topEmployers: [],
  };
}

function findJourneyHref(html: string, role: string, step: string): string {
  const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedStep = step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<a href=(?:"([^"]+)"|'([^']+)'|([^\\s>]+))[^>]*data-analytics-label=(?:"profession_journey:${escapedRole}:${escapedStep}"|'profession_journey:${escapedRole}:${escapedStep}'|profession_journey:${escapedRole}:${escapedStep})`));
  expect(match, `missing ${role}/${step} journey link`).toBeTruthy();
  return String(match?.[1] || match?.[2] || match?.[3] || '').replace(/&amp;/g, '&');
}

function countId(html: string, id: string): number {
  return (html.match(new RegExp(`\\bid=(?:"${id}"|'${id}'|${id})(?=\\s|>)`, 'g')) || []).length;
}

function idPosition(html: string, id: string): number {
  return html.search(new RegExp(`\\bid=(?:"${id}"|'${id}'|${id})(?=\\s|>)`));
}

function makeSectorJob(
  sector: SectorHubKey,
  index: number,
  roleTitles: Record<JobBoardLocale, string>,
): SectorCountableJob {
  const title = roleTitles.it;
  const job = {
    title,
    titleByLocale: roleTitles,
    company: index < 5 ? `Role Employer ${index + 1}` : 'General Sector Employer',
    companyKey: null,
    companyDomain: null,
    location: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    slug: `${sector}-${index}`,
    slugByLocale: { it: `${sector}-${index}`, en: `${sector}-${index}`, de: `${sector}-${index}`, fr: `${sector}-${index}` },
    category: sector,
    salaryMin: index < 5 ? REPORTED_ANNUAL_SALARIES[index] : 250000,
    salaryMax: index < 5 ? REPORTED_ANNUAL_SALARIES[index] : 250000,
    salarySource: 'reported',
    currency: 'CHF',
  };
  return job as unknown as SectorCountableJob;
}

const SECTOR_CASES: ReadonlyArray<{
  sector: Extract<SectorHubKey, 'infermieri' | 'case-anziani' | 'educatori' | 'autisti' | 'hotel' | 'ristorazione'>;
  query: Record<JobBoardLocale, string>;
  titles: Record<JobBoardLocale, string>;
  roleLabels: Record<JobBoardLocale, string>;
  journeyKey: string;
  roleSpecific: boolean;
}> = [
  {
    sector: 'infermieri',
    query: { it: 'infermiere', en: 'nurse', de: 'Pflegefachfrau', fr: 'infirmier' },
    titles: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachfrau', fr: 'Infirmier' },
    roleLabels: { it: 'infermieri', en: 'nursing jobs', de: 'Pflegefachberufe', fr: 'métiers infirmiers' },
    journeyKey: 'infermiere',
    roleSpecific: true,
  },
  {
    sector: 'case-anziani',
    query: { it: 'case anziani', en: 'elderly care', de: 'Altenpflege', fr: 'maison de retraite' },
    titles: { it: 'Operatore socio sanitario', en: 'Healthcare assistant', de: 'Pflegehelfer', fr: 'Aide-soignant' },
    roleLabels: { it: 'lavorare nelle case anziani', en: 'elderly-care jobs', de: 'Stellen in der Altenpflege', fr: 'emplois en maison de retraite' },
    journeyKey: 'case-anziani',
    roleSpecific: false,
  },
  {
    sector: 'educatori',
    query: { it: 'educatore', en: 'educator', de: 'Erzieher', fr: 'éducateur' },
    titles: { it: 'Educatore', en: 'Educator', de: 'Erzieher', fr: 'Éducateur' },
    roleLabels: { it: 'educatori', en: 'educators', de: 'Erzieher', fr: 'éducateurs' },
    journeyKey: 'educatore',
    roleSpecific: true,
  },
  {
    sector: 'autisti',
    query: { it: 'autista', en: 'driver', de: 'Fahrer', fr: 'chauffeur' },
    titles: { it: 'Autista', en: 'Driver', de: 'Fahrer', fr: 'Chauffeur' },
    roleLabels: { it: 'autisti', en: 'drivers', de: 'Fahrer', fr: 'chauffeurs' },
    journeyKey: 'autista',
    roleSpecific: true,
  },
  {
    sector: 'hotel',
    query: { it: 'receptionist', en: 'receptionist', de: 'Rezeptionist', fr: 'réceptionniste' },
    titles: { it: 'Receptionist', en: 'Receptionist', de: 'Rezeptionist', fr: 'Réceptionniste' },
    roleLabels: { it: 'receptionist', en: 'receptionists', de: 'Rezeptionisten', fr: 'réceptionnistes' },
    journeyKey: 'receptionist',
    roleSpecific: true,
  },
  {
    sector: 'ristorazione',
    query: { it: 'pasticciere', en: 'pastry chef', de: 'Konditor', fr: 'pâtissier' },
    titles: { it: 'Pasticciere', en: 'Pastry chef', de: 'Konditor', fr: 'Pâtissier' },
    roleLabels: { it: 'pasticcieri', en: 'pastry chefs', de: 'Konditoren', fr: 'pâtissiers' },
    journeyKey: 'pasticciere',
    roleSpecific: true,
  },
];

describe('profession journey links', () => {
  it.each(LOCALES)('renders five localized steps in %s with stable click labels', (locale) => {
    const hrefs = {
      offers: '#offers',
      requirements: '#requirements',
      net: '/calcola-stipendio/?reddito=64000',
      companies: '#companies',
      alert: '/cerca-lavoro-ticino/?q=nurse&alert=1#job-alert-form',
    };
    const html = renderProfessionJourney({
      locale,
      professionKey: 'nurse role',
      roleLabel: 'nurses',
      hrefs,
      netSalaryPrefilled: true,
    });

    expect(html).toContain('nurses');
    expect(html).toContain('data-analytics-label="profession_journey:nurse-role:offers"');
    expect(html).toContain('aria-label=');
    expect(html.indexOf('profession_journey:nurse-role:offers')).toBeLessThan(html.indexOf('profession_journey:nurse-role:requirements'));
    expect(html.indexOf('profession_journey:nurse-role:requirements')).toBeLessThan(html.indexOf('profession_journey:nurse-role:net'));
    expect(html.indexOf('profession_journey:nurse-role:net')).toBeLessThan(html.indexOf('profession_journey:nurse-role:companies'));
    expect(html.indexOf('profession_journey:nurse-role:companies')).toBeLessThan(html.indexOf('profession_journey:nurse-role:alert'));
  });

  it('uses the existing annual gross query and fails closed without a reported sample', () => {
    const eligible = REPORTED_ANNUAL_SALARIES.map((salary) => ({
      salaryMin: salary,
      salaryMax: salary,
      salarySource: 'reported',
      currency: 'CHF',
    }));
    const summary = reportedSalarySummary([
      ...eligible,
      { salaryMin: 250000, salaryMax: 250000, salarySource: 'estimated', currency: 'CHF' },
      { salaryMin: 200000, salaryMax: 200000, salarySource: 'reported', currency: 'EUR' },
      { salaryMin: 10000, salaryMax: 10000, salarySource: 'reported', currency: 'CHF' },
    ]);

    expect(summary).toEqual({ sampleCount: 5, medianChf: 64000 });
    expect(reportedSalarySummary(eligible.slice(0, 4))).toEqual({ sampleCount: 4, medianChf: null });
    expect(buildProfessionJourneyNetHref('/en/calculate-salary/', summary.medianChf)).toBe('/en/calculate-salary/?reddito=64000');
    expect(buildProfessionJourneyNetHref('/en/calculate-salary/', null)).toBe('/en/calculate-salary/');
    const fallback = renderProfessionJourney({
      locale: 'en',
      professionKey: 'test-role',
      roleLabel: 'test role',
      hrefs: { offers: '#offers', requirements: '#requirements', net: '/en/calculate-salary/', companies: '#companies', alert: '#alert' },
      netSalaryPrefilled: false,
    });
    expect(fallback).toContain('Enter annual gross pay to estimate net');
    expect(fallback).toContain('Enter your annual gross pay to estimate net pay.');
  });

  it('builds the existing q-filtered alert route without creating another landing', () => {
    const boardPath = '/en/jobs-ticino/';
    expect(buildProfessionJourneySearchHref(boardPath, 'pastry chef')).toBe('/en/jobs-ticino/?q=pastry+chef');
    expect(buildProfessionJourneyAlertHref(boardPath, 'réceptionniste')).toBe('/en/jobs-ticino/?q=r%C3%A9ceptionniste&alert=1#job-alert-form');
  });
});

describe('profession and nursing landing integration', () => {
  const snapshot = salarySnapshot();

  it.each(PROFESSION_IDS.flatMap((id) => LOCALES.map((locale) => [id, locale] as const)))(
    'emits profession journey anchors and localized alert query for %s/%s',
    (id, locale) => {
      const html = renderProfessionLandingForJourneyTest(id as ProfessionId, locale, snapshot);
      const role = id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      for (const anchor of Object.values(PROFESSION_JOURNEY_ANCHORS)) expect(countId(html, anchor), anchor).toBe(1);
      expect(html).toMatch(new RegExp(`data-profession-journey=(?:"${role}"|'${role}'|${role})(?=\\s|>)`));
      const copy = buildProfessionLandingSections(locale, id as ProfessionId);
      const requirementTitle = locale === 'it'
        ? buildProfessionLandingCopy(locale, id as ProfessionId, { liveCount: 5, fresh30Count: 5 }).sectionHeadings.application
        : buildProfessionLandingCopy(locale, id as ProfessionId, { liveCount: 5, fresh30Count: 5 }).sectionHeadings.context;
      const requirements = copy.find((section) => section.title === requirementTitle);
      expect(requirements).toBeTruthy();
      const requirementsStart = idPosition(html, PROFESSION_JOURNEY_ANCHORS.requirements);
      expect(html.slice(requirementsStart, requirementsStart + 8000)).toContain(requirements?.paragraphs[0]);
      const keyword = buildProfessionRoleLabel(locale, id as ProfessionId)
        .replace(/\/[\-\wÀ-ÿ]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const alertHref = findJourneyHref(html, role, 'alert');
      expect(alertHref).toBe(buildProfessionJourneyAlertHref(buildJobBoardUrl(locale), keyword));
      expect(findJourneyHref(html, role, 'net')).toContain('reddito=64000');
      expect(html.indexOf('data-profession-journey=')).toBeLessThan(idPosition(html, PROFESSION_JOURNEY_ANCHORS.offers));
    },
  );

  it.each(NURSING_LANDING_IDS.flatMap((id) => LOCALES.map((locale) => [id, locale] as const)))(
    'emits nursing journey anchors and uses fallback salary jobs for %s/%s',
    (id, locale) => {
      const nursingSnapshot = {
        ...snapshot,
        reportedSalary: undefined,
        jobs: reportedSalaryJobs(),
      } as ProfessionJobsSnapshot;
      const html = renderNursingLandingForJourneyTest(id as NursingLandingId, locale, nursingSnapshot);
      const role = id;
      for (const anchor of Object.values(PROFESSION_JOURNEY_ANCHORS)) expect(countId(html, anchor), anchor).toBe(1);
      expect(html).toMatch(new RegExp(`data-profession-journey=(?:"${role}"|'${role}'|${role})(?=\\s|>)`));
      expect(findJourneyHref(html, role, 'net')).toContain('reddito=64000');
      expect(html.indexOf('data-profession-journey=')).toBeLessThan(idPosition(html, PROFESSION_JOURNEY_ANCHORS.offers));
      expect(buildNursingLandingPath(locale, id as NursingLandingId)).toMatch(/^\//);
    },
  );
});

describe('sector journey integration', () => {
  it.each(SECTOR_CASES.flatMap((entry) => LOCALES.map((locale) => [entry, locale] as const)))(
    'renders role-specific journeys for $0.sector/$1',
    (entry, locale) => {
      const jobTitles = entry.titles;
      const matchingJobs = [
        ...Array.from({ length: 5 }, (_, index) => makeSectorJob(entry.sector, index, jobTitles)),
        makeSectorJob(entry.sector, 5, { it: 'General hotel employee', en: 'Hotel worker', de: 'Hotelmitarbeiter', fr: 'Employé hôtelier' }),
      ];
      const html = buildSectorLandingHtml({
        sector: entry.sector,
        locale,
        matchingJobs,
        count: matchingJobs.length,
        year: 2026,
        dateStamp: '2026-10-20',
        sectorProseData: {},
      });

      expect(html).toContain(`data-profession-journey="${entry.journeyKey}"`);
      expect(html).toContain(entry.roleLabels[locale]);
      expect(countId(html, PROFESSION_JOURNEY_ANCHORS.offers)).toBe(1);
      expect(countId(html, PROFESSION_JOURNEY_ANCHORS.companies)).toBe(1);
      expect(html).toContain('Role Employer 1');
      expect(html.indexOf('data-profession-journey=')).toBeLessThan(idPosition(html, PROFESSION_JOURNEY_ANCHORS.offers));

      const boardPath = buildJobBoardUrl(locale);
      const alertHref = findJourneyHref(html, entry.journeyKey, 'alert');
      expect(alertHref).toBe(buildProfessionJourneyAlertHref(boardPath, entry.query[locale]));
      const offersHref = findJourneyHref(html, entry.journeyKey, 'offers');
      if (entry.sector === 'hotel' || entry.sector === 'ristorazione') {
        expect(offersHref).toBe(buildProfessionJourneySearchHref(boardPath, entry.query[locale]));
      } else {
        expect(offersHref).toBe(`#${PROFESSION_JOURNEY_ANCHORS.offers}`);
      }

      const netHref = findJourneyHref(html, entry.journeyKey, 'net');
      if (entry.roleSpecific) expect(netHref).toContain('reddito=64000');
      else expect(netHref).toBe(locale === 'it' ? '/calcola-stipendio/' : ({ en: '/en/calculate-salary/', de: '/de/gehalt-berechnen/', fr: '/fr/calculer-salaire/' }[locale]));

      if (entry.sector === 'hotel' || entry.sector === 'ristorazione') {
        expect(countId(html, PROFESSION_JOURNEY_ANCHORS.requirements)).toBe(1);
        expect(findJourneyHref(html, entry.journeyKey, 'requirements')).toBe(`#${PROFESSION_JOURNEY_ANCHORS.requirements}`);
        expect(html).toContain('General Sector Employer');
      } else {
        expect(countId(html, PROFESSION_JOURNEY_ANCHORS.requirements)).toBe(0);
        const expectedPath = entry.sector === 'case-anziani'
          ? `${buildNursingLandingPath(locale, 'healthcare-ticino')}#${PROFESSION_JOURNEY_ANCHORS.requirements}`
          : `${buildProfessionLandingPath(locale, ({ infermieri: 'infermiere', educatori: 'educatore', autisti: 'autista' } as const)[entry.sector])}#${PROFESSION_JOURNEY_ANCHORS.requirements}`;
        expect(findJourneyHref(html, entry.journeyKey, 'requirements')).toBe(expectedPath);
      }
    },
  );

  it('matches Italian pasticciere titles without locale variants and excludes adjacent kitchen roles', () => {
    const pastryJobs = Array.from({ length: 5 }, (_, index) => ({
      title: `Pasticciere ${index + 1}`,
      company: `Pasticceria ${index + 1}`,
      canton: 'TI',
      location: 'Lugano',
      salaryMin: REPORTED_ANNUAL_SALARIES[index],
      salaryMax: REPORTED_ANNUAL_SALARIES[index],
      salarySource: 'reported',
      currency: 'CHF',
    } as unknown as SectorCountableJob));
    pastryJobs.push({
      title: 'Aiuto cuoco',
      company: 'Ristorante generico',
      canton: 'TI',
      location: 'Lugano',
      salaryMin: 250000,
      salaryMax: 250000,
      salarySource: 'reported',
      currency: 'CHF',
    } as unknown as SectorCountableJob);

    const html = buildSectorLandingHtml({
      sector: 'ristorazione',
      locale: 'it',
      matchingJobs: pastryJobs,
      count: pastryJobs.length,
      year: 2026,
      dateStamp: '2026-10-20',
      sectorProseData: {},
    });
    expect(findJourneyHref(html, 'pasticciere', 'net')).toContain('reddito=64000');
    expect(html).toContain('Pasticceria 1');
    expect(html).toContain('Ristorante generico');
  });
});
