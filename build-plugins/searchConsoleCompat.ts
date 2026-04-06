type SupportedLocale = 'it' | 'en' | 'de' | 'fr';

const JOB_BOARD_SECTION_BY_LOCALE: Record<SupportedLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const JOB_BOARD_PREFIX_BY_LOCALE: Record<SupportedLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const COMPANY_ROUTE_PREFIX_BY_LOCALE: Record<SupportedLocale, string> = {
  it: 'azienda',
  en: 'company',
  de: 'unternehmen',
  fr: 'entreprise',
};

const COMPAT_REDIRECTS: Record<string, string> = {
  '/compara-servizi/undefined': '/compara-servizi/',
  '/fisco-frontaliere/dichiarazione-redditi': '/tasse-e-pensione/',
  '/en/cross-border-articles/communal-elections-ticino-2026/': '/en/cross-border-articles/municipal-elections-ticino/',
  '/fr/articles-frontalier/elections-communales-tessin-2026/': '/fr/articles-frontalier/elections-municipales-tessin/',
  '/vivere-in-ticino/vivere-in-svizzera': '/vivere-in-ticino/',
  // Utility pages not in sitemaps but indexed by Google → redirect to closest section
  '/contattaci': '/chi-siamo/',
  '/en/contact-us': '/en/about-us/',
  '/de/kontakt': '/de/ueber-uns/',
  '/fr/contactez-nous': '/fr/a-propos/',
  '/servizi-partner': '/chi-siamo/',
  '/en/partner-services': '/en/about-us/',
  '/de/partner-dienste': '/de/ueber-uns/',
  '/fr/services-partenaires': '/fr/a-propos/',
  '/consulenza': '/chi-siamo/',
  '/en/consulting': '/en/about-us/',
  '/de/beratung': '/de/ueber-uns/',
  '/fr/consultation': '/fr/a-propos/',
  '/stato-api': '/',
  '/en/api-status': '/en/',
  '/de/api-status': '/de/',
  '/fr/etat-api': '/fr/',
  '/privacy': '/privacy/',
  '/fr/confidentialite': '/fr/confidentialite/',
};

/**
 * Known site sections and their canonical landing pages.
 * Used as a fallback when a 404 path matches a section prefix but isn't
 * handled by the exact-match or job-board pattern resolvers.
 */
const SECTION_FALLBACKS: Array<{ pattern: RegExp; canonical: string; locale: SupportedLocale }> = [
  // Italian sections (no locale prefix)
  { pattern: /^\/vivere-in-ticino\//, canonical: '/vivere-in-ticino/', locale: 'it' },
  { pattern: /^\/compara-servizi\//, canonical: '/compara-servizi/', locale: 'it' },
  { pattern: /^\/articoli-frontaliere\//, canonical: '/articoli-frontaliere/', locale: 'it' },
  { pattern: /^\/guida-frontaliere\//, canonical: '/guida-frontaliere/', locale: 'it' },
  { pattern: /^\/calcola-stipendio\//, canonical: '/calcola-stipendio/', locale: 'it' },
  { pattern: /^\/tasse-e-pensione\//, canonical: '/tasse-e-pensione/', locale: 'it' },
  { pattern: /^\/statistiche\//, canonical: '/statistiche/', locale: 'it' },
  { pattern: /^\/fisco-frontaliere\//, canonical: '/tasse-e-pensione/', locale: 'it' },
  // Localized sections
  { pattern: /^\/en\/cross-border-articles\//, canonical: '/en/cross-border-articles/', locale: 'en' },
  { pattern: /^\/de\/grenzgaenger-artikel\//, canonical: '/de/grenzgaenger-artikel/', locale: 'de' },
  { pattern: /^\/fr\/articles-frontalier\//, canonical: '/fr/articles-frontalier/', locale: 'fr' },
  { pattern: /^\/en\/statistics\//, canonical: '/en/statistics/', locale: 'en' },
  { pattern: /^\/de\/statistiken\//, canonical: '/de/statistiken/', locale: 'de' },
  { pattern: /^\/fr\/statistiques\//, canonical: '/fr/statistiques/', locale: 'fr' },
  { pattern: /^\/en\/living-in-ticino\//, canonical: '/en/living-in-ticino/', locale: 'en' },
  { pattern: /^\/de\/leben-im-tessin\//, canonical: '/de/leben-im-tessin/', locale: 'de' },
  { pattern: /^\/fr\/vivre-au-tessin\//, canonical: '/fr/vivre-au-tessin/', locale: 'fr' },
  { pattern: /^\/en\/calculate-salary\//, canonical: '/en/calculate-salary/', locale: 'en' },
  { pattern: /^\/de\/gehalt-berechnen\//, canonical: '/de/gehalt-berechnen/', locale: 'de' },
  { pattern: /^\/fr\/calculer-salaire\//, canonical: '/fr/calculer-salaire/', locale: 'fr' },
  { pattern: /^\/en\/taxes-and-pension\//, canonical: '/en/taxes-and-pension/', locale: 'en' },
  { pattern: /^\/de\/steuern-und-rente\//, canonical: '/de/steuern-und-rente/', locale: 'de' },
  { pattern: /^\/fr\/impots-et-retraite\//, canonical: '/fr/impots-et-retraite/', locale: 'fr' },
  { pattern: /^\/en\/cross-border-guide\//, canonical: '/en/cross-border-guide/', locale: 'en' },
  { pattern: /^\/de\/grenzgaenger-leitfaden\//, canonical: '/de/grenzgaenger-leitfaden/', locale: 'de' },
  { pattern: /^\/fr\/guide-frontalier\//, canonical: '/fr/guide-frontalier/', locale: 'fr' },
  { pattern: /^\/en\/service-comparison\//, canonical: '/en/service-comparison/', locale: 'en' },
  { pattern: /^\/de\/dienstleistungsvergleich\//, canonical: '/de/dienstleistungsvergleich/', locale: 'de' },
  { pattern: /^\/fr\/comparaison-services\//, canonical: '/fr/comparaison-services/', locale: 'fr' },
];

export type SearchConsoleCompatKind = 'search' | 'expired-job' | 'company' | 'legacy';

export interface SearchConsoleCompatResolution {
  canonicalPath: string;
  kind: SearchConsoleCompatKind;
  locale: SupportedLocale;
}

function normalizePath(input: string): string {
  const clean = `/${String(input || '').trim().replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  if (clean === '/') return clean;
  return clean.replace(/\/$/, '');
}

function inferLocale(path: string): SupportedLocale {
  if (path.startsWith('/en/')) return 'en';
  if (path.startsWith('/de/')) return 'de';
  if (path.startsWith('/fr/')) return 'fr';
  return 'it';
}

function listingPathForLocale(locale: SupportedLocale): string {
  const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
  const section = JOB_BOARD_SECTION_BY_LOCALE[locale];
  return `${prefix}/${section}/`.replace(/\/+/g, '/');
}

export function resolveSearchConsoleCompatTarget(inputPath: string): SearchConsoleCompatResolution | null {
  const path = normalizePath(inputPath);
  const exact = COMPAT_REDIRECTS[path] || COMPAT_REDIRECTS[`${path}/`];
  if (exact) {
    return {
      canonicalPath: exact,
      kind: 'legacy',
      locale: inferLocale(path),
    };
  }

  const locale = inferLocale(path);

  if (/\/(ricerca|search|suche|recherche)-/.test(path)) {
    return {
      canonicalPath: listingPathForLocale(locale),
      kind: 'search',
      locale,
    };
  }

  const companyMatch = path.match(/^\/(?:(en|de|fr)\/)?(find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin|cerca-lavoro-ticino)\/(azienda|company|unternehmen|entreprise)-(.+)$/);
  if (companyMatch) {
    const slug = companyMatch[4];
    return {
      canonicalPath: `${listingPathForLocale(locale)}${COMPANY_ROUTE_PREFIX_BY_LOCALE[locale]}-${slug}/`.replace(/\/+/g, '/'),
      kind: 'company',
      locale,
    };
  }

  const jobBoardSectionPattern = /^\/(?:(en|de|fr)\/)?(find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin|cerca-lavoro-ticino)\/[^/]+\/?$/;
  if (jobBoardSectionPattern.test(path)) {
    return {
      canonicalPath: listingPathForLocale(locale),
      kind: 'expired-job',
      locale,
    };
  }

  // Fallback: match known site sections and redirect to their landing page
  for (const fb of SECTION_FALLBACKS) {
    if (fb.pattern.test(path)) {
      return {
        canonicalPath: fb.canonical,
        kind: 'legacy',
        locale: fb.locale,
      };
    }
  }

  return null;
}

