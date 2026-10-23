import { describe, expect, it } from 'vitest';

import { renderProfessionCantonPage } from '../../build-plugins/professionCantonLandings';
import { renderProfessionCityPage } from '../../build-plugins/professionCityLandings';
import { buildProfessionCityPath, getProfessionCityDef } from '../../build-plugins/professionCityData';
import {
  PROFESSION_JOURNEY_ANCHORS,
  buildProfessionJourneyAlertHref,
  buildProfessionJourneySearchHref,
} from '../../build-plugins/shared/professionJourney';
import {
  professionRoleKeyword,
  professionRoleKeywordAny,
  type ProfessionLocale,
} from '../../build-plugins/professionLandingsData';
import type { ProfessionJobsSnapshot } from '../../build-plugins/professionJobsAggregate';
import { professionLabel as cantonProfessionLabel } from '../../build-plugins/shared/professionJobsFloor';
import { getCantonDisplayName } from '../../build-plugins/shared/cantonDisplay';
import { getJobBoardSlugForCanton } from '../../services/jobBoardSlugs';
import { parsePath } from '../../services/router';

const LOCALES: readonly ProfessionLocale[] = ['it', 'en', 'de', 'fr'];
const JOBS: ProfessionJobsSnapshot = {
  liveCount: 12,
  fresh30Count: 5,
  medianSalaryChf: 84000,
  reportedSalary: { sampleCount: 5, medianChf: 84000 },
  featured: [],
  jobs: [],
  topEmployers: [
    { name: 'Ospedale Regionale', count: 6 },
    { name: 'Clinica Privata SA', count: 3 },
  ],
};
const REQUIREMENTS_LISTING_COPY: Record<ProfessionLocale, string> = {
  it: 'Requisiti negli annunci',
  en: 'Requirements in listings',
  de: 'Anforderungen in den Stellen',
  fr: 'Exigences dans les annonces',
};
const NET_TICINO_SCOPE_COPY: Record<ProfessionLocale, string> = {
  it: 'imposta alla fonte ticinese',
  en: 'Ticino withholding tax',
  de: 'Tessiner Quellensteuer',
  fr: 'impôt à la source tessinois',
};
const NET_TICINO_VISIBLE_COPY: Record<ProfessionLocale, string> = {
  it: 'Simula netto Ticino',
  en: 'Ticino net-pay estimate',
  de: 'Nettolohn im Tessin',
  fr: 'Simulateur net tessinois',
};
const JOURNEY_ARIA_INTRO: Record<ProfessionLocale, string> = {
  it: 'Percorso per orientarti tra le offerte',
  en: 'Explore this role and its job openings',
  de: 'Stellenangebote für diesen Beruf erkunden',
  fr: 'Explorer ce métier et ses offres',
};

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function attribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeHtmlAttribute(value);
}

function openingTags(html: string, name: string): string[] {
  return Array.from(html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi')), (match) => match[0]);
}

function hrefForJourneyStep(html: string, roleKey: string, step: string): string {
  const expectedLabel = `profession_journey:${roleKey}:${step}`;
  const tag = openingTags(html, 'a').find((candidate) => attribute(candidate, 'data-analytics-label') === expectedLabel);
  const href = tag ? attribute(tag, 'href') : null;
  if (!href) throw new Error(`Missing ${roleKey}/${step} journey link.`);
  return href;
}

function expectInteractiveJobBoardHref(
  href: string,
  locale: ProfessionLocale,
  canton: string,
  keyword: string,
  expectedJobSlug?: string,
): void {
  const url = new URL(href, 'https://frontaliereticino.ch');
  expect(url.searchParams.get('q')).toBe(keyword);
  const parsed = parsePath(url.pathname);
  expect(parsed.locale).toBe(locale);
  expect(parsed.route.activeTab).toBe('job-board');
  expect(parsed.route.jobBoardCanton).toBe(canton);
  expect(parsed.route.staticOverlay).not.toBe(true);
  if (expectedJobSlug) expect(parsed.route.jobSlug).toBe(expectedJobSlug);
}

function sectionCount(html: string, id: string): number {
  return openingTags(html, 'section').filter((tag) => attribute(tag, 'id') === id).length;
}

function professionJourneyAriaLabel(html: string): string | null {
  const nav = openingTags(html, 'nav').find((tag) => attribute(tag, 'data-profession-journey') === 'infermiere');
  return nav ? attribute(nav, 'aria-label') : null;
}

function companyEmptyState(html: string): string {
  const tag = openingTags(html, 'section').find((candidate) => attribute(candidate, 'id') === PROFESSION_JOURNEY_ANCHORS.companies);
  const start = tag ? html.indexOf(tag) : -1;
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) throw new Error('Missing profession companies section.');
  return html.slice(start, end + '</section>'.length);
}

describe('profession canton journey', () => {
  it.each(LOCALES)('keeps the role and canton in the search and alert links (%s)', (locale) => {
    const { html } = renderProfessionCantonPage({
      locale,
      cantonKey: 'ZH',
      id: 'infermiere',
      snapshot: JOBS,
      distDir: '',
    });
    const role = 'infermiere';
    const keyword = professionRoleKeywordAny(locale, 'infermiere');
    const boardPath = `${locale === 'it' ? '' : `/${locale}`}/${getJobBoardSlugForCanton('ZH', locale)}/`;
    const searchHref = buildProfessionJourneySearchHref(boardPath, keyword);
    const offersHref = hrefForJourneyStep(html, role, 'offers');
    const alertHref = hrefForJourneyStep(html, role, 'alert');

    expect(offersHref).toBe(searchHref);
    expectInteractiveJobBoardHref(offersHref, locale, 'ZH', keyword);
    expect(alertHref).toBe(buildProfessionJourneyAlertHref(boardPath, keyword));
    expectInteractiveJobBoardHref(alertHref, locale, 'ZH', keyword);
    expect(new URL(alertHref, 'https://frontaliereticino.ch').searchParams.get('alert')).toBe('1');
    expect(new URL(alertHref, 'https://frontaliereticino.ch').hash).toBe('#job-alert-form');

    expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.requirements)).toBe(0);
    expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.companies)).toBe(1);
    const requirementsHref = hrefForJourneyStep(html, role, 'requirements');
    expect(requirementsHref).toBe(searchHref);
    expectInteractiveJobBoardHref(requirementsHref, locale, 'ZH', keyword);
    expect(html).toContain(REQUIREMENTS_LISTING_COPY[locale]);
    expect(hrefForJourneyStep(html, role, 'companies')).toBe(`#${PROFESSION_JOURNEY_ANCHORS.companies}`);
    expect(html).toContain(NET_TICINO_SCOPE_COPY[locale]);
    expect(html).toContain(NET_TICINO_VISIBLE_COPY[locale]);
    expect(professionJourneyAriaLabel(html)).toBe(
      `${JOURNEY_ARIA_INTRO[locale]}: ${cantonProfessionLabel(locale, 'infermiere')} · ${getCantonDisplayName('ZH', locale)}`,
    );
  });

  it('does not prefill a benchmark or an under-floor salary sample', () => {
    const { html } = renderProfessionCantonPage({
      locale: 'en',
      cantonKey: 'ZH',
      id: 'infermiere',
      snapshot: { ...JOBS, reportedSalary: { sampleCount: 4, medianChf: 84000 } },
      distDir: '',
    });
    const netHref = hrefForJourneyStep(html, 'infermiere', 'net');
    expect(netHref).toBe('/en/calculate-salary/');
    expect(html).toContain(NET_TICINO_VISIBLE_COPY.en);
    expect(html).toContain(NET_TICINO_SCOPE_COPY.en);
  });

  it('explains when no reliable employer list is available and links to filtered openings', () => {
    const { html } = renderProfessionCantonPage({
      locale: 'it',
      cantonKey: 'ZH',
      id: 'infermiere',
      snapshot: { ...JOBS, topEmployers: [] },
      distDir: '',
    });
    const keyword = professionRoleKeywordAny('it', 'infermiere');
    const boardPath = `/${getJobBoardSlugForCanton('ZH', 'it')}/`;
    const searchHref = buildProfessionJourneySearchHref(boardPath, keyword);
    expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.companies)).toBe(1);
    expect(hrefForJourneyStep(html, 'infermiere', 'companies')).toBe(`#${PROFESSION_JOURNEY_ANCHORS.companies}`);
    const emptyState = companyEmptyState(html);
    const cta = openingTags(emptyState, 'a').find((tag) => attribute(tag, 'href') === searchHref);
    expect(cta).toBeDefined();
    expect(emptyState).toContain('Aziende non nominate negli annunci');
    expect(emptyState).toContain('Vedi le offerte filtrate');
  });

  it.each(LOCALES)('prefills only the verified annual CHF sample when at least five ads qualify (%s)', (locale) => {
    const { html } = renderProfessionCantonPage({ locale, cantonKey: 'ZH', id: 'infermiere', snapshot: JOBS, distDir: '' });
    const netHref = hrefForJourneyStep(html, 'infermiere', 'net');
    const url = new URL(netHref, 'https://frontaliereticino.ch');
    expect(url.searchParams.get('reddito')).toBe('84000');
    expect(url.searchParams.get('canton')).toBeNull();
  });
});

describe('profession city journey', () => {
  const CITY_CASES = [
    { city: 'lugano', canton: 'TI', locationPrefix: { it: 'localita', en: 'location', de: 'standort', fr: 'localite' } },
    { city: 'zurich', canton: 'ZH', locationPrefix: { it: 'localita', en: 'location', de: 'standort', fr: 'localite' } },
    { city: 'basel', canton: 'BASILEA', locationPrefix: { it: 'localita', en: 'location', de: 'standort', fr: 'localite' } },
  ] as const;

  it.each(CITY_CASES.flatMap((city) => LOCALES.map((locale) => [city, locale] as const)))(
    'uses the interactive city-filter route and keeps role/city in search and alert (%s/%s)',
    (city, locale) => {
      const { html } = renderProfessionCityPage({
        locale,
        cityKey: city.city,
        id: 'infermiere',
        snapshot: JOBS,
        distDir: '',
      });
      const role = 'infermiere';
      const keyword = professionRoleKeyword(locale, 'infermiere');
      const locationSlug = `${city.locationPrefix[locale]}-${city.city}`;
      const boardPath = `${locale === 'it' ? '' : `/${locale}`}/${getJobBoardSlugForCanton(city.canton, locale)}/${locationSlug}/`;
      const searchHref = buildProfessionJourneySearchHref(boardPath, keyword);
      const offersHref = hrefForJourneyStep(html, role, 'offers');
      const alertHref = hrefForJourneyStep(html, role, 'alert');

      expect(buildProfessionCityPath(locale, city.city, 'infermiere')).toMatch(/\/$/);
      expect(offersHref).toBe(searchHref);
      expectInteractiveJobBoardHref(offersHref, locale, city.canton, keyword, locationSlug);
      expect(alertHref).toBe(buildProfessionJourneyAlertHref(boardPath, keyword));
      expectInteractiveJobBoardHref(alertHref, locale, city.canton, keyword, locationSlug);
      expect(new URL(alertHref, 'https://frontaliereticino.ch').searchParams.get('alert')).toBe('1');
      expect(new URL(alertHref, 'https://frontaliereticino.ch').hash).toBe('#job-alert-form');

      expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.requirements)).toBe(0);
      expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.companies)).toBe(1);
      const requirementsHref = hrefForJourneyStep(html, role, 'requirements');
      expect(requirementsHref).toBe(searchHref);
      expectInteractiveJobBoardHref(requirementsHref, locale, city.canton, keyword, locationSlug);
      expect(html).toContain(REQUIREMENTS_LISTING_COPY[locale]);
      expect(hrefForJourneyStep(html, role, 'companies')).toBe(`#${PROFESSION_JOURNEY_ANCHORS.companies}`);
      expect(html).not.toContain(`href="${boardPath}"`);
      expect(html).toContain(NET_TICINO_SCOPE_COPY[locale]);
      expect(html).toContain(NET_TICINO_VISIBLE_COPY[locale]);
      const cityDef = getProfessionCityDef(city.city);
      const cityRole = professionRoleKeyword(locale, 'infermiere').replace(/-/g, ' ');
      const localizedCityRole = cityRole.charAt(0).toUpperCase() + cityRole.slice(1);
      expect(professionJourneyAriaLabel(html)).toBe(
        `${JOURNEY_ARIA_INTRO[locale]}: ${localizedCityRole} · ${cityDef?.display}`,
      );
    },
  );

  it('does not prefill a city benchmark as an observed profession salary', () => {
    const { html } = renderProfessionCityPage({
      locale: 'fr',
      cityKey: 'zurich',
      id: 'infermiere',
      snapshot: { ...JOBS, reportedSalary: undefined },
      distDir: '',
    });
    expect(hrefForJourneyStep(html, 'infermiere', 'net')).toBe('/fr/calculer-salaire/');
    expect(html).toContain(NET_TICINO_VISIBLE_COPY.fr);
  });

  it('keeps the companies step on a real local state when the sample has no employer names', () => {
    const { html } = renderProfessionCityPage({
      locale: 'de', cityKey: 'zurich', id: 'infermiere', snapshot: { ...JOBS, topEmployers: [] }, distDir: '',
    });
    expect(sectionCount(html, PROFESSION_JOURNEY_ANCHORS.companies)).toBe(1);
    expect(hrefForJourneyStep(html, 'infermiere', 'companies')).toBe(`#${PROFESSION_JOURNEY_ANCHORS.companies}`);
    expect(companyEmptyState(html)).toContain('Keine Arbeitgebernamen');
  });
});
