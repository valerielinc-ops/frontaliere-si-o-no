/**
 * Phase 8 sub-PR (d) — TI invariance snapshot.
 *
 * HARD INVARIANT (plan + CLAUDE.md non-negotiables #1, #5, #6):
 * For every editorial landing emitted on canton == 'TI', the full URL path
 * (section + slug) MUST equal the pre-Phase-8 form byte-for-byte. The
 * "/cerca-lavoro-{canton}/" architecture extends to non-TI cantons only;
 * TI uses the legacy `cerca-lavoro` / `find-jobs-ticino` / `jobs-im-tessin` /
 * `trouver-emploi-tessin` sections AND the canton-named slug variants.
 *
 * If any URL in this snapshot changes for the TI canton, that's a
 * regression that breaks indexed pages. Fix the code, not the snapshot.
 */
import { describe, it, expect } from 'vitest';
import {
 getJobTodayLandingSlug,
 buildJobNursesHubLandingModel,
 buildJobPartTimeLandingModel,
 buildJobCareVariantLandingModel,
 partitionCareClusters,
} from '../../build-plugins/jobEditorialLanding';

const BASE_URL = 'https://frontaliereticino.ch';
const TI_SECTION_BY_LOCALE = {
 it: 'cerca-lavoro',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
} as const;
const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' } as const;
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

const localizedSlug = (job: any, locale: 'it' | 'en' | 'de' | 'fr') =>
 (job?.slug || job?.id || 'job') + '-' + locale;

const SAMPLE_JOBS = [
 {
  id: 'j1', slug: 'job-1', title: 'Infermiere', titleByLocale: { it: 'Infermiere', en: 'Nurse', de: 'Krankenpfleger', fr: 'Infirmier' },
  company: 'Clinica', location: 'Lugano', canton: 'TI', addressLocality: 'Lugano', datePosted: new Date().toISOString(),
  sector: 'sanita', contract: 'tempo-pieno',
 },
 {
  id: 'j2', slug: 'job-2', title: 'Educatore', titleByLocale: { it: 'Educatore', en: 'Educator', de: 'Pädagoge', fr: 'Éducateur' },
  company: 'Casa Anziani Lugano', location: 'Lugano', canton: 'TI', addressLocality: 'Lugano', datePosted: new Date().toISOString(),
  sector: 'sanita', contract: 'part-time',
 },
];

describe('Phase 8 sub-PR (d) — TI editorial URL invariance', () => {
 it('TI today-landing slug × 4 locales is the legacy long form', () => {
  expect(getJobTodayLandingSlug('it', 'TI')).toBe('offerte-di-lavoro-ticino-oggi');
  expect(getJobTodayLandingSlug('en', 'TI')).toBe('ticino-jobs-today');
  expect(getJobTodayLandingSlug('de', 'TI')).toBe('jobs-tessin-heute');
  expect(getJobTodayLandingSlug('fr', 'TI')).toBe('offres-emploi-tessin-aujourdhui');
 });

 it('TI nurses-hub model slug × 4 locales matches the legacy long form', () => {
  const partition = partitionCareClusters(SAMPLE_JOBS as any);
  const expected = {
   it: 'infermieri-in-ticino',
   en: 'nurses-in-ticino',
   de: 'pflege-jobs-im-tessin',
   fr: 'infirmiers-au-tessin',
  } as const;
  for (const locale of LOCALES) {
   const model = buildJobNursesHubLandingModel({
    jobs: SAMPLE_JOBS as any,
    locale,
    now: new Date().toISOString(),
    localizedSlug,
    baseUrl: BASE_URL,
    sectionSlug: TI_SECTION_BY_LOCALE[locale],
    localePrefix: LOCALE_PREFIX[locale],
    canton: 'TI',
    partition,
   });
   expect(model.slug).toBe(expected[locale]);
  }
 });

 it('TI part-time landing slug × 4 locales matches the legacy long form', () => {
  const expected = {
   it: 'lavoro-part-time-ticino',
   en: 'part-time-jobs-ticino',
   de: 'teilzeit-jobs-tessin',
   fr: 'emploi-temps-partiel-tessin',
  } as const;
  for (const locale of LOCALES) {
   const model = buildJobPartTimeLandingModel({
    jobs: SAMPLE_JOBS as any,
    locale,
    now: new Date().toISOString(),
    localizedSlug,
    baseUrl: BASE_URL,
    sectionSlug: TI_SECTION_BY_LOCALE[locale],
    localePrefix: LOCALE_PREFIX[locale],
    canton: 'TI',
   });
   expect(model.slug).toBe(expected[locale]);
  }
 });

 it('TI care-cluster (clinics) slug × 4 locales matches the legacy long form', () => {
  const partition = partitionCareClusters(SAMPLE_JOBS as any);
  const expected = {
   it: 'cliniche-ticino',
   en: 'clinics-ticino-jobs',
   de: 'kliniken-tessin-jobs',
   fr: 'cliniques-tessin',
  } as const;
  for (const locale of LOCALES) {
   const model = buildJobCareVariantLandingModel({
    jobs: SAMPLE_JOBS as any,
    locale,
    clusterKey: 'clinics',
    now: new Date().toISOString(),
    localizedSlug,
    baseUrl: BASE_URL,
    sectionSlug: TI_SECTION_BY_LOCALE[locale],
    localePrefix: LOCALE_PREFIX[locale],
    canton: 'TI',
    partition,
   });
   expect(model.slug).toBe(expected[locale]);
  }
 });
});
