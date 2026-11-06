// weeklyEmployersRoutes.mjs
//
// Runtime-neutral route contract shared by the TypeScript page generator,
// client analytics classifier and Node SEO crawler. Keeping the locale/slug
// mapping here prevents each runtime from accepting a different weekly route.
export const WEEKLY_EMPLOYERS_ROUTE_CONFIG = Object.freeze([
  Object.freeze({
    locale: 'it',
    localePrefix: '',
    section: 'aziende-che-assumono',
    currentSlug: 'settimana-corrente',
    archivePrefix: 'settimana',
  }),
  Object.freeze({
    locale: 'en',
    localePrefix: 'en',
    section: 'companies-hiring',
    currentSlug: 'current-week',
    archivePrefix: 'week',
  }),
  Object.freeze({
    locale: 'de',
    localePrefix: 'de',
    section: 'unternehmen-einstellen',
    currentSlug: 'aktuelle-woche',
    archivePrefix: 'woche',
  }),
  Object.freeze({
    locale: 'fr',
    localePrefix: 'fr',
    section: 'entreprises-recrutent',
    currentSlug: 'semaine-courante',
    archivePrefix: 'semaine',
  }),
]);

export const WEEKLY_EMPLOYERS_CITIES = Object.freeze([
  'ticino',
  'lugano',
  'mendrisio',
  'chiasso',
  'stabio',
  'bellinzona',
  'locarno',
]);
