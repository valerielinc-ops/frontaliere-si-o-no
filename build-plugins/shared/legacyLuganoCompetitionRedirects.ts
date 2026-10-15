import { SECTION_LEGACY_TI_PATH, type CantonLocale } from './cantonSection';

/** These old records were directory headings, not individual vacancies. */
const LUGANO_COMPETITION_SUFFIX_BY_LOCALE: Record<CantonLocale, string> = {
  it: 'concorsi-per-posti-di-lavoro-concorsi-per-aziende-e-altri-concorsi-aperti-dalla-citt-agrave-citta-di-lugano',
  en: 'concorsi-per-posti-di-lavoro-concorsi-per-aziende-e-altri-concorsi-aperti-dalla-citt-agrave-city-of-lugano',
  de: 'concorsi-per-posti-di-lavoro-concorsi-per-aziende-e-altri-concorsi-aperti-dalla-citt-agrave-stadt-lugano',
  fr: 'concorsi-per-posti-di-lavoro-concorsi-per-aziende-e-altri-concorsi-aperti-dalla-citt-agrave-ville-de-lugano',
};

const LUGANO_COMPETITION_TARGET_BY_LOCALE: Record<CantonLocale, string> = {
  it: '/concorsi-pubblici-lugano/',
  en: '/en/public-sector-jobs-lugano/',
  de: '/de/oeffentliche-stellen-lugano/',
  fr: '/fr/concours-publics-lugano/',
};

export const LEGACY_LUGANO_COMPETITION_REDIRECTS: Record<string, string> = Object.fromEntries(
  (Object.keys(LUGANO_COMPETITION_SUFFIX_BY_LOCALE) as CantonLocale[]).map((locale) => [
    `${SECTION_LEGACY_TI_PATH[locale]}${LUGANO_COMPETITION_SUFFIX_BY_LOCALE[locale]}/`,
    LUGANO_COMPETITION_TARGET_BY_LOCALE[locale],
  ]),
) as Record<string, string>;
