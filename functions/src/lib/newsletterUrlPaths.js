/**
 * newsletterUrlPaths.js — SINGLE SOURCE of the locale-aware path map + URL
 * helpers shared by the lifecycle email builders (weekly newsletter,
 * onboarding drip, welcome email).
 *
 * Canonical home is functions/src/lib/ (not services/) because the welcome
 * email is built inside a Cloud Function and firebase.json's `source:
 * "functions"` means functions/src/** can only import from within
 * functions/ — no bundler, no reach into the repo-root services/ tree (see
 * functions/src/lib/welcomeEmailTemplate.js's header for the deploy-boundary
 * background). services/newsletter-template.mjs re-exports these so its own
 * importers (the weekly newsletter send, onboarding drip, tests) keep
 * resolving unchanged.
 *
 * IT is the canonical locale (no prefix); en/de/fr get a `/{lang}/` prefix
 * and translated slugs. Keys are the canonical IT paths. This is the UNION
 * of the consumer routes the weekly newsletter links to and the
 * employer-only routes (`/pubblica-offerta`, `/per-le-aziende`,
 * `/i-miei-annunci`) the welcome email's `publisher` segment links to — a
 * superset is safe since every consumer only ever looks up the keys it
 * actually uses (AGENTS.md Non-Negotiable #6: byte-identical entries
 * duplicated in two files must live in one shared module).
 *
 * `directUrl`/`localizedUrl` here return BARE paths (no trailing slash) —
 * services/newsletter-template.mjs and services/newsletter/onboardingDrip.mjs
 * both rely on this (the weekly send leans on an edge 301 to add the
 * slash). This is intentionally NOT the same as
 * functions/src/lib/welcomeEmailTemplate.js's own local `directUrl`/
 * `localizedUrl`, which explicitly append a trailing slash — that file keeps
 * its own differently-behaved helpers and only imports LOCALE_PATH_MAP from
 * here.
 */

const BASE_URL = 'https://frontaliereticino.ch';

export function nlNormLocale(raw) {
  if (!raw) return 'it';
  const lang = String(raw).toLowerCase().split(/[-_]/)[0];
  return ['en', 'de', 'fr'].includes(lang) ? lang : 'it';
}

export function directUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${BASE_URL}${path.startsWith('/') ? path : '/' + path}`;
}

// Locale-aware path map. IT is the canonical (no prefix); other locales get
// the /{lang}/ prefix and translated slugs. Keys are the canonical IT paths.
export const LOCALE_PATH_MAP = {
  '/cerca-lavoro-ticino': {
    it: '/cerca-lavoro-ticino',
    en: '/en/find-jobs-ticino',
    de: '/de/jobs-im-tessin',
    fr: '/fr/trouver-emploi-tessin',
  },
  // Paid 1:1 consulting. Slugs mirror services/routeSlugs.data.ts `consulting`
  // (router.ts:3366 builds `${prefix}/${table.consulting}`); the drift test in
  // tests/route-slugs-no-drift.test.ts asserts the two stay equal, since a
  // Cloud Function cannot import the TypeScript source.
  '/consulenza': {
    it: '/consulenza',
    en: '/en/consulting',
    de: '/de/beratung',
    fr: '/fr/consultation',
  },
  // Switzerland-wide aggregate job board (data/canton-url-slugs.json →
  // aggregate). The weekly newsletter has no per-subscriber canton context
  // (its "total jobs" metric/CTA counts jobs across every canton), so its
  // "browse all jobs" links must resolve here, not to the TI-only board.
  '/cerca-lavoro-svizzera': {
    it: '/cerca-lavoro-svizzera',
    en: '/en/find-jobs-switzerland',
    de: '/de/jobs-in-schweiz',
    fr: '/fr/trouver-emploi-suisse',
  },
  '/compara-servizi/cambio-franco-euro': {
    it: '/compara-servizi/cambio-franco-euro',
    en: '/en/service-comparison/chf-eur-exchange-rate',
    de: '/de/service-vergleich/chf-eur-wechselkurs',
    fr: '/fr/comparaison-services/taux-change-chf-eur',
  },
  '/compara-servizi/confronta-casse-malati': {
    it: '/compara-servizi/confronta-casse-malati',
    en: '/en/service-comparison/compare-health-insurance',
    de: '/de/service-vergleich/krankenkassen-vergleichen',
    fr: '/fr/comparaison-services/comparer-caisses-maladie',
  },
  '/statistiche': {
    it: '/statistiche',
    en: '/en/statistics',
    de: '/de/statistiken',
    fr: '/fr/statistiques',
  },
  '/calcola-stipendio': {
    it: '/calcola-stipendio',
    en: '/en/calculate-salary',
    de: '/de/gehalt-berechnen',
    fr: '/fr/calculer-salaire',
  },
  '/tasse-e-pensione/dichiarazione-redditi': {
    it: '/tasse-e-pensione/dichiarazione-redditi',
    en: '/en/taxes-and-pension/tax-return-guide',
    de: '/de/steuern-und-vorsorge/steuererklaerung',
    fr: '/fr/impots-et-retraite/declaration-revenus',
  },
  // Employer-only routes (services/routeSlugs.data.ts: publish / forEmployers
  // / publisherDashboard) — the weekly newsletter never links to them, only
  // the welcome email's `publisher` segment does.
  '/pubblica-offerta': {
    it: '/pubblica-offerta',
    en: '/en/post-a-job',
    de: '/de/stelle-aufgeben',
    fr: '/fr/publier-une-offre',
  },
  '/per-le-aziende': {
    it: '/per-le-aziende',
    en: '/en/for-employers',
    de: '/de/fuer-unternehmen',
    fr: '/fr/pour-les-entreprises',
  },
  '/i-miei-annunci': {
    it: '/i-miei-annunci',
    en: '/en/my-listings',
    de: '/de/meine-anzeigen',
    fr: '/fr/mes-annonces',
  },
};

/**
 * Resolve a canonical IT path to its locale variant and return an absolute URL.
 * Falls back to the IT path if the path is unknown (still safe, just not localized).
 */
export function localizedUrl(itPath, locale) {
  const lang = nlNormLocale(locale);
  const variants = LOCALE_PATH_MAP[itPath];
  const path = variants ? (variants[lang] || variants.it) : itPath;
  return directUrl(path);
}
